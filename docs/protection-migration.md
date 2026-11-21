# Protection override migration

There is no central repository inventory. Built-in defaults exactly preserve crew, xrbuild and herdr-app's
existing rulesets and Actions policy. MyWorkflows carries its own `.github/protection.json`, retaining its
`Delivery tooling tests` gate, self-delivery workflow and existing lack of a linear-history requirement.

## Order

1. Merge the MyWorkflows defaults/override change first. It includes MyWorkflows' override and the conservative
   preflight guard. Do not apply protection as part of this migration.
2. Until a1's separate override PR merges, report mode identifies its live check/merge/workflow differences as
   blocked and exits nonzero. `--apply` alone refuses every write. Do not use `--allow-rule-changes` to bypass
   this safeguard during adoption.
3. In a separate a1 PR, add the exact file below to its default branch. No rule application is necessary:
   the declarations already describe its live protection.
4. Report mode must show matches for crew, xrbuild, herdr-app and MyWorkflows after the MyWorkflows change
   merges, and for a1 after its own file merges. None of the five repositories' GitHub rules needs to change.

Reading overrides from GitHub intentionally means a new file in an unmerged PR is not used by the CLI. Before
merge, a read-only comparison using the proposed declarations and live API snapshots can establish that the
payload is unchanged, but it is not evidence that the default branch already contains the file.

## Exact file for a1

Path in a1: `.github/protection.json`

```json
[
  {
    "kind": "default-branch",
    "checks": ["Development validation required"],
    "mergeMethods": ["merge", "squash"]
  },
  { "kind": "branch", "branch": "master" },
  { "kind": "release-tags", "pattern": "v*", "bypassApps": [4942462] },
  {
    "kind": "workflow-events",
    "workflows": [
      ".github/workflows/delivery.yml",
      ".github/workflows/release-reopening-auto-merge.yml"
    ],
    "events": ["pull_request_target", "workflow_run", "workflow_dispatch"]
  }
]
```

This is the full replacement array, not a patch. In particular, it does not enable linear history, does allow
merge and squash, keeps the automation-only `master` branch and `v*` release-tag bypass App `4942462`, and
retains both workflow paths and all three events.
