import { archiveFailure, CHANGE, SHA } from "./openspec-archive-policy.mjs";

export const ASSOCIATION_REPAIR_SCHEMA = "a1-openspec-association-repair-v1";
const FIELDS = ["change", "correctivePr", "failureReason", "repository", "schema", "sourceHead", "sourceMerge", "sourcePr", "validationRunId"];

/** Parse the deliberately narrow record used to repair one integrated unassociated delivery. */
export function parseAssociationRepair(text) {
  let value;
  try { value = JSON.parse(text); } catch { throw archiveFailure("association-repair-json"); }
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join("\0") !== FIELDS.join("\0")
    || value.schema !== ASSOCIATION_REPAIR_SCHEMA || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value.repository ?? "")
    || !CHANGE.test(value.change ?? "") || !Number.isSafeInteger(value.sourcePr) || value.sourcePr < 1
    || !SHA.test(value.sourceHead ?? "") || !SHA.test(value.sourceMerge ?? "")
    || !Number.isSafeInteger(value.validationRunId) || value.validationRunId < 1
    || value.failureReason !== "missing-openspec-implementation-metadata"
    || !Number.isSafeInteger(value.correctivePr) || value.correctivePr < 1 || value.correctivePr === value.sourcePr) {
    throw archiveFailure("association-repair-record");
  }
  return value;
}
