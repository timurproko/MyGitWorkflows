import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupWorktrees, formatReport, parseWorktrees } from "../scripts/worktree-cleanup.mjs";

const run = promisify(execFile);
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function git(cwd: string, ...args: string[]) {
  return (await run("git", ["-c", "user.name=Test", "-c", "user.email=test@example.test", "-c", "commit.gpgsign=false", ...args], { cwd })).stdout.trim();
}

/** A primary checkout with one linked worktree per name, each holding one committed file. */
async function repository(...names: string[]) {
  const root = realpathSync.native(await mkdtemp(join(tmpdir(), "delivery-cleanup-")));
  roots.push(root);
  const primary = join(root, "primary");
  await mkdir(primary);
  await git(primary, "init", "--quiet", "--initial-branch=main");
  await writeFile(join(primary, ".gitignore"), ".artifacts/\nprivate/\nlinked\n");
  await git(primary, "add", "-A");
  await git(primary, "commit", "--quiet", "-m", "initial");
  const worktrees: Record<string, { path: string; head: string }> = {};
  for (const name of names) {
    const path = join(primary, ".worktrees", name);
    await git(primary, "worktree", "add", "--quiet", "-b", `feat/${name}`, path);
    await writeFile(join(path, `${name}.txt`), name);
    await git(path, "add", "-A");
    await git(path, "commit", "--quiet", "-m", name);
    worktrees[name] = { path, head: await git(path, "rev-parse", "HEAD") };
  }
  return { primary, worktrees };
}

const merged = (heads: Record<string, string>) => async (_cwd: string, branch: string) =>
  heads[branch] ? { number: 7, head: heads[branch] } : null;

describe("worktree cleanup", () => {
  it("reports without deleting, then removes a merged clean worktree and its branch", async () => {
    const { primary, worktrees } = await repository("done");
    const findMergedPull = merged({ "feat/done": worktrees.done.head });
    const preview = await cleanupWorktrees({ cwd: primary, findMergedPull });
    expect(preview.results).toMatchObject([{ action: "remove", reason: "pull request #7 merged" }]);
    expect(formatReport(preview)).toContain("would remove");
    expect(formatReport(preview)).toContain("--apply");
    expect(existsSync(worktrees.done.path)).toBe(true);

    const applied = await cleanupWorktrees({ cwd: primary, apply: true, findMergedPull });
    expect(applied.results).toMatchObject([{ action: "remove", removed: true }]);
    expect(existsSync(worktrees.done.path)).toBe(false);
    expect(await git(primary, "branch", "--list", "feat/done")).toBe("");
    expect(parseWorktrees(await git(primary, "worktree", "list", "--porcelain"))).toHaveLength(1);
  });

  it("keeps work that is unmerged, dirty, untracked or ahead of the merged head", async () => {
    const { primary, worktrees } = await repository("open", "dirty", "untracked", "ahead");
    await writeFile(join(worktrees.dirty.path, "dirty.txt"), "changed");
    await writeFile(join(worktrees.untracked.path, "new.txt"), "new");
    const aheadMerged = worktrees.ahead.head;
    await writeFile(join(worktrees.ahead.path, "later.txt"), "later");
    await git(worktrees.ahead.path, "add", "-A");
    await git(worktrees.ahead.path, "commit", "--quiet", "-m", "later");
    const report = await cleanupWorktrees({ cwd: primary, apply: true, findMergedPull: merged({
      "feat/dirty": worktrees.dirty.head, "feat/untracked": worktrees.untracked.head, "feat/ahead": aheadMerged }) });
    const reasons = Object.fromEntries(report.results.map(result => [result.branch, result.reason]));
    expect(report.results.every(result => result.action === "keep")).toBe(true);
    expect(reasons["feat/open"]).toBe("no merged pull request for this branch");
    expect(reasons["feat/dirty"]).toBe("uncommitted or untracked files");
    expect(reasons["feat/untracked"]).toBe("uncommitted or untracked files");
    expect(reasons["feat/ahead"]).toBe("has commits that pull request #7 did not merge");
    for (const { path } of Object.values(worktrees)) expect(existsSync(path)).toBe(true);
  });

  it("keeps a worktree marked to keep or holding a separate repository, even when Git sees it clean", async () => {
    const { primary, worktrees } = await repository("marked", "nested");
    await mkdir(join(worktrees.marked.path, ".artifacts"));
    await writeFile(join(worktrees.marked.path, ".artifacts", "KEEP"), "");
    await mkdir(join(worktrees.nested.path, "private"));
    await git(join(worktrees.nested.path, "private"), "init", "--quiet");
    const report = await cleanupWorktrees({ cwd: primary, apply: true,
      findMergedPull: merged({ "feat/marked": worktrees.marked.head, "feat/nested": worktrees.nested.head }) });
    expect(report.results.map(result => result.reason)).toEqual([
      "marked to keep by .artifacts/KEEP", "holds a separate Git repository at private"]);
    expect(existsSync(worktrees.marked.path) && existsSync(worktrees.nested.path)).toBe(true);
  });

  it("never removes the worktree it runs in and never follows a link out of a removed one", async () => {
    const { primary, worktrees } = await repository("current", "linked");
    const shared = join(primary, "..", "shared");
    await mkdir(shared);
    await writeFile(join(shared, "data.txt"), "shared");
    await symlink(shared, join(worktrees.linked.path, "linked"), "junction");
    const findMergedPull = merged({ "feat/current": worktrees.current.head, "feat/linked": worktrees.linked.head });
    const report = await cleanupWorktrees({ cwd: worktrees.current.path, apply: true, findMergedPull });
    expect(report.results).toMatchObject([
      { branch: "feat/current", action: "keep", reason: "the command is running inside this worktree" },
      { branch: "feat/linked", action: "remove", removed: true }]);
    expect(existsSync(worktrees.linked.path)).toBe(false);
    expect(existsSync(join(shared, "data.txt"))).toBe(true);
  });

  it("limits the pass to one named worktree", async () => {
    const { primary, worktrees } = await repository("one", "two");
    const report = await cleanupWorktrees({ cwd: primary, only: worktrees.two.path,
      findMergedPull: merged({ "feat/one": worktrees.one.head, "feat/two": worktrees.two.head }) });
    expect(report.results.map(result => result.branch)).toEqual(["feat/two"]);
  });
});
