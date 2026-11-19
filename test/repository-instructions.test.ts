import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkDelivery } from "../scripts/delivery-check.mjs";
import { inspectCheckout, inspectRepositoryInstructions, isInstructionPath, judgeInstructionFile, readTemplate } from "../scripts/repository-instructions.mjs";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const head = "b".repeat(40);
const template = "# Agent instructions\n\nLoad the shared skill.\n";

type Changed = { filename: string; status?: string; additions?: number; deletions?: number };
function reader(files: Changed[], contents: Record<string, string> = {}) {
  return {
    prefix: "/repos/owner/repo",
    pages: async () => files.map(file => ({ status: "modified", additions: 1, deletions: 0, ...file })),
    get: async (path: string) => {
      const name = /\/contents\/(.+)\?ref=/.exec(path)?.[1] ?? "";
      return name in contents ? { content: Buffer.from(contents[name]).toString("base64") } : {};
    },
  };
}
const inspect = (files: Changed[], contents: Record<string, string> = {}) =>
  inspectRepositoryInstructions(reader(files, contents), { number: 5, head: { sha: head } }, { template });

describe("repository instructions", () => {
  it("recognizes the files agents read instructions from, at any depth", () => {
    for (const path of ["AGENTS.md", "CLAUDE.md", ".claude/CLAUDE.md", "plugins/x/claude.md", ".github/copilot-instructions.md", ".cursor/rules/a.mdc", ".cursorrules"]) {
      expect(isInstructionPath(path), path).toBe(true);
    }
    for (const path of ["README.md", "docs/agents.md.txt", "docs/build.md", "openspec/specs/x/spec.md", ".claude/settings.json"]) {
      expect(isInstructionPath(path), path).toBe(false);
    }
  });

  it("accepts only the template and its one-line import, whatever the line endings", () => {
    expect(judgeInstructionFile("AGENTS.md", template.replaceAll("\n", "\r\n") + "  \r\n", template)).toBeNull();
    expect(judgeInstructionFile("AGENTS.md", `${template}\nOur own rule.\n`, template)).toBe("AGENTS.md differs from the shared template");
    expect(judgeInstructionFile("CLAUDE.md", "@AGENTS.md\r\n", template)).toBeNull();
    expect(judgeInstructionFile("CLAUDE.md", "@AGENTS.md\n\nCommit only when asked.\n", template)).toBe("CLAUDE.md must contain only @AGENTS.md");
    expect(judgeInstructionFile(".claude/CLAUDE.md", "@../AGENTS.md", template)).toContain("outside the shared template");
  });

  it("ignores a pull request that touches no instruction file", async () => {
    await expect(inspect([{ filename: "src/a.ts" }, { filename: "docs/build.md" }, { filename: "AGENTS.md", status: "removed" }])).resolves.toBeNull();
  });

  it("requires a touched root file to reach its final form", async () => {
    await expect(inspect([{ filename: "AGENTS.md" }, { filename: "CLAUDE.md" }], { "AGENTS.md": template, "CLAUDE.md": "@AGENTS.md\n" })).resolves.toBeNull();
    await expect(inspect([{ filename: "AGENTS.md", additions: 0, deletions: 9 }], { "AGENTS.md": "# Mine\n" }))
      .resolves.toBe("AGENTS.md differs from the shared template");
  });

  it("lets another instruction file shrink or go, and refuses one that is added or grows", async () => {
    await expect(inspect([{ filename: ".claude/CLAUDE.md", additions: 2, deletions: 30 }])).resolves.toBeNull();
    await expect(inspect([{ filename: ".claude/CLAUDE.md", status: "removed", additions: 0, deletions: 90 }])).resolves.toBeNull();
    await expect(inspect([{ filename: ".claude/CLAUDE.md", additions: 3, deletions: 1 }]))
      .resolves.toBe(".claude/CLAUDE.md is an agent instruction file outside the shared template; it may only be deleted or reduced");
    await expect(inspect([{ filename: "plugins/x/CLAUDE.md", status: "added", additions: 4, deletions: 0 }])).resolves.toContain("plugins/x/CLAUDE.md");
    const many = Array.from({ length: 7 }, (_, index) => ({ filename: `p${index}/CLAUDE.md`, status: "added" }));
    await expect(inspect(many)).resolves.toMatch(/; and 2 more$/);
  });

  it("fails the delivery check before association is considered", async () => {
    const pull = { number: 5, state: "open", draft: false, body: "", head: { sha: head } };
    const result = await checkDelivery({ reader: { prefix: "/repos/owner/repo", get: async () => pull }, number: 5, expectedHead: head,
      inspectAttribution: async () => null, inspectInstructions: async () => "AGENTS.md differs from the shared template",
      inspectUnassociated: async () => { throw new Error("must not be reached"); } });
    expect(result).toEqual({ outcome: "fail", reason: "repository-instructions", detail: "AGENTS.md differs from the shared template" });
  });

  it("ships a template that points at the skill, docs and specs and states no delivery rule of its own", async () => {
    const text = await readTemplate();
    expect(text).toContain("`change-delivery` skill");
    expect(text).toContain("delivery.mjs install");
    expect(text).toContain("`docs/`");
    expect(text).toContain("`openspec/specs/`");
    expect(text).not.toMatch(/draft|auto-merge|worktree|\bbranch/i);
  });
});

describe("delivery instructions in a checkout", () => {
  async function checkout() {
    const root = await mkdtemp(join(tmpdir(), "delivery-instructions-"));
    roots.push(root);
    return root;
  }

  it("reports what differs, writes the two root files on apply, and leaves other files for a person", async () => {
    const root = await checkout();
    await mkdir(join(root, ".claude"));
    await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(root, "AGENTS.md"), "# Mine\n");
    await writeFile(join(root, ".claude", "CLAUDE.md"), "rules\n");
    await writeFile(join(root, "node_modules", "pkg", "AGENTS.md"), "vendored\n");

    const report = await inspectCheckout({ cwd: root, template });
    expect(report.ok).toBe(false);
    expect(report.lines).toEqual(["AGENTS.md differs from the shared template", "CLAUDE.md is missing",
      ".claude/CLAUDE.md is an agent instruction file outside the shared template"]);

    const applied = await inspectCheckout({ cwd: root, apply: true, template });
    expect(applied.lines.slice(0, 2)).toEqual(["wrote AGENTS.md", "wrote CLAUDE.md"]);
    expect(applied.ok).toBe(false);
    expect(await readFile(join(root, "AGENTS.md"), "utf8")).toBe(template);
    expect(await readFile(join(root, "CLAUDE.md"), "utf8")).toBe("@AGENTS.md\n");
    expect(await readFile(join(root, ".claude", "CLAUDE.md"), "utf8")).toBe("rules\n");

    await rm(join(root, ".claude"), { recursive: true });
    expect(await inspectCheckout({ cwd: root, template })).toEqual({ ok: true, lines: [] });
  });

  it("leaves a separate Git repository inside the checkout to answer for itself", async () => {
    const root = await checkout();
    await writeFile(join(root, "AGENTS.md"), template);
    await writeFile(join(root, "CLAUDE.md"), "@AGENTS.md\n");
    await mkdir(join(root, "private"));
    execFileSync("git", ["init", "--quiet"], { cwd: join(root, "private") });
    await writeFile(join(root, "private", "CLAUDE.md"), "its own\n");
    expect(await inspectCheckout({ cwd: root, template })).toEqual({ ok: true, lines: [] });
  });
});
