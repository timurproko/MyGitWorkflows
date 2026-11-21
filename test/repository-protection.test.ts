import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { DEFAULT_DECLARATIONS, DELIVERY_CHECK, PROTECTION_FILE, buildEventPolicy, buildRuleset, describePolicyChanges, describeChanges, findLiveRuleset, formatProtection, loadProtection, protectRepository, validateDeclarations } from "../scripts/repository-protection.mjs";

const events = { kind: "workflow-events", workflows: [".github/workflows/delivery.yml"], events: ["pull_request_target", "workflow_dispatch"] };
const declarations = [
  { kind: "default-branch", checks: ["Tests required"], mergeMethods: ["merge", "squash"] },
  { kind: "branch", branch: "master" },
  { kind: "release-tags", pattern: "v*", bypassApps: [42] },
  events,
];
const legacyDefault = {
  id: 7, name: "old-protect-develop", target: "branch", enforcement: "active", bypass_actors: [],
  conditions: { ref_name: { include: ["refs/heads/develop"], exclude: [] } },
  rules: [
    { type: "deletion" }, { type: "non_fast_forward" },
    { type: "pull_request", parameters: { required_approving_review_count: 0, dismiss_stale_reviews_on_push: true, required_reviewers: [], require_code_owner_review: false, require_last_push_approval: false, required_review_thread_resolution: true, allowed_merge_methods: ["merge", "squash"] } },
    { type: "required_status_checks", parameters: { strict_required_status_checks_policy: true, do_not_enforce_on_create: false, required_status_checks: [{ context: "Tests required", integration_id: 15368 }] } },
  ],
};
const legacyTags = { id: 9, name: "old-protect-release-tags", target: "tag", enforcement: "active", bypass_actors: [{ actor_id: 42, actor_type: "Integration", bypass_mode: "always" }],
  conditions: { ref_name: { include: ["refs/tags/v*"], exclude: [] } }, rules: [{ type: "deletion" }, { type: "non_fast_forward" }] };
const stray = { id: 11, name: "experiment", target: "branch", enforcement: "active", bypass_actors: [], conditions: { ref_name: { include: ["refs/heads/experiment"], exclude: [] } }, rules: [{ type: "deletion" }] };
const httpError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });
const standard = (list = declarations) => list.filter(item => item.kind !== "workflow-events").map((item, index) => ({ ...buildRuleset(item, "develop"), id: index + 1 }));

function fake(rulesets: any[] = [], { classic = false, policies = [{ ...buildEventPolicy(events), id: 3 }] as any[], file = undefined as any, fileError = undefined as any, repository = "o/r" } = {}) {
  const calls: Array<[string, string, any?]> = [];
  const root = `repos/${repository}`;
  const api = async (method: string, path: string, body?: unknown) => {
    calls.push([method, path, body]);
    if (method !== "GET") return {};
    if (path === root) return { default_branch: "develop" };
    if (path === `${root}/branches/develop`) return { commit: { sha: "default-sha" } };
    if (path === `${root}/contents/${PROTECTION_FILE}?ref=default-sha`) {
      if (fileError) throw fileError;
      if (file === undefined) throw httpError(404);
      return file;
    }
    if (path === `${root}/actions/policies`) return { total_count: policies.length, policies: policies.map(({ id, name, enforcement }) => ({ id, name, enforcement })) };
    if (path.startsWith(`${root}/actions/policies/`)) return policies.find(policy => path.endsWith(`/${policy.id}`));
    if (path === `${root}/rulesets`) return rulesets.map(({ id, name }) => ({ id, name }));
    if (path.endsWith("/protection")) { if (classic && path.includes("/branches/develop/")) return {}; throw httpError(404); }
    const ruleset = rulesets.find(ruleset => path === `${root}/rulesets/${ruleset.id}`);
    if (ruleset) return ruleset;
    throw new Error(`unexpected API call: ${method} ${path}`);
  };
  return { api, calls, writes: () => calls.filter(([method]) => method !== "GET") };
}
const remoteFile = (value: any) => ({ type: "file", encoding: "base64", content: Buffer.from(JSON.stringify(value)).toString("base64") });

describe("repository protection configuration", () => {
  it("uses exact built-in defaults for any repository without registration", async () => {
    const live = fake(standard(DEFAULT_DECLARATIONS), { repository: "someone/new-project" });
    const report = await protectRepository({ repository: "someone/new-project", api: live.api });
    expect(report.rulesets.every(item => item.changes.length === 0)).toBe(true);
    expect(report.configuration).toEqual({ declarations: DEFAULT_DECLARATIONS, source: "built-in defaults", commit: "default-sha" });
    expect(live.writes()).toEqual([]);
    const branch = buildRuleset(DEFAULT_DECLARATIONS[0], "develop");
    expect(branch.name).toBe("protect-develop");
    expect(branch.conditions.ref_name).toEqual({ include: ["~DEFAULT_BRANCH"], exclude: [] });
    expect(branch.rules.map(rule => rule.type)).toEqual(["deletion", "non_fast_forward", "required_linear_history", "pull_request", "required_status_checks"]);
    expect(branch.rules.find(rule => rule.type === "pull_request")!.parameters.allowed_merge_methods).toEqual(["squash"]);
    expect(branch.rules.at(-1)!.parameters.required_status_checks).toEqual([{ context: "CI required" }, { context: DELIVERY_CHECK }]);
    expect(buildEventPolicy(DEFAULT_DECLARATIONS[1])).toEqual(buildEventPolicy(events));
    expect(formatProtection(report)).toContain("configuration: built-in defaults at default-sha");
  });

  it("reads the optional override at the resolved default-branch commit, replacing rather than merging defaults", async () => {
    const live = fake(standard(), { file: remoteFile(declarations) });
    const report = await protectRepository({ repository: "o/r", api: live.api });
    expect(report.configuration).toEqual({ declarations, source: PROTECTION_FILE, commit: "default-sha" });
    expect(report.rulesets.every(item => item.changes.length === 0)).toBe(true);
    expect(live.calls[1]!.slice(0, 2)).toEqual(["GET", "repos/o/r/branches/develop"]);
    expect(live.calls[2]!.slice(0, 2)).toEqual(["GET", `repos/o/r/contents/${PROTECTION_FILE}?ref=default-sha`]);
    expect(buildRuleset(report.configuration.declarations[0], "develop").rules.some(rule => rule.type === "required_linear_history")).toBe(false);
  });

  it("encodes default-branch names and ignores unrelated local configuration", async () => {
    const paths: string[] = [];
    const api = async (_method: string, path: string) => {
      paths.push(path);
      if (path.includes("/branches/")) return { commit: { sha: "pinned-sha" } };
      throw httpError(404);
    };
    expect((await loadProtection({ repository: "o/r", defaultBranch: "release/current", api })).source).toBe("built-in defaults");
    expect(paths).toEqual(["repos/o/r/branches/release%2Fcurrent", `repos/o/r/contents/${PROTECTION_FILE}?ref=pinned-sha`]);
  });

  it.each([401, 403, 429, 500])("fails closed on HTTP %s rather than using defaults", async status => {
    const live = fake([], { fileError: httpError(status) });
    await expect(protectRepository({ repository: "o/r", api: live.api, apply: true })).rejects.toThrow(`HTTP ${status}`);
    expect(live.writes()).toEqual([]);
  });

  it("does not hide a branch lookup failure or a network failure as a missing file", async () => {
    await expect(loadProtection({ repository: "o/r", defaultBranch: "main", api: async () => { throw httpError(404); } })).rejects.toThrow("HTTP 404");
    const live = fake([], { fileError: new Error("offline") });
    await expect(protectRepository({ repository: "o/r", api: live.api })).rejects.toThrow("offline");
  });

  it.each([
    { type: "dir" },
    { type: "file", encoding: "none", content: "" },
    { type: "file", encoding: "base64", content: Buffer.from("{").toString("base64") },
    remoteFile([]),
    remoteFile({}),
  ])("rejects unreadable or malformed remote files before any writes: %j", async file => {
    const live = fake([], { file });
    await expect(protectRepository({ repository: "o/r", api: live.api, apply: true })).rejects.toThrow();
    expect(live.writes()).toEqual([]);
  });

  it.each([
    [events],
    [...declarations, events],
    [...declarations, { kind: "branch", branch: "master" }],
    [...declarations, { kind: "branch", branch: "develop" }],
    [...declarations, { kind: "branch", branch: "bad..name" }],
    [...declarations, { kind: "plugin" }],
    [{ kind: "default-branch", checks: "CI required" }, events],
    [{ kind: "default-branch", linearHistory: "true" }, events],
    [{ kind: "default-branch", mergeMethods: ["unknown"] }, events],
    [{ kind: "default-branch", typo: true }, events],
    [declarations[0], { ...events, workflows: ["../workflow.yml"] }],
    [declarations[0], { ...events, events: [] }],
    [...declarations.slice(0, 2), { kind: "release-tags", bypassApps: ["42"] }, events],
  ])("rejects invalid declarations: %j", async (...items) => {
    // Vitest spreads each array row into arguments.
    expect(() => validateDeclarations(items, "develop")).toThrow(`invalid ${PROTECTION_FILE}`);
  });

  it("ships only this repository's exception, preserving its original declaration payload", async () => {
    const own = validateDeclarations(JSON.parse(await readFile(PROTECTION_FILE, "utf8")), "main");
    expect(own).toEqual([
      { kind: "default-branch", checks: ["Delivery tooling tests"] },
      { kind: "workflow-events", workflows: [".github/workflows/self-delivery.yml"], events: ["pull_request_target", "workflow_dispatch"] },
    ]);
    expect(buildRuleset(own[0], "main").rules.some(rule => rule.type === "required_linear_history")).toBe(false);
    await expect(readFile("protection/repositories.json", "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("repository protection", () => {
  it("builds the three ruleset kinds with generic names and existing field semantics", () => {
    const [main, master, tags] = standard();
    expect([main!.name, master!.name, tags!.name]).toEqual(["protect-develop", "protect-master", "protect-release-tags"]);
    expect(main!.bypass_actors).toEqual([{ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "pull_request" }]);
    expect(main!.rules.at(-1)!.parameters!.required_status_checks).toEqual([{ context: "Tests required" }, { context: DELIVERY_CHECK }]);
    expect(master!.rules.map(rule => rule.type)).toEqual(["deletion", "non_fast_forward"]);
    expect(tags!.bypass_actors).toEqual([{ actor_id: 42, actor_type: "Integration", bypass_mode: "always" }]);
    expect(buildRuleset({ kind: "default-branch", linearHistory: true, delivery: false, checks: ["T"] }, "main").rules.at(-1)!.parameters.required_status_checks).toEqual([{ context: "T" }]);
    expect(() => buildRuleset({ kind: "other" }, "main")).toThrow("unknown ruleset kind");
  });

  it("matches a live ruleset by refs under any name or default-branch spelling", () => {
    const desired = buildRuleset(declarations[0], "develop");
    expect(findLiveRuleset([legacyTags, legacyDefault], desired, "develop")).toBe(legacyDefault);
    expect(findLiveRuleset([legacyTags], desired, "develop")).toBeNull();
    expect(describeChanges(legacyDefault, desired, "develop")).toEqual([
      "rename from old-protect-develop",
      "bypass none -> RepositoryRole:5:pull_request",
      `required_status_checks.required_status_checks: Tests required -> Tests required, ${DELIVERY_CHECK}`,
    ]);
  });

  it("reports without writing and never touches an unmanaged ruleset", async () => {
    const dry = fake([legacyDefault, legacyTags, stray], { classic: true });
    const report = await protectRepository({ repository: "o/r", api: dry.api, declarations });
    expect(dry.writes()).toEqual([]);
    expect(report.rulesets.map(ruleset => [ruleset.name, ruleset.changes.length])).toEqual([["Actions policy allow-delivery-events", 0], ["protect-develop", 3], ["protect-master", 1], ["protect-release-tags", 1]]);
    expect(report.notes).toContain("ruleset experiment is not declared and was left alone");
    expect(formatProtection(report)).toContain("Nothing was changed.");
  });

  it("applies in place, creates missing rulesets, and retains check integration pins", async () => {
    const live = fake([legacyDefault, legacyTags, stray]);
    await protectRepository({ repository: "o/r", api: live.api, declarations, apply: true });
    const writes = live.writes();
    expect(writes.map(([method, path]) => `${method} ${path}`)).toEqual(["PUT repos/o/r/rulesets/7", "POST repos/o/r/rulesets", "PUT repos/o/r/rulesets/9"]);
    expect(writes[0]![2].rules.at(-1).parameters.required_status_checks).toEqual([{ context: "Tests required", integration_id: 15368 }, { context: DELIVERY_CHECK }]);
  });

  it("writes nothing when everything already matches", async () => {
    const same = fake(standard());
    const report = await protectRepository({ repository: "o/r", api: same.api, declarations, apply: true });
    expect(same.writes()).toEqual([]);
    expect(formatProtection(report)).toContain("protect-develop: matches");
  });

  it("removes classic protection only when a fresh read confirms a matching active ruleset", async () => {
    const ready = fake(standard(), { classic: true });
    const done = await protectRepository({ repository: "o/r", api: ready.api, declarations, apply: true });
    expect(ready.writes().map(([method, path]) => `${method} ${path}`)).toEqual(["DELETE repos/o/r/branches/develop/protection"]);
    expect(done.notes).toEqual(["removed the classic branch protection rule on develop; protect-develop protects it"]);
    const stale = fake([legacyDefault, legacyTags], { classic: true });
    const kept = await protectRepository({ repository: "o/r", api: stale.api, declarations, apply: true });
    expect(stale.writes().some(([method]) => method === "DELETE")).toBe(false);
    expect(kept.notes).toContain("kept the classic branch protection rule on develop: protect-develop is not confirmed active");
  });

  it("installs the Actions policy and reads existing policies in full before comparing", async () => {
    const desired = buildEventPolicy(events);
    expect(describePolicyChanges({ ...desired, id: 3 }, desired)).toEqual([]);
    expect(describePolicyChanges({ ...desired, enforcement: "disabled", conditions: {} }, desired)).toEqual(["enforcement disabled -> active", "workflows all workflows -> .github/workflows/delivery.yml"]);
    const fresh = fake([], { policies: [] });
    await protectRepository({ repository: "o/r", api: fresh.api, declarations: DEFAULT_DECLARATIONS, apply: true });
    expect(fresh.writes().map(([method, path]) => `${method} ${path}`)).toEqual(["POST repos/o/r/actions/policies", "POST repos/o/r/rulesets"]);
    const present = fake(standard(DEFAULT_DECLARATIONS), { policies: [{ ...desired, id: 3, rules: [{ type: "restrict_action_events", parameters: { allowed_events: ["pull_request_target"] } }] }] });
    await protectRepository({ repository: "o/r", api: present.api, declarations: DEFAULT_DECLARATIONS, apply: true });
    expect(present.writes().map(([method, path]) => `${method} ${path}`)).toEqual(["PUT repos/o/r/actions/policies/3"]);
  });
});
