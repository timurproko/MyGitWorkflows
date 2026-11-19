import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openspecVersion } from "./openspec-version.mjs";

const PACKAGE = "@fission-ai/openspec";
const GENERATED = ".generated";
const MARKER = "openspec-version";
// Rationale: synchronizing specifications and archiving a change belong to the delivery bot, so the skills that
// let an agent do either by hand are not handed out.
const WITHHELD = new Set(["openspec-archive-change", "openspec-sync-specs"]);

/** Where a checkout of this repository keeps the OpenSpec skills it generated; never committed. */
export function generatedSkillsRoot(root) {
  return join(root, GENERATED, "skills");
}

/** The generated skill folders of a checkout, as absolute paths in name order. */
export async function generatedSkills(root) {
  const base = generatedSkillsRoot(root);
  const names = await readdir(base).catch(() => []);
  return names.filter(name => name.startsWith("openspec-")).sort().map(name => join(base, name));
}

/**
 * Make the OpenSpec skills of the pinned version exist in this checkout. They are produced by OpenSpec itself, so
 * a version update needs no pull request for them: the first run after the pin changes generates them again.
 * Returns one report line, or `null` when they are already those of the pinned version.
 */
export async function ensureOpenspecSkills({ root, generate = generateWithOpenspec, version } = {}) {
  const pinned = version ?? await openspecVersion(join(root, "package.json"));
  const marker = join(root, GENERATED, MARKER);
  const current = (await readFile(marker, "utf8").catch(() => "")).trim();
  if (current === pinned && (await generatedSkills(root)).length > 0) return null;

  const scratch = await mkdtemp(join(tmpdir(), "delivery-openspec-skills-"));
  try {
    await generate(scratch, pinned);
    const produced = join(scratch, ".agents", "skills");
    const names = (await readdir(produced).catch(() => [])).filter(name => name.startsWith("openspec-") && !WITHHELD.has(name));
    const complete = [];
    for (const name of names) if (await stat(join(produced, name, "SKILL.md")).catch(() => null)) complete.push(name);
    if (complete.length === 0) throw new Error(`OpenSpec ${pinned} produced no skills`);
    // Invariant: the previous skills stay in place until the new ones exist, so a failed generation loses nothing.
    const target = generatedSkillsRoot(root);
    await mkdir(target, { recursive: true });
    for (const stale of await readdir(target)) if (!complete.includes(stale)) await rm(join(target, stale), { recursive: true, force: true });
    for (const name of complete) {
      await rm(join(target, name), { recursive: true, force: true });
      await cp(join(produced, name), join(target, name), { recursive: true });
    }
    await writeFile(marker, `${pinned}\n`);
    return `generated ${complete.length} OpenSpec ${pinned} skills`;
  } finally {
    await rm(scratch, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }
}

// Rationale: the generic `agents` target writes plain skill folders that every agent reads.
async function generateWithOpenspec(directory, version) {
  const result = spawnSync("npx", ["--yes", `${PACKAGE}@${version}`, "init", "--tools", "agents", "--no-animation", "."], {
    cwd: directory, stdio: "ignore", shell: process.platform === "win32", windowsHide: true, timeout: 180_000,
    env: { ...process.env, CI: "true", NO_COLOR: "1", OPENSPEC_TELEMETRY: "0" },
  });
  if (result.status !== 0) throw new Error(`OpenSpec ${version} could not generate its skills`);
}
