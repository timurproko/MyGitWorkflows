// Rationale: one implementation serves every repository, so the protected branch is supplied by the caller, never assumed.
const BRANCH_NAME = /^(?![-/.])(?!.*(?:\.\.|\/\/|@\{))[A-Za-z0-9._/-]{1,200}(?<![/.])$/;

/**
 * The branch deliveries integrate into, from `DELIVERY_BASE_BRANCH`. Trusted workflows pass the
 * repository's default branch; there is deliberately no fallback, so a missing value fails closed.
 */
export function targetBranch(environment = process.env) {
  const branch = environment.DELIVERY_BASE_BRANCH;
  if (typeof branch !== "string" || !BRANCH_NAME.test(branch)) {
    throw new Error("DELIVERY_BASE_BRANCH must name the repository's delivery target branch");
  }
  return branch;
}
