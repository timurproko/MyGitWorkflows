import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openspecVersion, runOpenspec } from "../scripts/openspec-version.mjs";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe("the shared OpenSpec version", () => {
  it("is the exact version package.json pins, and the action and Dependabot follow that file", async () => {
    const pinned = JSON.parse(await readFile("package.json", "utf8")).dependencies["@fission-ai/openspec"];
    expect(await openspecVersion()).toBe(pinned);
    expect(await readFile("actions/openspec/action.yml", "utf8")).toContain("dependencies['@fission-ai/openspec']");
    expect(await readFile(".github/dependabot.yml", "utf8")).toMatch(/package-ecosystem: npm/);
  });

  it("refuses a range, because every user must run the same version", async () => {
    const root = await mkdtemp(join(tmpdir(), "delivery-openspec-"));
    roots.push(root);
    const manifest = join(root, "package.json");
    await writeFile(manifest, JSON.stringify({ dependencies: { "@fission-ai/openspec": "^1.11.0" } }));
    await expect(openspecVersion(manifest)).rejects.toThrow("exact version");
  });

  it("runs the pinned version with the given arguments and returns its status", async () => {
    const calls: string[][] = [];
    const status = await runOpenspec(["validate", "--all"], { run: (_command: string, args: string[]) => { calls.push(args); return { status: 3 }; } });
    expect(status).toBe(3);
    expect(calls[0]).toEqual(["--yes", `@fission-ai/openspec@${await openspecVersion()}`, "validate", "--all"]);
  });
});
