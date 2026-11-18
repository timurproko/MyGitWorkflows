# MyGitWorkflows

One implementation of the agent change-delivery workflow, shared by every repository that adopts it.
A repository keeps its code and specs; the workflow lives here and is updated here.

## The workflow

1. An agent opens a **draft** pull request whose body has `## Proposal`, `## Implementation` (checkboxes),
   later `## Acceptance`, and an `## Automation` block linking the OpenSpec change.
2. The agent ticks each Implementation checkbox as that outcome is written and pushed.
3. When every checkbox is ticked and the body is valid, the delivery bot marks the PR ready for review.
4. The bot finalizes the linked OpenSpec change in the PR branch (sync specs, archive, record the finalized head).
5. The repository's own CI runs its tests. The maintainer merges, or arms auto-merge.
6. After a merge, the bot deletes the merged branch and brings other ready PRs up to date.

Agents never mark a PR ready and never arm auto-merge. An agent merges one PR only on an explicit request
for that PR, and only with green CI on its current head.

## Adopting it in a repository

1. Install the delivery bot (GitHub App) on the repository and store its App id and private key as secrets.
2. Copy `templates/delivery-caller.yml` to `.github/workflows/delivery.yml` and set the two secret names.
3. Protect the default branch with the repository's own required CI check.

The target branch is the repository's default branch. Nothing else is configured per repository.

## Layout

- `scripts/` - the automation, imported from `timurproko/a1` and made repository-independent.
- `.github/workflows/delivery.yml` - the reusable workflow callers use.
- `templates/` - files a repository copies when it adopts the workflow.
- `test/` - `npm test`.

## Status

Extraction in progress. Done: finalization and promotion, ready-PR refresh, merged-branch cleanup.
Still to come: the bot's own delivery check, the shared agent skill, the local worktree cleanup command,
and removal of the legacy version 1 and 2 paths.
