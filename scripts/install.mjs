import { lstat, mkdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SKILL = "change-delivery";
// Claude Code reads ~/.claude/skills; agents following the shared convention read ~/.agents/skills.
const SKILL_ROOTS = [join(".claude", "skills"), join(".agents", "skills")];

/**
 * Link one skill folder into the user-level agent folders under its own name. A link, not a copy, so updating
 * the linked checkout updates every agent in every repository at once. Returns one report line per folder.
 */
export async function install({ home = homedir(), source = resolve(dirname(fileURLToPath(import.meta.url)), "..", "skills", SKILL) } = {}) {
  const lines = [];
  for (const root of SKILL_ROOTS) {
    const target = join(home, root, basename(source));
    const existing = await lstat(target).catch(() => null);
    if (existing?.isSymbolicLink()) {
      if (resolve(await readlink(target)).replace(/[\\/]$/, "") === source) { lines.push(`already linked ${target}`); continue; }
      await rm(target);
    } else if (existing) {
      // Rationale: a real folder may hold someone's own skill; replacing it is the owner's decision.
      lines.push(`skipped ${target}: a folder that is not a link already exists`);
      continue;
    }
    await mkdir(dirname(target), { recursive: true });
    await symlink(source, target, "junction");
    lines.push(`linked ${target} -> ${source}`);
  }
  return lines;
}

/**
 * Generate the OpenSpec skills of the pinned version when they are missing or of another version, and link each
 * into the agent folders. A failed generation is one report line: the workflow itself must still install.
 */
export async function installOpenspecSkills({ home = homedir(), root, generate } = {}) {
  const { ensureOpenspecSkills, generatedSkills } = await import("./openspec-skills.mjs");
  const lines = [];
  // Rationale: a copy from before the single OpenSpec pin has no version to generate for; it catches up on update.
  if (!await lstat(join(root, "package.json")).catch(() => null)) return lines;
  try {
    const line = await ensureOpenspecSkills({ root, ...(generate ? { generate } : {}) });
    if (line) lines.push(line);
  } catch (error) {
    lines.push(`OpenSpec skills not generated: ${String(error.message).split("\n")[0]}`);
  }
  for (const source of await generatedSkills(root)) lines.push(...await install({ home, source }));
  return lines;
}

/**
 * Install for a machine: download or update the managed copy, link its skill, and put its `delivery`
 * command on the PATH. With `dev`, link the checkout this runs from instead, for working on the workflow.
 */
export async function installEverything({ home = homedir(), dev = false, link = linkCommand, url, generate } = {}) {
  const { currentRoot, ensureManagedCopy, managedRoot, removeLegacyCopy } = await import("./managed-copy.mjs");
  const lines = [];
  const root = dev ? currentRoot() : managedRoot(home);
  if (!dev) lines.push(await ensureManagedCopy({ home, ...(url ? { url } : {}) }));
  lines.push(...await install({ home, source: join(root, "skills", SKILL) }));
  lines.push(...await installOpenspecSkills({ home, root, ...(generate ? { generate } : {}) }));
  lines.push(await link(root));
  lines.push(await disableClaudeAttribution({ home }));
  if (!dev) {
    const legacy = await removeLegacyCopy({ home });
    if (legacy) lines.push(legacy);
  }
  return lines;
}

/**
 * Claude Code signs commits and pull requests as a co-author unless its settings say otherwise. Setting that once
 * per machine keeps it out of every repository, so no repository carries the setting or a rule about it; the
 * Delivery check remains the backstop for every other agent. Other settings in the file are preserved.
 */
export async function disableClaudeAttribution({ home = homedir() } = {}) {
  const path = join(home, ".claude", "settings.json");
  let settings = {};
  const text = await readFile(path, "utf8").catch(() => null);
  if (text !== null && text.trim()) {
    try { settings = JSON.parse(text); } catch { return `skipped ${path}: it is not valid JSON`; }
    if (settings === null || typeof settings !== "object" || Array.isArray(settings)) return `skipped ${path}: it is not a settings object`;
  }
  const wanted = { attribution: { ...(settings.attribution ?? {}), commit: "", pr: "" }, includeCoAuthoredBy: false };
  if (settings.attribution?.commit === "" && settings.attribution?.pr === "" && settings.includeCoAuthoredBy === false) {
    return `Claude Code attribution already off in ${path}`;
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ ...settings, ...wanted }, null, 2)}\n`);
  return `turned Claude Code attribution off in ${path}`;
}

// Rationale: `npm link` is the portable way to put a command on the PATH on Windows, macOS and Linux alike.
export async function linkCommand(root) {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  await promisify(execFile)("npm", ["link", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: root, shell: true, windowsHide: true });
  return `linked the delivery command -> ${root}`;
}
