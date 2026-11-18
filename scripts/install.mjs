import { lstat, mkdir, readlink, rm, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SKILL = "change-delivery";
// Claude Code reads ~/.claude/skills; agents following the shared convention read ~/.agents/skills.
const SKILL_ROOTS = [join(".claude", "skills"), join(".agents", "skills")];

/**
 * Link the shared skill into the user-level agent folders. A link, not a copy, so pulling this
 * repository updates every agent in every repository at once. Returns one report line per folder.
 */
export async function install({ home = homedir(), source = resolve(dirname(fileURLToPath(import.meta.url)), "..", "skills", SKILL) } = {}) {
  const lines = [];
  for (const root of SKILL_ROOTS) {
    const target = join(home, root, SKILL);
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
