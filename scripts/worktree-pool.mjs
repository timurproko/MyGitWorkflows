import { execFile } from "node:child_process";
import { mkdir, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { managedRoot } from "./managed-copy.mjs";
import { canonical, defaultGit, parseWorktrees, poolSlots, samePath } from "./worktree-cleanup.mjs";

const run = promisify(execFile);
const BRANCH = /^(feature|fix|refactor|docs|test|chore|style)\/([a-z0-9][a-z0-9._-]*)$/;
const NAME = /^[a-z0-9][a-z0-9._-]*$/;

/**
 * Pooled worktrees: on a machine with treehouse installed, a task's checkout is a slot leased from
 * its pool instead of a new folder, so dependencies and caches survive from one task to the next.
 *
 * Installing treehouse is the choice to use it. The machine's settings file can turn it off
 * without uninstalling; it is the only switch, read on every run, so there is one answer for every
 * tool on the machine. A machine without treehouse always uses plain worktrees.
 */
// Rationale: the setting lives in the shared workflow's own folder, as a file Git ignores, so the
// machine gets no second folder for one value and the managed copy still fast-forwards cleanly.
export const SETTINGS_FILE = join(managedRoot(), "settings.local.json");
/** Where the setting was kept for a short time; a file found there is moved once. */
export const LEGACY_SETTINGS_FILE = join(homedir(), ".config", "delivery", "settings.json");
const legacyOf = file => (file === SETTINGS_FILE ? LEGACY_SETTINGS_FILE : null);

/** Move a settings file from its earlier place, unless the new place already has one. Never fails a command. */
export async function adoptLegacySettings(file = SETTINGS_FILE, legacy = legacyOf(file)) {
  if (!legacy) return;
  try {
    await readFile(legacy, "utf8");
    try { await readFile(file, "utf8"); } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await mkdir(dirname(file), { recursive: true });
      await rename(legacy, file);
    }
    await rm(legacy, { force: true });
    await rmdir(dirname(legacy));
  } catch { /* nothing to move, or its folder holds other files and stays */ }
}

async function readSettings(file) {
  await adoptLegacySettings(file);
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
 * slot when pooling is active, else `.worktrees/<name>` in the primary checkout. Either way it is
 * cut from the latest state of `origin`, never from a stale local branch: the default branch, or
 * `base` when one is named. A repository without `origin` is cut from its own branch instead.
 *
 * `detach` names a checkout without a branch, for reading only (an investigation, a review).
 */
export async function startWorktree({ cwd = process.cwd(), branch = null, detach = null, base = null,
  git = defaultGit, pool = defaultPool, file = SETTINGS_FILE } = {}) {
  if (branch && detach) throw new Error("name a branch or a checkout without one, not both");
  const name = detach ? NAME.exec(detach)?.[0] : BRANCH.exec(branch ?? "")?.[2];
  if (!name) throw new Error(detach ? "name the checkout with lowercase letters, digits, dots and dashes"
    : "name the branch as type/short-description, with type feature, fix, refactor, docs, test, chore or style");
  const worktrees = parseWorktrees(await git(cwd, ["worktree", "list", "--porcelain"]));
  const primary = worktrees[0];
  if (!primary) throw new Error("not inside a Git repository");
  const plainPath = join(primary.path, ".worktrees", name);
  const plainReal = await canonical(plainPath);
  const linked = [];
  for (const worktree of worktrees.slice(1)) linked.push({ ...worktree, real: await canonical(worktree.path) });
  // Invariant: a branch is found wherever its checkout is; a checkout without one only by its plain folder.
  const existing = linked.find(worktree => (branch ? worktree.branch === branch : samePath(worktree.real, plainReal)));
  if (existing) {
    const pooled = (await poolSlots(pool, [primary, existing])).some(slot => samePath(slot.path, existing.real));
    return { path: existing.path, branch, created: false, pooled };
  }

  const hasBranch = Boolean(branch) && await succeeds(git, primary.path, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
  if ((await poolState({ file, pool })).active) {
    // Rationale: treehouse fetches origin itself and cuts the slot from the default branch, or from `base`.
    const path = await pool.lease(primary.path, { branch: hasBranch ? null : branch, base });
    if (hasBranch) await git(path, ["checkout", "--quiet", branch]);
    return { path, branch, created: true, pooled: true };
  }
  if (hasBranch) await git(primary.path, ["worktree", "add", "--quiet", plainPath, branch]);
  else {
    const from = await startingPoint(git, primary.path, base);
    await git(primary.path, ["worktree", "add", "--quiet", ...(branch ? ["--no-track", "-b", branch] : ["--detach"]), plainPath, from]);
  }
  return { path: plainPath, branch, created: true, pooled: false };
}

/** The commit a new checkout starts from: freshly fetched from `origin`, or local when there is no `origin`. */
async function startingPoint(git, primary, base) {
  if (!await succeeds(git, primary, ["remote", "get-url", "origin"])) {
    return base ?? ((await git(primary, ["rev-parse", "--abbrev-ref", "HEAD"])).trim() || "HEAD");
  }
  const name = base ?? await defaultBranch(git, primary);
  await git(primary, ["fetch", "--quiet", "origin", name]);
  return `origin/${name}`;
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
  async lease(cwd, { branch = null, base = null } = {}) {
    const { stdout } = await treehouse(cwd, ["get", "--lease", "--json", ...(branch ? ["-b", branch] : []), ...(base ? ["--base", base] : [])]);
    const path = JSON.parse(stdout).path;
    if (!path) throw new Error("treehouse gave no slot");
    return path;
  },
  async giveBack(path, { force = false } = {}) {
    await treehouse(path, ["return", ...(force ? ["--force"] : []), path]);
  },
};
