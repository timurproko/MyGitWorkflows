import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bootstrap, commandOnPath } from "../scripts/bootstrap.mjs";
import { managedRoot } from "../scripts/managed-copy.mjs";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.test", ...args], { cwd, encoding: "utf8" });

async function upstream() {
  const root = await mkdtemp(join(tmpdir(), "delivery-bootstrap-"));
  roots.push(root);
  const origin = join(root, "origin");
  await mkdir(join(origin, "skills", "change-delivery"), { recursive: true });
  git(origin, "init", "--quiet", "--initial-branch=main");
  await writeFile(join(origin, "skills", "change-delivery", "SKILL.md"), "name: change-delivery\nversion one\n");
  git(origin, "add", "-A");
  git(origin, "commit", "--quiet", "-m", "one");
  const home = join(root, "home");
  await mkdir(home);
  return { root, origin, home };
}

describe("bootstrap", () => {
  it("sets a machine up once, then stays silent and cheap until the copy is an hour old", async () => {
    const { origin, home } = await upstream();
    const linked: string[] = [];
    let present = false;
    const options = { home, url: origin, link: async (root: string) => { linked.push(root); present = true; return "linked the delivery command"; }, onPath: async () => present };

    const first = await bootstrap(options);
    expect(first[0]).toContain("downloaded");
    expect(first.join("\n")).toContain("linked the delivery command");
    expect(first.at(-1)).toContain("turned Claude Code attribution off");
    expect(linked).toEqual([managedRoot(home)]);
    const skill = join(home, ".agents", "skills", "change-delivery", "SKILL.md");
    expect(await readFile(skill, "utf8")).toContain("version one");
    expect(await readFile(join(home, ".claude", "skills", "change-delivery", "SKILL.md"), "utf8")).toContain("version one");

    await writeFile(join(origin, "skills", "change-delivery", "SKILL.md"), "name: change-delivery\nversion two\n");
    git(origin, "commit", "--quiet", "-am", "two");
    const stamp = join(managedRoot(home), ".git", "FETCH_HEAD");
    await writeFile(stamp, "");
    expect(await bootstrap(options)).toEqual([]);
    expect(linked).toHaveLength(1);
    expect(await readFile(skill, "utf8")).toContain("version one");

    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(stamp, old, old);
    expect(await bootstrap(options)).toEqual([expect.stringMatching(/^shared workflow updated to [0-9a-f]{7}$/)]);
    expect(await readFile(skill, "utf8")).toContain("version two");
  });

  it("restores a removed skill link without downloading again", async () => {
    const { origin, home } = await upstream();
    const options = { home, url: origin, link: async () => "linked the delivery command", onPath: async () => true };
    await bootstrap(options);
    await writeFile(join(managedRoot(home), ".git", "FETCH_HEAD"), "");
    await rm(join(home, ".agents", "skills", "change-delivery"), { recursive: true, force: true });
    const lines = await bootstrap(options);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^linked .*\.agents/);
  });

  it("reports an unreachable source in one line and never throws", async () => {
    const { root, home } = await upstream();
    const lines = await bootstrap({ home, url: join(root, "missing"), link: async () => { throw new Error("must not link"); }, onPath: async () => false });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^shared workflow: download failed: /);
    expect(existsSync(join(home, ".claude"))).toBe(false);
  });

  it("keeps going when linking the command fails", async () => {
    const { origin, home } = await upstream();
    const lines = await bootstrap({ home, url: origin, link: async () => { throw new Error("npm is missing"); }, onPath: async () => false });
    expect(lines).toContain("shared workflow: command link failed: npm is missing");
    expect(lines.at(-1)).toContain("turned Claude Code attribution off");
  });

  it("finds a command on the PATH by its platform file names", async () => {
    const { root } = await upstream();
    const bin = join(root, "bin");
    await mkdir(bin);
    await writeFile(join(bin, "delivery.cmd"), "");
    const path = [join(root, "absent"), bin].join(delimiter);
    expect(await commandOnPath("delivery", { path, platform: "win32" })).toBe(true);
    expect(await commandOnPath("delivery", { path, platform: "linux" })).toBe(false);
    expect(await commandOnPath("delivery", { path: "", platform: "win32" })).toBe(false);
  });
});

describe("repository bootstrap template", () => {
  const template = join("templates", "workflow-bootstrap.mjs");
  const run = (env: Record<string, string>) => spawnSync(process.execPath, [template], { encoding: "utf8", env: { ...process.env, ...env } });

  it("does nothing on a CI runner or when switched off", async () => {
    const { home } = await upstream();
    for (const env of [{ CI: "true" }, { CI: "", WORKFLOW_BOOTSTRAP_SKIP: "1" }]) {
      const result = run({ HOME: home, USERPROFILE: home, ...env });
      expect(result.status).toBe(0);
      expect(result.stdout + result.stderr).toBe("");
      expect(existsSync(join(home, ".workflow"))).toBe(false);
    }
  });
});
