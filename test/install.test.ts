import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { install } from "../scripts/install.mjs";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe("skill installation", () => {
  it("links the shared skill, is repeatable, and never replaces a real folder", async () => {
    const home = await mkdtemp(join(tmpdir(), "delivery-install-"));
    roots.push(home);
    await mkdir(join(home, ".agents", "skills", "change-delivery"), { recursive: true });
    await writeFile(join(home, ".agents", "skills", "change-delivery", "SKILL.md"), "mine");

    const first = await install({ home });
    expect(first[0]).toContain("linked");
    expect(first[1]).toContain("skipped");
    expect(await readFile(join(home, ".claude", "skills", "change-delivery", "SKILL.md"), "utf8")).toContain("name: change-delivery");
    expect(await readFile(join(home, ".agents", "skills", "change-delivery", "SKILL.md"), "utf8")).toBe("mine");
    expect((await install({ home }))[0]).toContain("already linked");

    // Removing the link must leave the shared skill itself in place.
    await rm(join(home, ".claude", "skills", "change-delivery"), { recursive: true, force: true });
    expect(existsSync("skills/change-delivery/SKILL.md")).toBe(true);
  });
});
