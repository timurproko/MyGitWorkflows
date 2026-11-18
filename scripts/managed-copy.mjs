import { execFile } from "node:child_process";
import { rm, stat, utimes } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
export const SOURCE_URL = "https://github.com/timurproko/MyGitWorkflows.git";
const UPDATE_INTERVAL_MS = 60 * 60 * 1000;
const STAMP = "FETCH_HEAD";

/** The one place every agent and command on a machine reads the shared workflow from. */
export function managedRoot(home = homedir()) {
  return join(home, ".workflow");
}

/** Where earlier versions kept the managed copy. */
export function legacyRoot(home = homedir()) {
  return join(home, ".config", "git-workflows");
}

/** Remove the earlier location once nothing points at it. Returns a report line, or `null` when there was none. */
export async function removeLegacyCopy({ home = homedir() } = {}) {
  const legacy = legacyRoot(home);
  if (!await stat(legacy).catch(() => null)) return null;
  try {
    await rm(legacy, { recursive: true, force: true, maxRetries: 3 });
    return `removed the earlier copy ${legacy}`;
  } catch (error) {
    return `could not remove the earlier copy ${legacy} (${error.code ?? error.message}); delete it by hand`;
  }
}

/** The checkout this file runs from. */
export function currentRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

const same = (left, right) => resolve(left).toLowerCase() === resolve(right).toLowerCase();

/** Clone the managed copy when it is missing, otherwise fast-forward it. Returns one report line. */
export async function ensureManagedCopy({ home = homedir(), url = SOURCE_URL, git = defaultGit } = {}) {
  const root = managedRoot(home);
  if (await stat(join(root, ".git")).catch(() => null)) {
    await synchronize(git, root);
    return `updated ${root}`;
  }
  await git(dirname(root), ["clone", "--quiet", url, root]);
  return `downloaded ${root}`;
}

/**
 * Keep the managed copy current without slowing every command: fast-forward it at most once an hour,
 * only when this process runs from it. A development clone is never touched, and a failure (offline,
 * no access) is reported in one line and never blocks the command. Local edits in the managed copy are discarded.
 */
export async function refreshManagedCopy({ home = homedir(), root = currentRoot(), now = Date.now(), force = false, git = defaultGit } = {}) {
  if (!same(root, managedRoot(home))) return force ? "not the managed copy; nothing to update" : null;
  const stamp = join(root, ".git", STAMP);
  const last = (await stat(stamp).catch(() => null))?.mtimeMs ?? 0;
  if (!force && now - last < UPDATE_INTERVAL_MS) return null;
  try {
    const before = (await git(root, ["rev-parse", "HEAD"])).trim();
    await synchronize(git, root);
    // Rationale: a fetch that brings nothing may leave the stamp untouched, which would retry on every command.
    await utimes(stamp, new Date(now), new Date(now)).catch(() => {});
    const after = (await git(root, ["rev-parse", "HEAD"])).trim();
    return before === after ? (force ? "already up to date" : null) : `shared workflow updated to ${after.slice(0, 7)}`;
  } catch (error) {
    return `shared workflow not updated: ${String(error.stderr ?? error.message).trim().split("\n")[0]}`;
  }
}

// Invariant: the managed copy is a mirror, never a place to edit, so it is reset to its upstream. A tool that
// touches a file there (npm rewrites line endings of command files on Windows) must not block the next update.
async function synchronize(git, root) {
  await git(root, ["fetch", "--quiet", "origin"]);
  await git(root, ["reset", "--hard", "--quiet", "@{upstream}"]);
}

async function defaultGit(cwd, args) {
  return (await run("git", args, { cwd, windowsHide: true, timeout: 60_000 })).stdout;
}
