import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { disableClaudeAttribution, install, installOpenspecSkills, linkCommand } from "./install.mjs";
import { ensureManagedCopy, managedRoot, refreshManagedCopy, SOURCE_URL } from "./managed-copy.mjs";

const SKILL = "change-delivery";
const COMMAND = "delivery";

/**
 * Make the shared workflow present and current on this machine, for a repository to call from something every
 * agent runs anyway (dependency installation, a Git hook). Unlike `install` it is cheap to repeat: it downloads
 * only when the managed copy is missing, fast-forwards at most hourly, and relinks only what is absent.
 *
 * Invariant: it never throws and never fails its caller. A machine that is offline or has no access must still
 * be able to install dependencies and push; every failure becomes one report line.
 * Returns the lines that describe a change or a failure, so a machine already set up prints nothing.
 */
export async function bootstrap({
  home = homedir(),
  url = SOURCE_URL,
  now = Date.now(),
  git,
  link = linkCommand,
  onPath = commandOnPath,
  generate,
} = {}) {
  const root = managedRoot(home);
  const lines = [];
  const step = async (name, action) => {
    try {
      const line = await action();
      if (line) lines.push(line);
      return true;
    } catch (error) {
      lines.push(`shared workflow: ${name} failed: ${String(error.stderr ?? error.message).trim().split("\n")[0]}`);
      return false;
    }
  };
  const transport = git ? { git } : {};

  if (await stat(join(root, ".git")).catch(() => null)) {
    await step("update", () => refreshManagedCopy({ home, root, now, ...transport }));
  } else if (!await step("download", () => ensureManagedCopy({ home, url, ...transport }))) {
    // Rationale: nothing to link without the copy; the next run tries the download again.
    return lines;
  }

  await step("skill link", async () => {
    const changed = (await install({ home, source: join(root, "skills", SKILL) })).filter((line) => !line.startsWith("already linked"));
    return changed.join("\n");
  });
  await step("OpenSpec skills", async () => {
    const changed = (await installOpenspecSkills({ home, root, ...(generate ? { generate } : {}) })).filter((line) => !line.startsWith("already linked"));
    return changed.join("\n");
  });
  await step("command link", async () => (await onPath(COMMAND) ? null : link(root)));
  await step("attribution setting", async () => {
    const line = await disableClaudeAttribution({ home });
    return line.includes("already off") ? null : line;
  });
  return lines;
}

/** Whether a command of that name is reachable through the PATH, without starting a process. */
export async function commandOnPath(name, { path = process.env.PATH ?? "", platform = process.platform } = {}) {
  const names = platform === "win32" ? [`${name}.cmd`, `${name}.ps1`, name] : [name];
  for (const folder of path.split(delimiter).filter(Boolean)) {
    for (const candidate of names) {
      if (await stat(join(folder, candidate)).catch(() => null)) return true;
    }
  }
  return false;
}
