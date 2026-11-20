import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { canonical, defaultGit, parseWorktrees, poolSlots, samePath } from "./worktree-cleanup.mjs";

const run = promisify(execFile);
const BRANCH = /^(feature|fix|refactor|docs|test|chore|style)\/([a-z0-9][a-z0-9._-]*)$/;

/**
 * Pooled worktrees: on a machine with treehouse installed, a task's checkout is a slot leased from
 * its pool instead of a new folder, so dependencies and caches survive from one task to the next.
 *
 * Installing treehouse is the choice to use it. The machine's settings file can turn it off
 * without uninstalling; it is the only switch, read on every run, so there is one answer for every
 * tool on the machine. A machine without treehouse always uses plain worktrees.
 */
export const SETTINGS_FILE = join(homedir(), ".config", "delivery", "settings.json");

async function readSettings(file) {
  let text;
  try { text = await readFile(file, "utf8"); } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
  let settings;
  try { settings = JSON.parse(text); } catch { throw new Error(`${file} is not valid JSON`); }
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new Error(`${file} must hold a JSON object`);
  return settings;
}

/** Invariant: only an explicit `false` turns pooling off, so installing treehouse is enough to turn it on. */
export async function readPoolSetting(file = SETTINGS_FILE) {
  return (await readSettings(file)).pooledWorktrees !== false;
}

export async function writePoolSetting(enabled, file = SETTINGS_FILE) {
  const settings = { ...await readSettings(file), pooledWorktrees: Boolean(enabled) };
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(settings, null, 2)}\n`);
}

/** `active` is what decides: the setting is on and treehouse is there to serve it. */
export async function poolState({ file = SETTINGS_FILE, pool = defaultPool } = {}) {
  const [enabled, version] = [await readPoolSetting(file), await pool.version()];
  return { enabled, installed: Boolean(version), version, active: enabled && Boolean(version) };
}

export function formatPool(state) {
  if (!state.installed) return `pooled worktrees: ${state.enabled ? "on" : "off"}; treehouse is not installed, so plain worktrees are used`;
  return `pooled worktrees: ${state.enabled ? "on" : "off"} (treehouse ${state.version}); tasks get ${state.active ? "a slot from the treehouse pool" : "a plain worktree"}`;
}

/**
 * Start, or return to, the checkout of one task and say where it is.
 *
 * A branch that already has a worktree is continued there. Otherwise the checkout is a leased pool
 * slot when pooling is active, else `.worktrees/<name>` in the primary checkout. Either way the
 * branch is cut from the latest default branch of `origin`, never from a stale local one.
 */
export async function startWorktree({ cwd = process.cwd(), branch, git = defaultGit, pool = defaultPool, file = SETTINGS_FILE } = {}) {
  const name = BRANCH.exec(branch ?? "")?.[2];
  if (!name) throw new Error("name the branch as type/short-description, with type feature, fix, refactor, docs, test, chore or style");
  const worktrees = parseWorktrees(await git(cwd, ["worktree", "list", "--porcelain"]));
  const primary = worktrees[0];
  if (!primary) throw new Error("not inside a Git repository");
  const existing = worktrees.slice(1).find(worktree => worktree.branch === branch);
  if (existing) {
    const real = await canonical(existing.path);
    const pooled = (await poolSlots(pool, [primary, existing])).some(slot => samePath(slot.path, real));
    return { path: existing.path, branch, created: false, pooled };
  }

  const hasBranch = await succeeds(git, primary.path, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
  if ((await poolState({ file, pool })).active) {
    // Rationale: treehouse fetches origin itself and cuts the slot from its default branch.
    const path = await pool.lease(primary.path, hasBranch ? null : branch);
    if (hasBranch) await git(path, ["checkout", "--quiet", branch]);
    return { path, branch, created: true, pooled: true };
  }
  const path = join(primary.path, ".worktrees", name);
  if (hasBranch) await git(primary.path, ["worktree", "add", "--quiet", path, branch]);
  else {
    const base = await defaultBranch(git, primary.path);
    await git(primary.path, ["fetch", "--quiet", "origin", base]);
    await git(primary.path, ["worktree", "add", "--quiet", "-b", branch, path, `origin/${base}`]);
  }
  return { path, branch, created: true, pooled: false };
}

async function defaultBranch(git, primary) {
  const read = async () => (await git(primary, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"])).trim().replace(/^origin\//, "");
  try { return await read(); } catch { /* not recorded in this clone yet */ }
  try { await git(primary, ["remote", "set-head", "origin", "--auto"]); return await read(); } catch {
    throw new Error("could not tell the default branch of origin; `git remote set-head origin --auto` records it");
  }
}

async function succeeds(git, cwd, args) {
  try { await git(cwd, args); return true; } catch { return false; }
}

const treehouse = (cwd, args) => run("treehouse", args, { cwd, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });

/** The pool as the delivery commands use it. Tests pass their own; this one asks treehouse. */
export const defaultPool = {
  async version() {
    try { return (await treehouse(process.cwd(), ["--version"])).stdout.trim().split(/\s+/).at(-1) || null; } catch { return null; }
  },
  // Invariant: no treehouse, or a repository without a pool, means no slots; plain worktrees stay plain.
  async slots(cwd) {
    try {
      const listed = JSON.parse((await treehouse(cwd, ["status", "--json"])).stdout);
      return await Promise.all((Array.isArray(listed) ? listed : []).map(async slot => ({ ...slot, path: await canonical(slot.path) })));
    } catch { return []; }
  },
  async lease(cwd, branch) {
    const { stdout } = await treehouse(cwd, ["get", "--lease", "--json", ...(branch ? ["-b", branch] : [])]);
    const path = JSON.parse(stdout).path;
    if (!path) throw new Error("treehouse gave no slot");
    return path;
  },
  async giveBack(path, { force = false } = {}) {
    await treehouse(path, ["return", ...(force ? ["--force"] : []), path]);
  },
};
