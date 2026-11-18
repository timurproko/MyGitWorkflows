import { describe, expect, it } from "vitest";
import { targetBranch } from "../scripts/delivery-target.mjs";
import { classifyMergedBranchCleanup } from "../scripts/merged-branch-cleanup.mjs";
import { classifyRefreshCandidate } from "../scripts/ready-pull-request-refresh.mjs";

const sha = "a".repeat(40);

describe("caller-supplied delivery target", () => {
  it("fails closed without a valid branch name", () => {
    expect(targetBranch({ DELIVERY_BASE_BRANCH: "main" })).toBe("main");
    expect(targetBranch({ DELIVERY_BASE_BRANCH: "release/1.x" })).toBe("release/1.x");
    for (const value of [undefined, "", "-main", "a..b", "main/", "a b", "x@{1}"]) {
      expect(() => targetBranch({ DELIVERY_BASE_BRANCH: value })).toThrow("DELIVERY_BASE_BRANCH");
    }
  });

  it("applies one policy to a repository whose target is not develop", () => {
    const previous = process.env.DELIVERY_BASE_BRANCH;
    process.env.DELIVERY_BASE_BRANCH = "main";
    try {
      const pull = (base: string, ref = "feat/example") => ({ number: 7, merged: true, merged_at: "2026-01-01T00:00:00Z", state: "open", draft: false,
        base: { ref: base, repo: { full_name: "owner/repo" } }, head: { ref, sha, repo: { full_name: "owner/repo" } } });
      expect(classifyMergedBranchCleanup(pull("main"), "owner/repo").disposition).not.toBe("refused");
      expect(classifyMergedBranchCleanup(pull("develop"), "owner/repo")).toMatchObject({ disposition: "refused", reason: "base branch is not main" });
      expect(classifyMergedBranchCleanup(pull("main", "main"), "owner/repo").disposition).toBe("refused");
      expect(classifyRefreshCandidate(pull("develop"), "owner/repo")).toMatchObject({ reason: "base branch is not main" });
    } finally { process.env.DELIVERY_BASE_BRANCH = previous; }
  });
});
