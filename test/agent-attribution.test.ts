import { describe, expect, it } from "vitest";
import { commitAttribution, inspectAgentAttribution } from "../scripts/agent-attribution.mjs";

const commit = (overrides: Record<string, unknown> = {}, message = "feat(ui): add the thing") => ({
  sha: "abc1234def", author: { login: "maintainer" }, committer: { login: "web-flow" },
  commit: { author: { name: "Maintainer", email: "m@example.test" }, committer: { name: "GitHub", email: "noreply@github.com" }, message },
  ...overrides,
});

describe("agent attribution", () => {
  it("accepts a maintainer commit and the delivery bot", () => {
    expect(commitAttribution(commit())).toEqual([]);
    expect(commitAttribution(commit({ author: { login: "openspec-ci[bot]" } }, "docs(openspec): finalize x\n\nCo-authored-by: openspec-ci[bot] <1+openspec-ci[bot]@users.noreply.github.com>"))).toEqual([]);
  });

  it("finds an agent author, an agent trailer and a generated-with line", () => {
    expect(commitAttribution(commit({ author: { login: "Copilot" } }))).toEqual(["authored by Copilot"]);
    expect(commitAttribution(commit({ commit: { author: { name: "copilot-swe-agent[bot]", email: "x@users.noreply.github.com" }, message: "fix" } })))
      .toEqual(["authored by copilot-swe-agent[bot]"]);
    expect(commitAttribution(commit({}, "fix: x\n\nCo-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>")))
      .toEqual(["co-authored by Copilot <223556219+Copilot@users.noreply.github.com>"]);
    expect(commitAttribution(commit({}, "fix: x\n\nCo-Authored-By: Claude Opus <noreply@anthropic.com>"))).toHaveLength(1);
    expect(commitAttribution(commit({}, "fix: x\n\nGenerated with [Claude Code](https://claude.com/claude-code)"))).toEqual(["carries a generated-with line"]);
  });

  it("reports the offending commits of a pull request in one bounded line", async () => {
    const reader = (commits: unknown[]) => ({ pages: async (path: string) => { expect(path).toBe("/pulls/7/commits"); return commits; } });
    expect(await inspectAgentAttribution(reader([commit()]), { number: 7, title: "feat: x", body: "## Proposal" })).toBeNull();
    expect(await inspectAgentAttribution(reader([commit(), commit({ author: { login: "Copilot" } })]), { number: 7 }))
      .toBe("abc1234 authored by Copilot");
    expect(await inspectAgentAttribution(reader([]), { number: 7, body: "Generated with Claude Code" }))
      .toBe("the pull-request title or body carries a generated-with line");
    const many = await inspectAgentAttribution(reader(Array.from({ length: 8 }, () => commit({ author: { login: "Copilot" } }))), { number: 7 });
    expect(many).toMatch(/; and 3 more$/);
  });
});
