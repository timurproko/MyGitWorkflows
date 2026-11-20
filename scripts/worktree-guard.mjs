import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";
import { canonical, defaultGit, parseWorktrees, samePath } from "./worktree-cleanup.mjs";
import { defaultPool } from "./worktree-pool.mjs";

/**
 * A task's checkout has two managed places: `.worktrees/<name>` in the primary checkout, and a slot of
 * the treehouse pool. `delivery start` is the only thing that puts one there. A worktree anywhere else
 * was made by hand (`git worktree add`), usually by an agent that skipped the skill.
 *
 * Two answers to that, for two kinds of agent:
 * - the report: every agent runs `delivery`, so `start`, `cleanup` and `bootstrap` name what is misplaced;
 * - the guard: an agent that can run a command before each shell call is refused the command itself.
 */

/** The linked worktrees of this repository that are in neither managed place. Never moves or removes anything. */
export async function misplacedWorktrees({ cwd = process.cwd(), git = defaultGit, pool = defaultPool } = {}) {
  const [primary, ...linked] = parseWorktrees(await git(cwd, ["worktree", "list", "--porcelain"]));
  if (!primary || linked.length === 0) return [];
  const plain = (await canonical(join(primary.path, ".worktrees"))) + sep;
  const outside = [];
  for (const worktree of linked) {
    // A worktree whose folder is gone is Git's to prune, not a misplaced checkout.
    if (worktree.prunable) continue;
    const real = await canonical(worktree.path);
    if (!real.startsWith(plain)) outside.push({ ...worktree, real });
  }
  if (outside.length === 0) return [];
  const slots = await pool.slots(primary.path);
  return outside.filter(worktree => !slots.some(slot => samePath(slot.path, worktree.real)))
    .map(worktree => ({ path: worktree.path, branch: worktree.branch ?? null }));
}

/** What to tell whoever runs `delivery` about them: where each one is and the command that replaces it. */
export function formatMisplaced(misplaced) {
  if (misplaced.length === 0) return [];
  const slash = path => path.replaceAll("\\", "/");
  return [
    `${misplaced.length === 1 ? "A worktree is" : `${misplaced.length} worktrees are`} outside the managed places (.worktrees/ and the pool); a task's checkout comes only from \`delivery start\`:`,
    ...misplaced.map(({ path, branch }) => `  ${slash(path)} (${branch ?? "no branch"}): commit what it holds, then \`git worktree remove "${slash(path)}"\`${branch ? ` and \`delivery start ${branch}\`` : ""}`),
  ];
}

/** The report for a command that must not fail or slow down because of it: no lines when it cannot be told. */
export async function misplacedReport(options = {}) {
  try { return formatMisplaced(await misplacedWorktrees(options)); } catch { return []; }
}

// Between `git` and its subcommand only options may stand, so a commit message or a search that merely
// mentions the words is not a worktree being created.
const VALUE = String.raw`(?:"[^"]*"|'[^']*'|[^\s;&|]+)`;
const CREATES_WORKTREE = new RegExp(String.raw`(?:^|[\s;&|(` + "`" + String.raw`$])git(?:\.exe)?(?:\s+(?:(?:-C|-c|--git-dir|--work-tree|--namespace)(?:\s+|=)${VALUE}|--?[\w-]+(?:=${VALUE})?))*\s+worktree\s+add(?=\s|$)`, "i");
export const GUARD_REFUSAL = "Refused: a task's checkout is never created with `git worktree add`. Run `delivery start <type>/<short-name>` from the repository and work in the folder it prints (the change-delivery skill, section 1).";

/** Why a shell command is refused, or null when it may run. */
export function refusal(command) {
  if (typeof command !== "string") return null;
  // Quoted text is an argument, not a command: each quoted string becomes one opaque word, so a path with
  // spaces stays one value and words inside a message are not read as Git being run.
  if (CREATES_WORKTREE.test(command.replace(QUOTED, "Q"))) return GUARD_REFUSAL;
  // Except the one place a quoted string is a command: a shell started to run it.
  for (const [, , inner] of command.matchAll(SHELL_RUNS)) if (refusal(inner)) return GUARD_REFUSAL;
  return null;
}
const QUOTED = /"[^"]*"|'[^']*'/g;
const SHELL_RUNS = /\b(?:bash|sh|zsh|pwsh|powershell)(?:\.exe)?\b[^"']*?\s-(?:l?c|Command)\s+(["'])([\s\S]*?)\1/gi;

/**
 * `delivery guard`: the command an agent's pre-command hook runs. It takes the command either as its
 * arguments or as the hook's JSON on stdin (Claude Code: `{ "tool_input": { "command": "..." } }`).
 *
 * Invariant: it refuses only what it recognises. Input it cannot read lets the command run, so a
 * broken hook never stops an agent from working.
 * Returns the refusal text, or null.
 */
export function guard({ args = [], input = "" } = {}) {
  if (args.length) return refusal(args.join(" "));
  let command = input;
  try {
    const event = JSON.parse(input);
    command = event?.tool_input?.command ?? event?.command ?? "";
  } catch { /* not JSON: the text itself is the command */ }
  return refusal(command);
}

const HOOK_COMMAND = "delivery guard";
const HOOK_TOOLS = "Bash|PowerShell";

/**
 * Register the guard as a Claude Code hook that runs before every shell command, once per machine, so no
 * repository carries it. Claude Code blocks the command when the hook exits with 2 and shows the agent what
 * the hook wrote. Other settings and other hooks in the file are preserved.
 */
export async function registerClaudeGuard({ home = homedir() } = {}) {
  const path = join(home, ".claude", "settings.json");
  let settings = {};
  const text = await readFile(path, "utf8").catch(() => null);
  if (text !== null && text.trim()) {
    try { settings = JSON.parse(text); } catch { return `skipped ${path}: it is not valid JSON`; }
    if (settings === null || typeof settings !== "object" || Array.isArray(settings)) return `skipped ${path}: it is not a settings object`;
  }
  const hooks = settings.hooks && typeof settings.hooks === "object" && !Array.isArray(settings.hooks) ? settings.hooks : {};
  const before = Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse : [];
  if (before.some(entry => Array.isArray(entry?.hooks) && entry.hooks.some(hook => hook?.command === HOOK_COMMAND))) {
    return `Claude Code worktree guard already registered in ${path}`;
  }
  const entry = { matcher: HOOK_TOOLS, hooks: [{ type: "command", command: HOOK_COMMAND }] };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ ...settings, hooks: { ...hooks, PreToolUse: [...before, entry] } }, null, 2)}\n`);
  return `registered the worktree guard as a Claude Code hook in ${path}`;
}
