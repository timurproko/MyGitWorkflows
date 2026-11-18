import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const run = promisify(execFile);
export const DELIVERY_CHECK = "delivery / Delivery check";
// GitHub's built-in repository admin role; "pull_request" lets an admin merge any pull request but never push directly.
const ADMIN_BYPASS = Object.freeze({ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "pull_request" });
const DEFAULT_BRANCH = "~DEFAULT_BRANCH";
const DECLARATIONS = new URL("../protection/repositories.json", import.meta.url);

/** The reviewed rulesets of every repository, keyed by `owner/name`. */
export async function loadDeclarations(url = DECLARATIONS) {
  return JSON.parse(await readFile(url, "utf8"));
}

/**
 * Build one GitHub ruleset from its declaration. Three kinds exist:
 * `default-branch` (pull request, tests and the delivery check), `branch` (a branch only automation
 * advances: no deletion, no force push) and `release-tags` (tags only the release App may move).
 */
export function buildRuleset(declaration, defaultBranch) {
  const base = { enforcement: "active" };
  if (declaration.kind === "default-branch") {
    const checks = [...new Set([...(declaration.checks ?? []), ...(declaration.delivery === false ? [] : [DELIVERY_CHECK])])];
    return { ...base, name: `protect-${defaultBranch}`, target: "branch",
      bypass_actors: [{ ...ADMIN_BYPASS }],
      conditions: { ref_name: { include: [DEFAULT_BRANCH], exclude: [] } },
      rules: [
        { type: "deletion" },
        { type: "non_fast_forward" },
        ...(declaration.linearHistory ? [{ type: "required_linear_history" }] : []),
        { type: "pull_request", parameters: {
          required_approving_review_count: 0, dismiss_stale_reviews_on_push: true, require_code_owner_review: false,
          require_last_push_approval: false, required_review_thread_resolution: true,
          allowed_merge_methods: declaration.mergeMethods ?? ["squash"],
        } },
        { type: "required_status_checks", parameters: {
          strict_required_status_checks_policy: true, do_not_enforce_on_create: false,
          required_status_checks: checks.map(context => ({ context })),
        } },
      ] };
  }
  if (declaration.kind === "branch") {
    return { ...base, name: `protect-${declaration.branch}`, target: "branch", bypass_actors: [],
      conditions: { ref_name: { include: [`refs/heads/${declaration.branch}`], exclude: [] } },
      rules: [{ type: "deletion" }, { type: "non_fast_forward" }] };
  }
  if (declaration.kind === "release-tags") {
    return { ...base, name: "protect-release-tags", target: "tag",
      bypass_actors: (declaration.bypassApps ?? []).map(actor_id => ({ actor_id, actor_type: "Integration", bypass_mode: "always" })),
      conditions: { ref_name: { include: [`refs/tags/${declaration.pattern ?? "v*"}`], exclude: [] } },
      rules: [{ type: "deletion" }, { type: "non_fast_forward" }] };
  }
  throw new Error(`unknown ruleset kind: ${declaration.kind}`);
}

/**
 * GitHub blocks `pull_request_target` in public repositories unless an Actions policy allows it. This builds the
 * policy that lets exactly the declared workflow files run on exactly the declared events.
 */
export function buildEventPolicy(declaration) {
  return {
    name: "allow-delivery-events",
    enforcement: "active",
    conditions: { workflow_path: { include: [...declaration.workflows].sort(), exclude: [] } },
    rules: [{ type: "restrict_action_events", parameters: { allowed_events: [...declaration.events].sort() } }],
  };
}

/** Differences between a live Actions policy and the desired one; empty when they agree. */
export function describePolicyChanges(existing, desired) {
  if (!existing) return ["create it"];
  const paths = policy => [...(policy.conditions?.workflow_path?.include ?? [])].sort().join(", ") || "all workflows";
  const events = policy => [...(policy.rules?.find(rule => rule.type === "restrict_action_events")?.parameters?.allowed_events ?? [])].sort().join(", ") || "none";
  const changes = [];
  if (existing.enforcement !== desired.enforcement) changes.push(`enforcement ${existing.enforcement} -> ${desired.enforcement}`);
  if (paths(existing) !== paths(desired)) changes.push(`workflows ${paths(existing)} -> ${paths(desired)}`);
  if (events(existing) !== events(desired)) changes.push(`events ${events(existing)} -> ${events(desired)}`);
  return changes;
}

const refs = (ruleset, defaultBranch) => (ruleset?.conditions?.ref_name?.include ?? [])
  .map(ref => ref === DEFAULT_BRANCH ? `refs/heads/${defaultBranch}` : ref).sort().join(",");

/** The live ruleset that governs the same refs as `desired`, whatever it is called. */
export function findLiveRuleset(live, desired, defaultBranch) {
  return live.find(ruleset => ruleset.target === desired.target && refs(ruleset, defaultBranch) === refs(desired, defaultBranch)) ?? null;
}

const contexts = parameters => (parameters?.required_status_checks ?? []).map(check => check.context);
const shown = (key, value) => key === "required_status_checks" ? contexts({ [key]: value }).join(", ") || "none" : JSON.stringify(value);

/** Human-readable differences between a live ruleset and the desired one; empty when they agree. */
export function describeChanges(existing, desired, defaultBranch) {
  if (!existing) return ["create it"];
  const changes = [];
  if (existing.name !== desired.name) changes.push(`rename from ${existing.name}`);
  if (existing.enforcement !== desired.enforcement) changes.push(`enforcement ${existing.enforcement} -> ${desired.enforcement}`);
  const bypass = list => (list ?? []).map(actor => `${actor.actor_type}:${actor.actor_id}:${actor.bypass_mode}`).sort().join(", ") || "none";
  if (bypass(existing.bypass_actors) !== bypass(desired.bypass_actors)) changes.push(`bypass ${bypass(existing.bypass_actors)} -> ${bypass(desired.bypass_actors)}`);
  if (refs(existing, defaultBranch) !== refs(desired, defaultBranch)) changes.push(`refs ${refs(existing, defaultBranch)} -> ${refs(desired, defaultBranch)}`);
  const types = list => (list ?? []).map(item => item.type).sort().join(", ");
  if (types(existing.rules) !== types(desired.rules)) changes.push(`rules ${types(existing.rules) || "none"} -> ${types(desired.rules)}`);
  for (const wanted of desired.rules) {
    const live = existing.rules?.find(item => item.type === wanted.type)?.parameters ?? {};
    for (const [key, value] of Object.entries(wanted.parameters ?? {})) {
      if (shown(key, live[key]) !== shown(key, value)) changes.push(`${wanted.type}.${key}: ${shown(key, live[key])} -> ${shown(key, value)}`);
    }
  }
  return changes;
}

// Rationale: GitHub pins a required check to the app that reports it; keep that pin when the check stays.
function keepCheckSources(desired, existing) {
  const pinned = new Map((existing?.rules?.find(item => item.type === "required_status_checks")?.parameters?.required_status_checks ?? [])
    .filter(check => check.integration_id != null).map(check => [check.context, check.integration_id]));
  return { ...desired, rules: desired.rules.map(rule => rule.type !== "required_status_checks" ? rule : { ...rule, parameters: {
    ...rule.parameters,
    required_status_checks: rule.parameters.required_status_checks.map(check => pinned.has(check.context) ? { ...check, integration_id: pinned.get(check.context) } : check),
  } }) };
}

/**
 * Compare a repository's rulesets with its declaration and, with `apply`, make them match.
 * A live ruleset that is not declared is reported and never changed or deleted.
 */
export async function protectRepository({ repository, apply = false, api = defaultApi, declarations }) {
  const declared = (declarations ?? await loadDeclarations())[repository];
  if (!declared) throw new Error(`${repository} is not declared in protection/repositories.json`);
  const defaultBranch = (await api("GET", `repos/${repository}`)).default_branch;
  const live = [];
  for (const entry of await api("GET", `repos/${repository}/rulesets`)) live.push(await api("GET", `repos/${repository}/rulesets/${entry.id}`));
  const managed = new Set();
  const rulesets = [];
  for (const declaration of declared.filter(item => item.kind === "workflow-events")) {
    const desired = buildEventPolicy(declaration);
    const policies = (await api("GET", `repos/${repository}/actions/policies`))?.policies ?? [];
    const existing = policies.find(policy => policy.name === desired.name) ?? null;
    const changes = describePolicyChanges(existing, desired);
    if (apply && changes.length > 0) {
      if (existing) await api("PUT", `repos/${repository}/actions/policies/${existing.id}`, desired);
      else await api("POST", `repos/${repository}/actions/policies`, desired);
    }
    rulesets.push({ name: `Actions policy ${desired.name}`, changes });
  }
  for (const declaration of declared.filter(item => item.kind !== "workflow-events")) {
    const desired = buildRuleset(declaration, defaultBranch);
    const existing = findLiveRuleset(live, desired, defaultBranch);
    if (existing) managed.add(existing.id);
    const changes = describeChanges(existing, desired, defaultBranch);
    if (apply && changes.length > 0) {
      const body = keepCheckSources(desired, existing);
      if (existing) await api("PUT", `repos/${repository}/rulesets/${existing.id}`, body);
      else await api("POST", `repos/${repository}/rulesets`, body);
    }
    rulesets.push({ name: desired.name, changes });
  }
  const notes = live.filter(ruleset => !managed.has(ruleset.id)).map(ruleset => `ruleset ${ruleset.name} is not declared and was left alone`);
  // Invariant: a classic rule is removed only after a fresh read shows the declared ruleset active on that
  // branch, so the branch is never left without protection.
  const branches = [defaultBranch, ...declared.filter(declaration => declaration.kind === "branch").map(declaration => declaration.branch)];
  for (const branch of branches) {
    const path = `repos/${repository}/branches/${branch}/protection`;
    if (!await api("GET", path).catch(() => null)) continue;
    if (!apply) { notes.push(`the classic branch protection rule on ${branch} duplicates the ruleset and would be removed`); continue; }
    const desired = buildRuleset(declared.find(declaration => declaration.kind === (branch === defaultBranch ? "default-branch" : "branch") && (branch === defaultBranch || declaration.branch === branch)), defaultBranch);
    const current = [];
    for (const entry of await api("GET", `repos/${repository}/rulesets`)) current.push(await api("GET", `repos/${repository}/rulesets/${entry.id}`));
    const installed = findLiveRuleset(current, desired, defaultBranch);
    if (installed?.enforcement === "active" && describeChanges(installed, desired, defaultBranch).length === 0) {
      await api("DELETE", path);
      notes.push(`removed the classic branch protection rule on ${branch}; ${desired.name} protects it`);
    } else notes.push(`kept the classic branch protection rule on ${branch}: ${desired.name} is not confirmed active`);
  }
  return { repository, rulesets, applied: apply, notes };
}

export function formatProtection(result) {
  const pending = result.rulesets.some(ruleset => ruleset.changes.length > 0);
  return [
    `${result.repository}`,
    ...result.rulesets.flatMap(ruleset => ruleset.changes.length === 0
      ? [`  ${ruleset.name}: matches`]
      : [`  ${ruleset.name}: ${result.applied ? "updated" : "would change"}`, ...ruleset.changes.map(change => `    - ${change}`)]),
    ...result.notes.map(note => `  note: ${note}`),
    ...(pending && !result.applied ? ["Nothing was changed. Run again with --apply to make these changes."] : []),
  ].join("\n");
}

async function defaultApi(method, path, body) {
  // Protocol: the Actions policies endpoints are served from this API version onwards.
  const version = path.includes("/actions/policies") ? ["-H", "X-GitHub-Api-Version: 2026-03-10"] : [];
  const child = run("gh", ["api", "-X", method, ...version, path, ...(body ? ["--input", "-"] : [])], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  if (body) child.child.stdin.end(JSON.stringify(body));
  const { stdout } = await child;
  return stdout.trim() ? JSON.parse(stdout) : null;
}
