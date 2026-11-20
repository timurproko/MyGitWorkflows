import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupWorktrees, finishWorktree, formatFinish, formatReport } from "../scripts/worktree-cleanup.mjs";
import { formatPool, poolState, readPoolSetting, startWorktree, writePoolSetting } from "../scripts/worktree-pool.mjs";

const run = promisify(execFile);
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function git(cwd: string, ...args: string[]) {
  return (await run("git", ["-c", "user.name=Test", "-c", "user.email=test@example.test", "-c", "commit.gpgsign=false", ...args], { cwd })).stdout.trim();
}

/** A published repository and a clone of it; the clone's main is one commit behind what is published. */
async function repository() {
  const root = realpathSync.native(await mkdtemp(join(tmpdir(), "delivery-pool-")));
  roots.push(root);
  const origin = join(root, "origin.git"), primary = join(root, "primary"), other = join(root, "other");
  await git(root, "init", "--quiet", "--bare", "--initial-branch=main", origin);
  await git(root, "clone", "--quiet", origin, primary);
  await writeFile(join(primary, ".gitignore"), ".artifacts/\n.worktrees/\nnode_modules/\n");
  await git(primary, "add", "-A");
  await git(primary, "commit", "--quiet", "-m", "initial");
  await git(primary, "push", "--quiet", "origin", "HEAD:main");
  await git(primary, "remote", "set-head", "origin", "main");
  await git(root, "clone", "--quiet", origin, other);
  await writeFile(join(other, "newer.txt"), "newer");
  await git(other, "add", "-A");
  await git(other, "commit", "--quiet", "-m", "newer");
  await git(other, "push", "--quiet", "origin", "HEAD:main");
  return { root, primary, published: await git(other, "rev-parse", "HEAD"), settings: join(root, "settings", "settings.json") };
}

/** A pool like treehouse's: numbered slots outside the repository that are handed out, taken back and kept. */
function fakePool(root: string, { version = "v3.1.8" as string | null } = {}) {
  const slots: { name: string; path: string; status: string }[] = [];
  const log: string[] = [];
  return { slots: async () => slots.map(slot => ({ ...slot })), log,
    version: async () => version,
    async lease(cwd: string, branch: string | null) {
      await git(cwd, "fetch", "--quiet", "origin", "main");
      let slot = slots.find(candidate => candidate.status === "available");
      if (slot) {
        await git(slot.path, "checkout", "--quiet", "--detach", "origin/main");
        if (branch) await git(slot.path, "checkout", "--quiet", "-b", branch);
      } else {
        slot = { name: String(slots.length + 1), path: join(root, "pool", String(slots.length + 1), "primary"), status: "" };
        await git(cwd, "worktree", "add", "--quiet", ...(branch ? ["-b", branch] : ["--detach"]), slot.path, "origin/main");
        slots.push(slot);
      }
      slot.status = "leased";
      log.push(`lease ${slot.name}`);
      return slot.path;
    },
    async giveBack(path: string, { force = false } = {}) {
      const slot = slots.find(candidate => candidate.path === path)!;
      const dirty = await git(path, "status", "--porcelain");
      if (dirty && !force) throw new Error("worktree not returned: it has uncommitted changes");
      if (dirty) { await git(path, "reset", "--quiet", "--hard"); await git(path, "clean", "--quiet", "-fd"); }
      await git(path, "checkout", "--quiet", "--detach");
      slot.status = "available";
      log.push(`return ${slot.name}${force ? " --force" : ""}`);
    } };
}

const merged = (heads: Record<string, string>) => async (_cwd: string, branch: string) =>
  heads[branch] ? { number: 7, head: heads[branch] } : null;

describe("pooled worktrees setting", () => {
  it("is on until the machine's file says off, and needs treehouse to take effect", async () => {
    const { root, settings } = await repository();
    expect(await readPoolSetting(settings)).toBe(true);
    expect(await poolState({ file: settings, pool: fakePool(root) })).toEqual({ enabled: true, installed: true, version: "v3.1.8", active: true });
    expect(await poolState({ file: settings, pool: fakePool(root, { version: null }) })).toMatchObject({ enabled: true, installed: false, active: false });

    await writePoolSetting(false, settings);
    expect(JSON.parse(await readFile(settings, "utf8"))).toEqual({ pooledWorktrees: false });
    const off = await poolState({ file: settings, pool: fakePool(root) });
    expect(off).toMatchObject({ enabled: false, installed: true, active: false });
    expect(formatPool(off)).toContain("off (treehouse v3.1.8); tasks get a plain worktree");

    await writeFile(settings, JSON.stringify({ other: 1, pooledWorktrees: false }));
    await writePoolSetting(true, settings);
    expect(JSON.parse(await readFile(settings, "utf8"))).toEqual({ other: 1, pooledWorktrees: true });
    await writeFile(settings, "not json");
    await expect(readPoolSetting(settings)).rejects.toThrow("is not valid JSON");
  });
});

describe("start", () => {
  it("creates a plain worktree from the published default branch when pooling is not active", async () => {
    const { root, primary, published, settings } = await repository();
    for (const pool of [fakePool(root, { version: null }), fakePool(root)]) {
      if (pool !== undefined && (await pool.version())) await writePoolSetting(false, settings);
      const branch = (await pool.version()) ? "fix/second" : "feature/first";
      const started = await startWorktree({ cwd: primary, branch, pool, file: settings });
      expect(started).toMatchObject({ branch, created: true, pooled: false });
      expect(started.path).toBe(join(primary, ".worktrees", branch.split("/")[1]));
      expect(await git(started.path, "rev-parse", "HEAD")).toBe(published);
      expect(await git(started.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(branch);
      expect(pool.log).toEqual([]);
    }
    const again = await startWorktree({ cwd: primary, branch: "feature/first", pool: fakePool(root, { version: null }), file: settings });
    expect(again).toMatchObject({ created: false, pooled: false, path: join(primary, ".worktrees", "first") });
    await expect(startWorktree({ cwd: primary, branch: "crew/x", file: settings })).rejects.toThrow("type/short-description");
    await expect(startWorktree({ cwd: primary, branch: "feature/Has Space", file: settings })).rejects.toThrow("type/short-description");
  });

  it("leases a pool slot when pooling is active, and continues a task in the slot it has", async () => {
    const { root, primary, published, settings } = await repository();
    const pool = fakePool(root);
    const started = await startWorktree({ cwd: primary, branch: "feature/pooled", pool, file: settings });
    expect(started).toMatchObject({ created: true, pooled: true, path: join(root, "pool", "1", "primary") });
    expect(await git(started.path, "rev-parse", "HEAD")).toBe(published);
    expect(await git(started.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("feature/pooled");
    expect(existsSync(join(primary, ".worktrees"))).toBe(false);
    const again = await startWorktree({ cwd: primary, branch: "feature/pooled", pool, file: settings });
    expect(again).toMatchObject({ created: false, pooled: true, path: started.path });
    expect(pool.log).toEqual(["lease 1"]);
  });
});

describe("finish and cleanup with a pool", () => {
  it("never asks the pool about plain worktrees, and keeps a worktree it cannot ask GitHub about", async () => {
    const { root, primary, settings } = await repository();
    const { path } = await startWorktree({ cwd: primary, branch: "feature/plain", pool: fakePool(root, { version: null }), file: settings });
    const untouched = { ...fakePool(root), slots: async () => { throw new Error("the pool was asked"); } };
    const offline = async () => { throw new Error("no GitHub remote"); };
    const report = await cleanupWorktrees({ cwd: primary, apply: true, findMergedPull: offline, pool: untouched });
    expect(report.results).toMatchObject([{ action: "keep", pooled: false, forceable: true, reason: "could not ask for a merged pull request (no GitHub remote)" }]);
    const forced = await finishWorktree({ cwd: primary, target: "plain", force: true, findMergedPull: offline, pool: untouched });
    expect(forced).toMatchObject({ removed: true, branchRemoved: false, forced: true });
    expect(existsSync(path)).toBe(false);
    expect(await git(primary, "branch", "--list", "feature/plain")).toContain("feature/plain");
  });

  it("returns a merged slot, clears its scratch folder, deletes the branch and reuses the slot", async () => {
    const { root, primary, settings } = await repository();
    const pool = fakePool(root);
    const { path } = await startWorktree({ cwd: primary, branch: "feature/one", pool, file: settings });
    await writeFile(join(path, "one.txt"), "one");
    await git(path, "add", "-A");
    await git(path, "commit", "--quiet", "-m", "one");
    await mkdir(join(path, ".artifacts"));
    await writeFile(join(path, ".artifacts", "pr-body.md"), "old task");
    await mkdir(join(path, "node_modules"));
    await writeFile(join(path, "node_modules", "dep.js"), "kept");
    const findMergedPull = merged({ "feature/one": await git(path, "rev-parse", "HEAD") });

    const preview = await cleanupWorktrees({ cwd: primary, findMergedPull, pool });
    expect(preview.results).toMatchObject([{ action: "remove", pooled: true }]);
    expect(formatReport(preview)).toContain("would return");

    const result = await finishWorktree({ cwd: primary, target: "feature/one", findMergedPull, pool });
    expect(result).toMatchObject({ removed: true, branchRemoved: true, pooled: true });
    expect(formatFinish(result)).toContain("slot returned to the pool, branch deleted");
    expect(existsSync(path) && existsSync(join(path, "node_modules", "dep.js"))).toBe(true);
    expect(existsSync(join(path, ".artifacts"))).toBe(false);
    expect(await git(primary, "branch", "--list", "feature/one")).toBe("");

    const next = await startWorktree({ cwd: primary, branch: "feature/two", pool, file: settings });
    expect(next.path).toBe(path);
    expect(pool.log).toEqual(["lease 1", "return 1", "lease 1"]);
  });

  it("keeps a slot with unsaved work, forces it only on request, and never touches an idle slot", async () => {
    const { root, primary, settings } = await repository();
    const pool = fakePool(root);
    const { path } = await startWorktree({ cwd: primary, branch: "feature/dirty", pool, file: settings });
    await writeFile(join(path, "loose.txt"), "loose");
    const findMergedPull = merged({});

    const kept = await finishWorktree({ cwd: primary, target: path, findMergedPull, pool });
    expect(kept).toMatchObject({ removed: false, reason: "uncommitted or untracked files", forceable: true, pooled: true });
    expect(formatFinish(kept)).toContain("returns the slot and discards");

    const forced = await finishWorktree({ cwd: primary, target: path, force: true, findMergedPull, pool });
    expect(forced).toMatchObject({ removed: true, branchRemoved: false, forced: true });
    expect(existsSync(join(path, "loose.txt"))).toBe(false);
    expect(await git(primary, "branch", "--list", "feature/dirty")).toContain("feature/dirty");
    expect(pool.log).toEqual(["lease 1", "return 1 --force"]);

    const idle = await finishWorktree({ cwd: primary, target: path, force: true, findMergedPull, pool });
    expect(idle).toMatchObject({ removed: false, forceable: false });
    expect(idle.reason).toContain("a pool slot that no task holds (available)");
    const report = await cleanupWorktrees({ cwd: primary, apply: true, findMergedPull, pool });
    expect(report.results).toMatchObject([{ action: "keep", pooled: true }]);
    expect(existsSync(path)).toBe(true);
  });
});
