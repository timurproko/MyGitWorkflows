import { archiveFailure, SHA } from "./openspec-archive-policy.mjs";
export function requireAcceptance(value, code) { if (!value) throw archiveFailure(code); }

/** GitHub stamps the pull request and its timeline event from different services; a few seconds of skew is the same merge. */
const MERGE_EVENT_SKEW_MS = 5000;
const sameMergeTime = (event, merged) => {
  const a = Date.parse(event ?? ""), b = Date.parse(merged ?? "");
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= MERGE_EVENT_SKEW_MS;
};

/** GitHub retains auto_merge after automatic integration; null means no authority remained active at merge time. */
const authorizedPermission = permission => ["write", "maintain", "admin"].includes(permission);
const human = actor => actor?.type === "User" && /^[a-zA-Z0-9-]{1,39}$/.test(actor.login ?? "");
/** The timeline names an enable by its merge method; only the webhook action is the generic `auto_merge_enabled`. */
const AUTO_MERGE_ENABLE_EVENTS = new Set(["auto_merge_enabled", "auto_squash_enabled", "auto_rebase_enabled"]);
const autoMergeEnabled = event => AUTO_MERGE_ENABLE_EVENTS.has(event.event);

function assertMergeEvent(pull, permission, events) {
  const actor = pull.merged_by;
  requireAcceptance(pull.merged === true && pull.state === "closed" && pull.draft === false
    && SHA.test(pull.merge_commit_sha ?? "") && Number.isFinite(Date.parse(pull.merged_at)), "acceptance-not-merged");
  requireAcceptance(human(actor) && authorizedPermission(permission), "acceptance-manual-authority");
  requireAcceptance(Array.isArray(events) && events.length <= 1000
    && !events.some(event => event.event === "added_to_merge_queue"), "acceptance-merge-provenance");
  const mergeIndexes = events.flatMap((event, index) => event.event === "merged" ? [index] : []);
  requireAcceptance(mergeIndexes.length === 1, "acceptance-merge-provenance");
  const mergeIndex = mergeIndexes[0], merge = events[mergeIndex];
  requireAcceptance(merge.actor?.login === actor.login && merge.actor?.type === "User"
    && merge.performed_via_github_app === null && merge.commit_id === pull.merge_commit_sha
    && sameMergeTime(merge.created_at, pull.merged_at), "acceptance-merge-provenance");
  return { actor: actor.login, mergeIndex };
}

/** Legacy acceptance PRs remain manual-only under their original policy. */
export function assertManualAcceptanceMerge(pull, permission, events) {
  const decision = assertMergeEvent(pull, permission, events);
  requireAcceptance(pull.auto_merge === null, "acceptance-manual-authority");
  requireAcceptance(!events.some(autoMergeEnabled), "acceptance-merge-provenance");
  return { kind: "manual", actor: decision.actor };
}
