import { describe, expect, it } from "vitest";
import { DELIVERY_CHECK, buildEventPolicy, buildRuleset, describePolicyChanges, describeChanges, findLiveRuleset, formatProtection, loadDeclarations, protectRepository } from "../scripts/repository-protection.mjs";

const declarations = {
  "o/r": [
    { kind: "default-branch", checks: ["Tests required"], mergeMethods: ["merge", "squash"] },
    { kind: "branch", branch: "master" },
    { kind: "release-tags", pattern: "v*", bypassApps: [42] },
  ],
};
const legacyDefault = {
  id: 7, name: "a1-protect-develop", target: "branch", enforcement: "active", bypass_actors: [],
  conditions: { ref_name: { include: ["refs/heads/develop"], exclude: [] } },
  rules: [
    { type: "deletion" }, { type: "non_fast_forward" },
    { type: "pull_request", parameters: { required_approving_review_count: 0, dismiss_stale_reviews_on_push: true, required_reviewers: [], require_code_owner_review: false, require_last_push_approval: false, required_review_thread_resolution: true, allowed_merge_methods: ["merge", "squash"] } },
    { type: "required_status_checks", parameters: { strict_required_status_checks_policy: true, do_not_enforce_on_create: false, required_status_checks: [{ context: "Tests required", integration_id: 15368 }] } },
  ],
};
const legacyTags = { id: 9, name: "a1-protect-release-tags", target: "tag", enforcement: "active", bypass_actors: [{ actor_id: 42, actor_type: "Integration", bypass_mode: "always" }],
  conditions: { ref_name: { include: ["refs/tags/v*"], exclude: [] } }, rules: [{ type: "deletion" }, { type: "non_fast_forward" }] };
const stray = { id: 11, name: "experiment", target: "branch", enforcement: "active", bypass_actors: [], conditions: { ref_name: { include: ["refs/heads/experiment"], exclude: [] } }, rules: [{ type: "deletion" }] };

function fake(rulesets: any[], { classic = false, policies = [] as any[] } = {}) {
  const calls: Array<[string, string, any?]> = [];
  const api = async (method: string, path: string, body?: unknown) => {
    calls.push([method, path, body]);
    if (method !== "GET") return {};
    if (path === "repos/o/r") return { default_branch: "develop" };
    if (path === "repos/o/r/actions/policies") return { total_count: policies.length, policies };
    if (path === "repos/o/r/rulesets") return rulesets.map(({ id, name }) => ({ id, name }));
    if (path.endsWith("/protection")) { if (classic && path.includes("/branches/develop/")) return {}; throw new Error("404"); }
    return rulesets.find(ruleset => path === `repos/o/r/rulesets/${ruleset.id}`);
  };
  return { api, writes: () => calls.filter(([method]) => method !== "GET") };
}

describe("repository protection", () => {
  it("builds the three kinds with generic names", () => {
    const [main, master, tags] = declarations["o/r"].map(declaration => buildRuleset(declaration, "develop"));
    expect([main!.name, master!.name, tags!.name]).toEqual(["protect-develop", "protect-master", "protect-release-tags"]);
    expect(main!.bypass_actors).toEqual([{ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "pull_request" }]);
    expect(main!.rules.at(-1)!.parameters!.required_status_checks).toEqual([{ context: "Tests required" }, { context: DELIVERY_CHECK }]);
    expect(master!.rules.map(rule => rule.type)).toEqual(["deletion", "non_fast_forward"]);
    expect(tags!.bypass_actors).toEqual([{ actor_id: 42, actor_type: "Integration", bypass_mode: "always" }]);
    expect(buildRuleset({ kind: "default-branch", linearHistory: true, delivery: false, checks: ["T"] }, "main").rules.map(rule => rule.type))
      .toEqual(["deletion", "non_fast_forward", "required_linear_history", "pull_request", "required_status_checks"]);
    expect(() => buildRuleset({ kind: "other" }, "main")).toThrow("unknown ruleset kind");
  });

  it("matches a live ruleset by the refs it governs, under any name or default-branch spelling", () => {
    const desired = buildRuleset(declarations["o/r"][0], "develop");
    expect(findLiveRuleset([legacyTags, legacyDefault], desired, "develop")).toBe(legacyDefault);
    expect(findLiveRuleset([legacyTags], desired, "develop")).toBeNull();
    expect(describeChanges(legacyDefault, desired, "develop")).toEqual([
      "rename from a1-protect-develop",
      "bypass none -> RepositoryRole:5:pull_request",
      `required_status_checks.required_status_checks: Tests required -> Tests required, ${DELIVERY_CHECK}`,
    ]);
  });

  it("reports without writing by default and never touches an undeclared ruleset", async () => {
    const dry = fake([legacyDefault, legacyTags, stray], { classic: true });
    const report = await protectRepository({ repository: "o/r", api: dry.api, declarations });
    expect(dry.writes()).toEqual([]);
    expect(report.rulesets.map(ruleset => [ruleset.name, ruleset.changes.length])).toEqual([["protect-develop", 3], ["protect-master", 1], ["protect-release-tags", 1]]);
    expect(report.notes).toEqual(["ruleset experiment is not declared and was left alone", "the classic branch protection rule on develop duplicates the ruleset and would be removed"]);
    expect(formatProtection(report)).toContain("Nothing was changed.");
  });

  it("applies in place, creates what is missing, and keeps the app a check is pinned to", async () => {
    const live = fake([legacyDefault, legacyTags, stray]);
    await protectRepository({ repository: "o/r", api: live.api, declarations, apply: true });
    const writes = live.writes();
    expect(writes.map(([method, path]) => `${method} ${path}`)).toEqual(["PUT repos/o/r/rulesets/7", "POST repos/o/r/rulesets", "PUT repos/o/r/rulesets/9"]);
    expect(writes[0]![2].rules.at(-1).parameters.required_status_checks).toEqual([{ context: "Tests required", integration_id: 15368 }, { context: DELIVERY_CHECK }]);
    expect(writes[2]![2].name).toBe("protect-release-tags");
  });

  it("writes nothing when everything already matches, and refuses an undeclared repository", async () => {
    const standard = declarations["o/r"].map((declaration, index) => ({ ...buildRuleset(declaration, "develop"), id: index + 1 }));
    const same = fake(standard);
    const report = await protectRepository({ repository: "o/r", api: same.api, declarations, apply: true });
    expect(same.writes()).toEqual([]);
    expect(formatProtection(report)).toContain("protect-develop: matches");
    await expect(protectRepository({ repository: "o/other", api: same.api, declarations })).rejects.toThrow("not declared");
  });

  it("removes a classic rule only when the declared ruleset is confirmed active", async () => {
    const standard = declarations["o/r"].map((declaration, index) => ({ ...buildRuleset(declaration, "develop"), id: index + 1 }));
    const ready = fake(standard, { classic: true });
    const done = await protectRepository({ repository: "o/r", api: ready.api, declarations, apply: true });
    expect(ready.writes().map(([method, path]) => `${method} ${path}`)).toEqual(["DELETE repos/o/r/branches/develop/protection"]);
    expect(done.notes).toEqual(["removed the classic branch protection rule on develop; protect-develop protects it"]);

    // The fake never reflects writes, so after applying it still reads the old ruleset: the classic rule must stay.
    const stale = fake([legacyDefault, legacyTags], { classic: true });
    const kept = await protectRepository({ repository: "o/r", api: stale.api, declarations, apply: true });
    expect(stale.writes().some(([method]) => method === "DELETE")).toBe(false);
    expect(kept.notes).toEqual(["kept the classic branch protection rule on develop: protect-develop is not confirmed active"]);
  });

  it("installs one Actions policy that allows the declared workflows their events", async () => {
    const events = { kind: "workflow-events", workflows: [".github/workflows/delivery.yml"], events: ["workflow_run", "pull_request_target"] };
    const desired = buildEventPolicy(events);
    expect(desired).toEqual({
      name: "allow-delivery-events", enforcement: "active",
      conditions: { workflow_path: { include: [".github/workflows/delivery.yml"], exclude: [] } },
      rules: [{ type: "restrict_action_events", parameters: { allowed_events: ["pull_request_target", "workflow_run"] } }],
    });
    expect(describePolicyChanges({ ...desired, id: 3 }, desired)).toEqual([]);
    expect(describePolicyChanges({ ...desired, id: 3, enforcement: "disabled", conditions: {} }, desired))
      .toEqual(["enforcement disabled -> active", "workflows all workflows -> .github/workflows/delivery.yml"]);

    const only = { "o/r": [events] };
    const fresh = fake([]);
    const created = await protectRepository({ repository: "o/r", api: fresh.api, declarations: only, apply: true });
    expect(created.rulesets).toEqual([{ name: "Actions policy allow-delivery-events", changes: ["create it"] }]);
    expect(fresh.writes().map(([method, path]) => `${method} ${path}`)).toEqual(["POST repos/o/r/actions/policies"]);

    const present = fake([], { policies: [{ ...desired, id: 3, rules: [{ type: "restrict_action_events", parameters: { allowed_events: ["pull_request_target"] } }] }] });
    await protectRepository({ repository: "o/r", api: present.api, declarations: only, apply: true });
    expect(present.writes().map(([method, path]) => `${method} ${path}`)).toEqual(["PUT repos/o/r/actions/policies/3"]);
  });

  it("ships a declaration file whose every entry builds", async () => {
    const shipped = await loadDeclarations();
    for (const [repository, list] of Object.entries(shipped)) {
      expect(repository).toMatch(/^[\w.-]+\/[\w.-]+$/);
      for (const declaration of list as any[]) {
        if (declaration.kind === "workflow-events") expect(buildEventPolicy(declaration).conditions.workflow_path.include.length).toBeGreaterThan(0);
        else expect(buildRuleset(declaration, "main").name).toMatch(/^protect-/);
      }
    }
  });
});
