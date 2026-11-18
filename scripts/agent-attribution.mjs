/**
 * AI agents must not appear as authors or co-authors: a squash merge copies every branch author into a
 * `Co-authored-by` trailer, which puts the agent in the repository's contributors for good.
 */
const AGENT = /copilot|claude|anthropic|cursor ?agent|cursoragent|cursor\.com|codex|openai|chatgpt|devin|aider|gemini|jules|windsurf|codeium|amazon ?q|sourcegraph|\bcody\b/i;
const GENERATED = /generated (?:with|by) .{0,40}(?:claude|copilot|cursor|codex|chatgpt|gemini|devin|aider)/i;
const MAX_COMMITS = 250;

/** The agent identity in a name, email or login, or `null`. */
export function agentIdentity(...values) {
  for (const value of values) if (typeof value === "string" && AGENT.test(value)) return value;
  return null;
}

/** Every agent attribution in one commit as GitHub's pull-request commit list returns it. */
export function commitAttribution(entry) {
  const found = [];
  const identity = agentIdentity(entry?.author?.login, entry?.commit?.author?.name, entry?.commit?.author?.email,
    entry?.committer?.login, entry?.commit?.committer?.name, entry?.commit?.committer?.email);
  if (identity) found.push(`authored by ${identity}`);
  for (const line of String(entry?.commit?.message ?? "").split("\n")) {
    const trailer = /^\s*co-authored-by:\s*(.+)$/i.exec(line)?.[1];
    if (trailer && agentIdentity(trailer)) found.push(`co-authored by ${trailer.trim()}`);
    else if (GENERATED.test(line)) found.push("carries a generated-with line");
  }
  return found;
}

/**
 * Inspect a pull request's commits, title and body. Returns `null` when clean, otherwise one bounded
 * detail string naming the first offending commits.
 */
export async function inspectAgentAttribution(reader, pull) {
  const found = [];
  if (GENERATED.test(`${pull?.title ?? ""}\n${pull?.body ?? ""}`)) found.push("the pull-request title or body carries a generated-with line");
  const commits = await reader.pages(`/pulls/${pull.number}/commits`, MAX_COMMITS);
  for (const entry of commits) {
    for (const reason of commitAttribution(entry)) found.push(`${String(entry.sha ?? "").slice(0, 7)} ${reason}`);
  }
  if (found.length === 0) return null;
  const shown = found.slice(0, 5).join("; ");
  return found.length > 5 ? `${shown}; and ${found.length - 5} more` : shown;
}
