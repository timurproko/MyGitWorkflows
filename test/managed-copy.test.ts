import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { disableClaudeAttribution, installEverything } from "../scripts/install.mjs";
import { ensureManagedCopy, legacyRoot, managedRoot, refreshManagedCopy } from "../scripts/managed-copy.mjs";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.test", ...args], { cwd, encoding: "utf8" });

async function upstream() {
  const root = await mkdtemp(join(tmpdir(), "delivery-managed-"));
  roots.push(root);
  const origin = join(root, "origin");
  await mkdir(join(origin, "skills", "change-delivery"), { recursive: true });
  git(origin, "init", "--quiet", "--initial-branch=main");
  await writeFile(join(origin, "skills", "change-delivery", "SKILL.md"), "name: change-delivery\nversion one\n");
  git(origin, "add", "-A");
  git(origin, "commit", "--quiet", "-m", "one");
  const home = join(root, "home");
  await mkdir(home);
  return { origin, home };
}

async function publish(origin: string, text: string) {
  await writeFile(join(origin, "skills", "change-delivery", "SKILL.md"), text);
  git(origin, "commit", "--quiet", "-am", "next");
}

describe("managed copy", () => {
  it("downloads once, then fast-forwards, and the linked skill follows", async () => {
    const { origin, home } = await upstream();
    const linked: string[] = [];
    const lines = await installEverything({ home, link: async (root: string) => { linked.push(root); return "linked the delivery command"; }, ...{ url: origin } });
    expect(lines[0]).toContain("downloaded");
    expect(linked).toEqual([managedRoot(home)]);
    const skill = join(home, ".claude", "skills", "change-delivery", "SKILL.md");
    expect(await readFile(skill, "utf8")).toContain("version one");

    await publish(origin, "name: change-delivery\nversion two\n");
    expect(await ensureManagedCopy({ home, url: origin })).toContain("updated");
    expect(await readFile(skill, "utf8")).toContain("version two");
  });

  it("moves a machine off the earlier location and turns Claude Code attribution off once", async () => {
    const { origin, home } = await upstream();
    await mkdir(join(legacyRoot(home), "skills"), { recursive: true });
    await mkdir(join(home, ".claude"), { recursive: true });
    await writeFile(join(home, ".claude", "settings.json"), JSON.stringify({ theme: "dark", attribution: { other: 1 } }));
    const lines = await installEverything({ home, url: origin, link: async () => "linked the delivery command" });
    expect(managedRoot(home)).toBe(join(home, ".workflow"));
    expect(existsSync(legacyRoot(home))).toBe(false);
    expect(lines.at(-1)).toContain("removed the earlier copy");
    expect(JSON.parse(await readFile(join(home, ".claude", "settings.json"), "utf8")))
      .toEqual({ theme: "dark", attribution: { other: 1, commit: "", pr: "" }, includeCoAuthoredBy: false });
    expect(await disableClaudeAttribution({ home })).toContain("already off");
    await writeFile(join(home, ".claude", "settings.json"), "{ not json");
    expect(await disableClaudeAttribution({ home })).toContain("not valid JSON");
  });

  it("refreshes the managed copy at most hourly and never touches another checkout", async () => {
    const { origin, home } = await upstream();
    await ensureManagedCopy({ home, url: origin });
    const root = managedRoot(home);
    const stamp = join(root, ".git", "FETCH_HEAD");
    await publish(origin, "name: change-delivery\nversion two\n");

    expect(await refreshManagedCopy({ home, root: origin })).toBeNull();
    await writeFile(stamp, "");
    expect(await refreshManagedCopy({ home, root })).toBeNull();
    expect(await readFile(join(root, "skills", "change-delivery", "SKILL.md"), "utf8")).toContain("version one");

    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(stamp, old, old);
    expect(await refreshManagedCopy({ home, root })).toMatch(/^shared workflow updated to [0-9a-f]{7}$/);
    expect(await readFile(join(root, "skills", "change-delivery", "SKILL.md"), "utf8")).toContain("version two");
    expect(await refreshManagedCopy({ home, root, force: true })).toBe("already up to date");
  });

  it("reports a failed refresh in one line without throwing", async () => {
    const { origin, home } = await upstream();
    await ensureManagedCopy({ home, url: origin });
    await rm(origin, { recursive: true, force: true });
    const note = await refreshManagedCopy({ home, root: managedRoot(home), force: true });
    expect(note).toMatch(/^shared workflow not updated: /);
    expect(existsSync(managedRoot(home))).toBe(true);
  });
});
