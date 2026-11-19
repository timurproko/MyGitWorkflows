# MyWorkflows

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

1. Install the delivery bot (GitHub App) on the repository. Store its App id as the Actions variable `DELIVERY_BOT_APP_ID` and its private key as the secret `DELIVERY_BOT_PRIVATE_KEY`; every repository uses these two names.
2. Copy `templates/delivery-caller.yml` to `.github/workflows/delivery.yml` and set the two secret names.
3. Protect the default branch and require two checks: the repository's own test check and `delivery / Delivery check`.
4. Run `delivery instructions --apply` to write `AGENTS.md` (the shared template) and `CLAUDE.md` (`@AGENTS.md`).
   Move anything else agents were told into `docs/` and delete the old instruction files.
5. Copy `templates/workflow-bootstrap.mjs` to `scripts/workflow-bootstrap.mjs` and run it from the package manager's
   `prepare` script (`node scripts/workflow-bootstrap.mjs`), and from a Git `pre-push` hook if the repository has
   hooks. Any agent that installs dependencies or pushes then gets the shared workflow on a machine that lacks it,
   and a current copy on one that has it. It does nothing on CI runners and never fails the command that runs it.

The target branch is the repository's default branch. Nothing else is configured per repository.

## Local setup, once per machine

```bash
git clone https://github.com/timurproko/MyWorkflows.git ~/.workflow && node ~/.workflow/bin/delivery.mjs install
```

Every agent and command on the machine reads the workflow from that one managed copy, `~/.workflow`.
`delivery install` links its skill into `~/.claude/skills` and `~/.agents/skills` and puts its `delivery` command on
the path, and turns Claude Code commit and pull-request attribution off in `~/.claude/settings.json`. The copy fast-forwards itself at most once an hour whenever `delivery` runs, and `delivery update` does it
immediately, so nobody pulls by hand. A failed update (offline, no access) is reported in one line and never
blocks a command.

A separate clone is only for developing the workflow. `delivery install --dev` from such a clone links that clone
instead; run `delivery install` again to return to the managed copy.

| Command | Purpose |
| --- | --- |
| `delivery check-body --body-file <path> --final` | Validate a pull-request body with the rules the bot applies |
| `delivery cleanup` | List merged, clean worktrees that can be removed; `--apply` removes them |
| `delivery install` | Download or update the managed copy and link its skill and command |
| `delivery update` | Fast-forward the managed copy now |
| `delivery instructions` | Report agent instruction files that differ from `templates/AGENTS.md`; `--apply` writes `AGENTS.md` and `CLAUDE.md` |
| `delivery bootstrap` | What a repository's bootstrap file runs: download if missing, update hourly, relink only what is absent; silent when nothing changes and never fails |
| `delivery protect --repo <owner/name>` | Compare the repository rulesets with their declaration; `--apply` sets them |

## Branch and tag protection

`protection/repositories.json` declares the GitHub rulesets of every repository. `delivery protect --repo <owner/name>`
shows how the live rulesets differ from that declaration, and `--apply` makes them match. To change protection,
edit the file, merge it, and apply again; nothing is configured by hand in GitHub.

| Kind | Ruleset name | What it enforces |
| --- | --- | --- |
| `default-branch` | `protect-<default branch>` | No deletion or force push, pull request required, the repository's test checks plus `delivery / Delivery check`, branch up to date, and the repository admin may bypass for pull requests only. Options: `checks`, `mergeMethods`, `linearHistory`, `delivery: false` until the repository calls the shared workflow. |
| `branch` | `protect-<branch>` | No deletion or force push, for a branch only automation advances. |
| `release-tags` | `protect-release-tags` | No deletion or movement of `v*` tags except by the listed release Apps. |

An existing ruleset that governs the same refs is renamed and updated in place. An older classic branch protection
rule on a declared branch is removed once the ruleset is confirmed active. A ruleset that is not declared is
reported and left alone.

## Layout

- `scripts/` - the automation, imported from `timurproko/a1` and made repository-independent.
- `.github/workflows/delivery.yml` - the reusable workflow callers use: promote and finalize, delivery check,
  ready-PR refresh, merged-branch deletion.
- `skills/change-delivery/` - the one agent skill for every repository.
- `bin/delivery.mjs` - the local command.
- `templates/` - files a repository copies when it adopts the workflow.
- `test/` - `npm test`.

## Status

In use by `timurproko/a1`, `timurproko/xrbuild` and its private workspace repository. Covered: promotion and
finalization, the delivery check, ready-PR refresh, merged-branch deletion, plain delivery without OpenSpec, the
shared skill, local worktree cleanup and the machine bootstrap.
A repository without OpenSpec gets the same flow: its pull requests leave out the Automation section.
