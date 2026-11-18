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
3. Protect the default branch and require two checks: the repository's own test check and `delivery / Delivery check`.

The target branch is the repository's default branch. Nothing else is configured per repository.

## Local setup, once per machine

```bash
git clone git@github.com:timurproko/MyGitWorkflows.git && cd MyGitWorkflows && npm install && npm link && delivery install
```

`npm link` puts the `delivery` command on the path, and `delivery install` links the shared skill into
`~/.claude/skills` and `~/.agents/skills`. Both are links, so `git pull` here updates every agent in every repository.

| Command | Purpose |
| --- | --- |
| `delivery check-body --body-file <path> --final` | Validate a pull-request body with the rules the bot applies |
| `delivery cleanup` | List merged, clean worktrees that can be removed; `--apply` removes them |
| `delivery install` | Link the shared skill into the user-level agent folders |

## Layout

- `scripts/` - the automation, imported from `timurproko/a1` and made repository-independent.
- `.github/workflows/delivery.yml` - the reusable workflow callers use: promote and finalize, delivery check,
  ready-PR refresh, merged-branch deletion.
- `skills/change-delivery/` - the one agent skill for every repository.
- `bin/delivery.mjs` - the local command.
- `templates/` - files a repository copies when it adopts the workflow.
- `test/` - `npm test`.

## Status

Extraction in progress. Done: promotion and finalization, the delivery check, ready-PR refresh, merged-branch
deletion, plain delivery without OpenSpec, the shared skill and local worktree cleanup. Not yet adopted by any repository.
A repository without OpenSpec gets the same flow: its pull requests leave out the Automation section.
