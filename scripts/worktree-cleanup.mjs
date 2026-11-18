import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { lstat, readdir, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const KEEP_MARKER = join(".artifacts", "KEEP");
const NESTED_SCAN_DEPTH = 2;
const SKIPPED_DIRECTORIES = new Set(["node_modules", ".git"]);

/**
 * Local cleanup after delivery, for any agent and any repository.
 *
 * A linked worktree and its local branch are removed only when the branch's pull request merged,
 * the checkout holds nothing that pull request does not, and nothing in it is marked to keep.
 * Everything else is kept and reported with the reason, so a blocker is never worked around.
 * Without `apply` nothing is deleted: the report says what would happen.
 */
export async function cleanupWorktrees({ cwd = process.cwd(), apply = false, only = null,
  git = defaultGit, findMergedPull = defaultFindMergedPull, remove = defaultRemove } = {}) {
  const worktrees = parseWorktrees(await git(cwd, ["worktree", "list", "--porcelain"]));
  const primary = worktrees[0];
  if (!primary) throw new Error("not inside a Git repository");
  const here = await canonical(cwd);
  const results = [];
  for (const worktree of worktrees.slice(1)) {
    if (only && !samePath(await canonical(worktree.path), await canonical(resolve(cwd, only)))) continue;
    const decision = await inspectWorktree({ worktree, primary, here, git, findMergedPull });
    if (decision.action === "remove" && apply) {
      try {
        await remove(worktree.path);
        await git(primary.path, ["worktree", "prune"]);
        await git(primary.path, ["branch", "-D", worktree.branch]);
        decision.removed = true;
      } catch (error) {
        decision.action = "keep";
        decision.reason = `removal failed: ${firstLine(error)}`;
      }
    }
    results.push({ path: worktree.path, branch: worktree.branch ?? null, ...decision });
  }
  return { primary: primary.path, apply, results };
}

/** Decide one worktree. Every refusal names the fact that blocked it. */
export async function inspectWorktree({ worktree, primary, here, git, findMergedPull }) {
  const keep = reason => ({ action: "keep", reason });
  if (worktree.bare || worktree.detached || !worktree.branch) return keep("no branch is checked out");
  if (worktree.locked) return keep("the worktree is locked");
  if (worktree.prunable) return keep("the worktree folder is missing; `git worktree prune` clears the record");
  const root = await canonical(worktree.path);
  if (here === root || here.startsWith(root + sep)) return keep("the command is running inside this worktree");
  if ((await git(worktree.path, ["status", "--porcelain", "--untracked-files=all"])).trim()) {
    return keep("uncommitted or untracked files");
  }
  if (await exists(join(worktree.path, KEEP_MARKER))) return keep(`marked to keep by ${KEEP_MARKER.replaceAll("\\", "/")}`);
  const nested = await findNestedRepository(worktree.path);
  if (nested) return keep(`holds a separate Git repository at ${nested.replaceAll("\\", "/")}`);

  const pull = await findMergedPull(primary.path, worktree.branch);
  if (!pull) return keep("no merged pull request for this branch");
  const head = (await git(worktree.path, ["rev-parse", "HEAD"])).trim();
  if (head !== pull.head) {
    const merged = await contains(git, primary.path, pull, head);
    if (merged === null) return keep(`could not compare with pull request #${pull.number}; run cleanup again`);
    if (!merged) return keep(`has commits that pull request #${pull.number} did not merge`);
  }
  return { action: "remove", reason: `pull request #${pull.number} merged`, pull: pull.number };
}

/** Parse `git worktree list --porcelain`; the first entry is the primary checkout. */
export function parseWorktrees(output) {
  const worktrees = [];
  for (const block of output.split(/\r?\n\r?\n/)) {
    const entry = {};
    for (const line of block.split(/\r?\n/)) {
      const [key, ...rest] = line.split(" ");
      const value = rest.join(" ");
      if (key === "worktree") entry.path = resolve(value);
      else if (key === "branch") entry.branch = value.replace(/^refs\/heads\//, "");
      else if (["bare", "detached", "locked", "prunable"].includes(key)) entry[key] = true;
    }
    if (entry.path) worktrees.push(entry);
  }
  return worktrees;
}

export function formatReport(report) {
  if (report.results.length === 0) return "No linked worktrees.";
  const verb = result => result.action === "keep" ? "keep  " : result.removed ? "removed" : "would remove";
  const lines = report.results.map(result => `${verb(result)} ${result.path} (${result.branch ?? "no branch"}): ${result.reason}`);
  const pending = report.results.some(result => result.action === "remove" && !result.removed);
  return [...lines, ...(pending ? ["Nothing was deleted. Run again with --apply to remove the worktrees listed as `would remove`."] : [])].join("\n");
}

// Rationale: the remote branch is usually deleted after a merge, so the merged head is fetched by its pull-request ref.
async function contains(git, primary, pull, head) {
  try { await git(primary, ["fetch", "--quiet", "origin", `refs/pull/${pull.number}/head`]); } catch { /* the merged head may already be local */ }
  try {
    await git(primary, ["merge-base", "--is-ancestor", head, pull.head]);
    return true;
  } catch (error) {
    // Invariant: only exit code 1 of merge-base means "not an ancestor"; a missing merged head or a busy repository is unknown.
    return error?.code === 1 ? false : null;
  }
}

async function findNestedRepository(root, relative = "", depth = 0) {
  let entries;
  try { entries = await readdir(join(root, relative), { withFileTypes: true }); } catch { return null; }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || SKIPPED_DIRECTORIES.has(entry.name)) continue;
    const child = join(relative, entry.name);
    if (await exists(join(root, child, ".git"))) return child;
    if (depth + 1 < NESTED_SCAN_DEPTH) {
      const found = await findNestedRepository(root, child, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

async function defaultGit(cwd, args) {
  return (await run("git", args, { cwd, windowsHide: true, maxBuffer: 16 * 1024 * 1024 })).stdout;
}

async function defaultFindMergedPull(cwd, branch) {
  const { stdout } = await run("gh", ["pr", "list", "--head", branch, "--state", "merged", "--limit", "1",
    "--json", "number,headRefOid"], { cwd, windowsHide: true });
  const [pull] = JSON.parse(stdout);
  return pull ? { number: pull.number, head: pull.headRefOid } : null;
}

// Rationale: Node removes a junction or symlink as a link, so shared folders linked into a worktree survive.
async function defaultRemove(path) {
  await rm(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
}

async function exists(path) {
  try { await lstat(path); return true; } catch { return false; }
}

async function canonical(path) {
  try { return realpathSync.native(path); } catch { return resolve(path); }
}

function samePath(left, right) {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function firstLine(error) {
  return String(error?.stderr || error?.message || error).trim().split(/\r?\n/)[0];
}
