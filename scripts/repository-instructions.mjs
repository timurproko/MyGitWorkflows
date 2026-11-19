import { lstat, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TEMPLATE = resolve(dirname(fileURLToPath(import.meta.url)), "..", "templates", "AGENTS.md");
const ENTRY = "AGENTS.md";
const IMPORT = "CLAUDE.md";
const IMPORT_TEXT = "@AGENTS.md";
// Rationale: these are the names agents read instructions from. Anything a repository writes there competes with
// the shared skill, so the only instruction files a repository holds are the template and its one-line import.
const INSTRUCTION_NAMES = new Set(["agents.md", "claude.md", "gemini.md", "copilot-instructions.md", ".cursorrules", ".windsurfrules"]);
const INSTRUCTION_FOLDERS = [".cursor/rules/", ".claude/rules/"];
const SKIPPED_DIRECTORIES = new Set(["node_modules", ".git", ".worktrees", ".artifacts"]);
const MAX_DEPTH = 6;

/** The shared template every repository's root `AGENTS.md` must equal. */
export async function readTemplate(path = TEMPLATE) {
  return readFile(path, "utf8");
}

// Rationale: Git may check a file out with either line ending; only the text is compared.
const normalize = text => String(text).replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "").trim();

/** Whether a repository path is a file agents read instructions from. */
export function isInstructionPath(path) {
  const lower = String(path).replaceAll("\\", "/").toLowerCase();
  if (INSTRUCTION_FOLDERS.some(folder => lower.startsWith(folder) || lower.includes(`/${folder}`))) return true;
  return INSTRUCTION_NAMES.has(lower.split("/").at(-1));
}

/**
 * Judge one instruction file. Returns `null` when it is allowed, otherwise the reason.
 * `content` is the file's text, or `null` when the caller did not read it.
 */
export function judgeInstructionFile(path, content, template) {
  const normalized = String(path).replaceAll("\\", "/");
  if (normalized === ENTRY) {
    return content !== null && normalize(content) === normalize(template) ? null : `${ENTRY} differs from the shared template`;
  }
  if (normalized === IMPORT) {
    return content !== null && normalize(content) === IMPORT_TEXT ? null : `${IMPORT} must contain only ${IMPORT_TEXT}`;
  }
  return `${normalized} is an agent instruction file outside the shared template`;
}

/**
 * The delivery-check rule: a pull request may not add to what a repository tells agents.
 *
 * Invariant: only files the pull request touches are judged, so a repository that has not been cleaned up yet
 * is not blocked on unrelated work. A touched root file must reach its final form; any other instruction file may
 * only be deleted or shrink, which lets a repository move its content into docs in more than one step.
 * Returns `null` when clean, otherwise one bounded detail string.
 */
export async function inspectRepositoryInstructions(reader, pull, { template } = {}) {
  const files = await reader.pages(`/pulls/${pull.number}/files`, 3000);
  const touched = files.filter(file => isInstructionPath(file.filename) && file.status !== "removed");
  if (touched.length === 0) return null;
  const text = template ?? await readTemplate();
  const found = [];
  for (const file of touched) {
    const root = file.filename === ENTRY || file.filename === IMPORT;
    if (!root && file.status !== "added" && file.status !== "renamed" && file.additions <= file.deletions && file.deletions > 0) continue;
    const content = root ? await readContent(reader, file.filename, pull.head?.sha) : null;
    const reason = judgeInstructionFile(file.filename, content, text);
    if (reason) found.push(root ? reason : `${reason}; it may only be deleted or reduced`);
  }
  if (found.length === 0) return null;
  const shown = found.slice(0, 5).join("; ");
  return found.length > 5 ? `${shown}; and ${found.length - 5} more` : shown;
}

async function readContent(reader, path, ref) {
  const file = await reader.get(`${reader.prefix}/contents/${path}?ref=${ref}`);
  return typeof file?.content === "string" ? Buffer.from(file.content, "base64").toString("utf8") : null;
}

/**
 * The local form, for a checkout: report every instruction file that is not the template or its import.
 * With `apply` the two root files are written; other files are only reported, because moving their content
 * into docs is a decision, not a copy.
 */
export async function inspectCheckout({ cwd = process.cwd(), apply = false, template } = {}) {
  const text = template ?? await readTemplate();
  const lines = [];
  for (const [name, wanted] of [[ENTRY, text], [IMPORT, `${IMPORT_TEXT}\n`]]) {
    const current = await readFile(join(cwd, name), "utf8").catch(() => null);
    if (current !== null && judgeInstructionFile(name, current, text) === null) continue;
    if (apply) {
      await writeFile(join(cwd, name), wanted);
      lines.push(`wrote ${name}`);
    } else {
      lines.push(current === null ? `${name} is missing` : judgeInstructionFile(name, current, text));
    }
  }
  for (const path of await findInstructionFiles(cwd)) {
    if (path !== ENTRY && path !== IMPORT) lines.push(judgeInstructionFile(path, null, text));
  }
  return { ok: lines.every(line => line.startsWith("wrote ")), lines };
}

async function findInstructionFiles(root, relative = "", depth = 0) {
  const found = [];
  let entries;
  try { entries = await readdir(join(root, relative), { withFileTypes: true }); } catch { return found; }
  for (const entry of entries) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      // Invariant: a separate Git repository inside the checkout answers for its own instruction files.
      if (SKIPPED_DIRECTORIES.has(entry.name) || depth + 1 >= MAX_DEPTH) continue;
      if (await lstat(join(root, child, ".git")).catch(() => null)) continue;
      found.push(...await findInstructionFiles(root, child, depth + 1));
    } else if (isInstructionPath(child)) found.push(child);
  }
  return found.sort();
}

/** What the command says about the files `--apply` does not touch. */
export const LEFT_FOR_REVIEW = "--apply writes AGENTS.md and CLAUDE.md. Any other file reported above is left alone: move what is specific to the repository into docs/, then delete it.";
