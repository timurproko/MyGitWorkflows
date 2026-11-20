import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupWorktrees, finishWorktree, formatFinish, formatReport, parseWorktrees } from "../scripts/worktree-cleanup.mjs";

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

describe("finish", () => {
  it("removes one merged worktree and its branch, named by folder, branch or path", async () => {
    const { primary, worktrees } = await repository("one", "two", "three", "other");
    const findMergedPull = merged({ "feat/one": worktrees.one.head, "feat/two": worktrees.two.head,
      "feat/three": worktrees.three.head, "feat/other": worktrees.other.head });
    for (const [name, target] of [["one", "one"], ["two", "feat/two"], ["three", worktrees.three.path]]) {
      const result = await finishWorktree({ cwd: primary, target, findMergedPull });
      expect(result).toMatchObject({ removed: true, branchRemoved: true, forced: false });
      expect(formatFinish(result)).toContain("pull request #7 merged; worktree removed, branch deleted");
      expect(existsSync(worktrees[name].path)).toBe(false);
      expect(await git(primary, "branch", "--list", `feat/${name}`)).toBe("");
    }
    expect(existsSync(worktrees.other.path)).toBe(true);
    await expect(finishWorktree({ cwd: primary, target: "missing", findMergedPull })).rejects.toThrow("no linked worktree matches missing");
  });

  it("keeps what cleanup keeps and says that --force would discard it", async () => {
    const { primary, worktrees } = await repository("dirty", "open");
    await writeFile(join(worktrees.dirty.path, "dirty.txt"), "changed");
    const findMergedPull = merged({ "feat/dirty": worktrees.dirty.head });
    const dirty = await finishWorktree({ cwd: primary, target: "dirty", findMergedPull });
    expect(dirty).toMatchObject({ removed: false, reason: "uncommitted or untracked files", forceable: true });
    expect(formatFinish(dirty)).toContain("Nothing was removed.");
    expect(formatFinish(dirty)).toContain("--force");
    const open = await finishWorktree({ cwd: primary, target: "open", findMergedPull });
    expect(open).toMatchObject({ removed: false, reason: "no merged pull request for this branch", forceable: true });
    expect(existsSync(worktrees.dirty.path) && existsSync(worktrees.open.path)).toBe(true);
  });

  it("with force discards files but never commits that are not merged", async () => {
    const { primary, worktrees } = await repository("dirty", "marked", "open", "ahead");
    await writeFile(join(worktrees.dirty.path, "dirty.txt"), "changed");
    await mkdir(join(worktrees.marked.path, ".artifacts"));
    await writeFile(join(worktrees.marked.path, ".artifacts", "KEEP"), "");
    const aheadMerged = worktrees.ahead.head;
    await writeFile(join(worktrees.ahead.path, "later.txt"), "later");
    await git(worktrees.ahead.path, "add", "-A");
    await git(worktrees.ahead.path, "commit", "--quiet", "-m", "later");
    const findMergedPull = merged({ "feat/dirty": worktrees.dirty.head, "feat/marked": worktrees.marked.head, "feat/ahead": aheadMerged });

    for (const name of ["dirty", "marked"]) {
      const result = await finishWorktree({ cwd: primary, target: name, force: true, findMergedPull });
      expect(result).toMatchObject({ removed: true, branchRemoved: true, forced: true });
      expect(existsSync(worktrees[name].path)).toBe(false);
      expect(await git(primary, "branch", "--list", `feat/${name}`)).toBe("");
    }
    for (const name of ["open", "ahead"]) {
      const result = await finishWorktree({ cwd: primary, target: name, force: true, findMergedPull });
      expect(result).toMatchObject({ removed: true, branchRemoved: false, forced: true });
      expect(formatFinish(result)).toContain(`branch feat/${name} kept, its commits are not in a merged pull request`);
      expect(existsSync(worktrees[name].path)).toBe(false);
      expect(await git(primary, "branch", "--list", `feat/${name}`)).toContain(`feat/${name}`);
    }
  });

  it("never forces a lock, a separate repository or the worktree it runs in", async () => {
    const { primary, worktrees } = await repository("locked", "nested", "current");
    await git(primary, "worktree", "lock", worktrees.locked.path);
    await mkdir(join(worktrees.nested.path, "private"));
    await git(join(worktrees.nested.path, "private"), "init", "--quiet");
    const findMergedPull = merged({ "feat/locked": worktrees.locked.head, "feat/nested": worktrees.nested.head, "feat/current": worktrees.current.head });
    const reasons: Record<string, string> = { locked: "the worktree is locked", nested: "holds a separate Git repository at private",
      current: "the command is running inside this worktree" };
    for (const [name, reason] of Object.entries(reasons)) {
      const cwd = name === "current" ? worktrees.current.path : primary;
      const result = await finishWorktree({ cwd, target: worktrees[name].path, force: true, findMergedPull });
      expect(result).toMatchObject({ removed: false, reason, forceable: false });
      expect(formatFinish(result)).not.toContain("--force");
      expect(existsSync(worktrees[name].path)).toBe(true);
    }
  });
});
