import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { formatMisplaced, guard, GUARD_REFUSAL, misplacedReport, misplacedWorktrees, refusal, registerClaudeGuard } from "../scripts/worktree-guard.mjs";

const run = promisify(execFile);
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function git(cwd: string, ...args: string[]) {
  return (await run("git", ["-c", "user.name=Test", "-c", "user.email=test@example.test", "-c", "commit.gpgsign=false", ...args], { cwd })).stdout.trim();
}

async function repository() {
  const root = realpathSync.native(await mkdtemp(join(tmpdir(), "delivery-guard-")));
  roots.push(root);
  const primary = join(root, "primary");
  await git(root, "init", "--quiet", "--initial-branch=main", primary);
  await writeFile(join(primary, ".gitignore"), ".worktrees/\n");
  await git(primary, "add", "-A");
  await git(primary, "commit", "--quiet", "-m", "initial");
  return { root, primary };
}

const noPool = { slots: async () => [] };

describe("misplaced worktrees", () => {
  it("names only the worktrees outside .worktrees/ and the pool", async () => {
    const { root, primary } = await repository();
    const managed = join(primary, ".worktrees", "one"), slot = join(root, "pool", "1", "primary"), stray = join(root, "primary-by-hand"), reading = join(root, "reading");
    await git(primary, "worktree", "add", "--quiet", "-b", "feature/one", managed);
    await git(primary, "worktree", "add", "--quiet", "-b", "feature/two", slot);
    await git(primary, "worktree", "add", "--quiet", "-b", "feature/three", stray);
    await git(primary, "worktree", "add", "--quiet", "--detach", reading);
    const pool = { slots: async () => [{ path: slot }] };

    expect(await misplacedWorktrees({ cwd: primary, pool })).toEqual([{ path: stray, branch: "feature/three" }, { path: reading, branch: null }]);
    // Asked from inside a worktree, the answer is about the same repository.
    expect((await misplacedWorktrees({ cwd: stray, pool })).map(w => w.branch)).toEqual(["feature/three", null]);

    const lines = formatMisplaced(await misplacedWorktrees({ cwd: primary, pool }));
    expect(lines[0]).toContain("2 worktrees are outside the managed places");
    expect(lines[1]).toContain(`git worktree remove "${stray.replaceAll("\\", "/")}"\` and \`delivery start feature/three\``);
    expect(lines[2]).toContain("(no branch)");
    expect(lines[2]).not.toContain("delivery start");
  });

  it("says nothing for a repository whose worktrees are all managed, and for a worktree whose folder is gone", async () => {
    const { root, primary } = await repository();
    expect(await misplacedReport({ cwd: primary, pool: noPool })).toEqual([]);
    await git(primary, "worktree", "add", "--quiet", "-b", "feature/one", join(primary, ".worktrees", "one"));
    const gone = join(root, "gone");
    await git(primary, "worktree", "add", "--quiet", "-b", "feature/gone", gone);
    await rm(gone, { recursive: true, force: true });
    expect(await misplacedReport({ cwd: primary, pool: noPool })).toEqual([]);
  });

  it("never fails the command that asks", async () => {
    const outside = realpathSync.native(await mkdtemp(join(tmpdir(), "delivery-guard-none-")));
    roots.push(outside);
    expect(await misplacedReport({ cwd: outside, pool: noPool })).toEqual([]);
  });
});

describe("delivery guard", () => {
  it("refuses a shell command that creates a worktree with Git", () => {
    for (const command of [
      "git worktree add ../x -b feature/x",
      "cd /d/Git/repo && git worktree add -q /d/Git/repo-x -b feature/x",
      'git -C "D:/Git/my repo" worktree add ../x',
      "git -c core.autocrlf=false --no-pager worktree add x",
      "git.exe worktree add x",
      "(git worktree add x)",
      "true; GIT worktree ADD x",
      'bash -lc "cd repo && git worktree add ../x"',
      "pwsh -NoProfile -Command 'git worktree add x'",
    ]) expect(refusal(command), command).toBe(GUARD_REFUSAL);
  });

  it("lets everything else run", () => {
    for (const command of [
      "git worktree list --porcelain",
      "git worktree remove ../x",
      "git worktree prune",
      'git commit -m "docs: never run git worktree add yourself"',
      'grep -rn "git worktree add" skills',
      "delivery start feature/x",
      "legit worktree add x",
      "git worktree addendum",
      "",
    ]) expect(refusal(command), command).toBeNull();
    expect(refusal(undefined)).toBeNull();
  });

  it("reads the command from arguments, from a hook's JSON, or from plain text", () => {
    expect(guard({ args: ["git", "worktree", "add", "x"] })).toBe(GUARD_REFUSAL);
    expect(guard({ input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "git worktree add x" } }) })).toBe(GUARD_REFUSAL);
    expect(guard({ input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "git status" } }) })).toBeNull();
    expect(guard({ input: JSON.stringify({ tool_name: "Write", tool_input: { file_path: "x", content: "git worktree add x" } }) })).toBeNull();
    expect(guard({ input: "git worktree add x" })).toBe(GUARD_REFUSAL);
    // Invariant: input it cannot read lets the command run.
    expect(guard({ input: "{ broken" })).toBeNull();
    expect(guard()).toBeNull();
  });
});

describe("the Claude Code hook", () => {
  it("is added once and keeps other settings and hooks", async () => {
    const home = await mkdtemp(join(tmpdir(), "delivery-guard-home-"));
    roots.push(home);
    const path = join(home, ".claude", "settings.json");
    await mkdir(join(home, ".claude"), { recursive: true });
    const other = { matcher: "Edit", hooks: [{ type: "command", command: "format" }] };
    await writeFile(path, JSON.stringify({ model: "opus", hooks: { PreToolUse: [other], Stop: [{ hooks: [{ type: "command", command: "beep" }] }] } }));

    expect(await registerClaudeGuard({ home })).toContain("registered the worktree guard");
    const settings = JSON.parse(await readFile(path, "utf8"));
    expect(settings.model).toBe("opus");
    expect(settings.hooks.Stop).toHaveLength(1);
    expect(settings.hooks.PreToolUse).toEqual([other, { matcher: "Bash|PowerShell", hooks: [{ type: "command", command: "delivery guard" }] }]);

    expect(await registerClaudeGuard({ home })).toContain("already registered");
    expect(JSON.parse(await readFile(path, "utf8")).hooks.PreToolUse).toHaveLength(2);
  });

  it("creates the settings file on a machine without one and leaves a broken one alone", async () => {
    const home = await mkdtemp(join(tmpdir(), "delivery-guard-home-"));
    roots.push(home);
    expect(await registerClaudeGuard({ home })).toContain("registered");
    const path = join(home, ".claude", "settings.json");
    expect(JSON.parse(await readFile(path, "utf8")).hooks.PreToolUse).toHaveLength(1);
    await writeFile(path, "{ broken");
    expect(await registerClaudeGuard({ home })).toContain("not valid JSON");
    expect(await readFile(path, "utf8")).toBe("{ broken");
  });
});
