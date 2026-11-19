import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installOpenspecSkills } from "../scripts/install.mjs";
import { ensureOpenspecSkills, generatedSkills } from "../scripts/openspec-skills.mjs";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function checkout(version = "2.0.0") {
  const base = await mkdtemp(join(tmpdir(), "delivery-skills-"));
  roots.push(base);
  const root = join(base, "workflow"), home = join(base, "home");
  await mkdir(root); await mkdir(home);
  await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { "@fission-ai/openspec": version } }));
  return { root, home };
}
function generator(names: string[], calls: string[] = []) {
  return Object.assign(async (directory: string, version: string) => {
    calls.push(version);
    for (const name of names) {
      await mkdir(join(directory, ".agents", "skills", name), { recursive: true });
      await writeFile(join(directory, ".agents", "skills", name, "SKILL.md"), `name: ${name}\nversion ${version}\n`);
    }
  }, { calls });
}
const ALL = ["openspec-propose", "openspec-apply-change", "openspec-archive-change", "openspec-sync-specs"];

describe("OpenSpec skills", () => {
  it("generates the pinned version once, withholds the skills the bot owns, and links the rest for every agent", async () => {
    const { root, home } = await checkout();
    const generate = generator(ALL);
    const lines = await installOpenspecSkills({ home, root, generate });
    expect(lines[0]).toBe("generated 2 OpenSpec 2.0.0 skills");
    expect((await generatedSkills(root)).map(path => basename(path))).toEqual(["openspec-apply-change", "openspec-propose"]);
    for (const folder of [".claude", ".agents"]) {
      expect(await readFile(join(home, folder, "skills", "openspec-propose", "SKILL.md"), "utf8")).toContain("version 2.0.0");
      expect(existsSync(join(home, folder, "skills", "openspec-archive-change"))).toBe(false);
    }
    const again = await installOpenspecSkills({ home, root, generate });
    expect(again.every(line => line.startsWith("already linked"))).toBe(true);
    expect(generate.calls).toEqual(["2.0.0"]);
  });

  it("generates again when the pinned version changes, and drops a skill the new version no longer has", async () => {
    const { root, home } = await checkout();
    await installOpenspecSkills({ home, root, generate: generator(ALL) });
    await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { "@fission-ai/openspec": "2.1.0" } }));
    expect(await ensureOpenspecSkills({ root, generate: generator(["openspec-propose"]) })).toBe("generated 1 OpenSpec 2.1.0 skills");
    expect(await generatedSkills(root)).toHaveLength(1);
    expect(await readFile(join(home, ".agents", "skills", "openspec-propose", "SKILL.md"), "utf8")).toContain("version 2.1.0");
  });

  it("keeps the previous skills and reports one line when generation fails", async () => {
    const { root, home } = await checkout();
    await installOpenspecSkills({ home, root, generate: generator(ALL) });
    await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { "@fission-ai/openspec": "2.1.0" } }));
    const lines = await installOpenspecSkills({ home, root, generate: async () => { throw new Error("offline"); } });
    expect(lines[0]).toBe("OpenSpec skills not generated: offline");
    expect(await readFile(join(home, ".claude", "skills", "openspec-propose", "SKILL.md"), "utf8")).toContain("version 2.0.0");
  });

  it("does nothing for a copy that has no pinned version yet", async () => {
    const { root, home } = await checkout();
    await rm(join(root, "package.json"));
    expect(await installOpenspecSkills({ home, root, generate: async () => { throw new Error("must not run"); } })).toEqual([]);
  });
});
