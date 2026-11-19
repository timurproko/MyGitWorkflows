---
name: change-delivery
description: How to deliver any change to a repository through its pull-request flow - own worktree and branch, plan first as a draft PR, implementation after approval, ticking outcomes as they land, automatic readiness and OpenSpec finalization, handoff, merge rules and local cleanup. Use whenever asked to make, fix, plan or ship a change in a repository (code, docs, specs or CI), and before opening, updating, merging or cleaning up after a pull request.
---

# Change delivery

One workflow for every repository. The repository holds code and, if it uses them, OpenSpec specs; it holds no
workflow rules. Repository instructions (`AGENTS.md`, `CLAUDE.md`) still apply for everything that is about the
code itself, and they win where they are stricter than this skill.

This skill and the `delivery` command are read from one managed copy at `~/.workflow`, which
updates itself at most hourly whenever `delivery` runs. Run `delivery update` once before starting a task so
the rules you follow are current. The command works in any repository: `delivery check-body`,
`delivery cleanup`. The target branch is always the repository's default branch
(`gh repo view --json defaultBranchRef --jq .defaultBranchRef.name`); never assume its name.

## Who does what

| Step | Owner |
| --- | --- |
| Plan, code, tests, ticking outcomes, pushing | Agent |
| Marking a linked PR ready, finalizing its OpenSpec change, refreshing ready PRs, deleting merged branches | Delivery bot |
| Approving the plan, merging or arming auto-merge | Maintainer |

Never mark a PR ready yourself. Never arm auto-merge. Never push to the default
branch. Implementation approval is not merge permission.

## 1. Start

- Keep the primary checkout on the default branch. Do the work in its own worktree and branch:
  in an A1 session use `a1 worktree enter <branch>`; otherwise
  `git worktree add .worktrees/<short-name> -b <type>/<short-name> origin/<default-branch>`.
- Branches are `type/short-description` with `feature`, `fix`, `refactor`, `docs`, `test`, `chore` or `style`.
  Commits and PR titles are `type(scope): subject`; the PR title becomes the squash commit.
- Scratch files (PR bodies, logs, patches) go in the worktree's ignored `.artifacts/`, never the system temp
  folder, the home folder or another checkout.
- Continue an existing task in its existing worktree, branch and PR. One task, one PR.

## 2. Plan as a draft PR

A change that needs a plan (new behaviour, a spec change, anything beyond a small fix) starts as an OpenSpec change
in `openspec/changes/<change-id>/` when the repository has an `openspec/` folder. Write `tasks.md` as one task
group per Implementation outcome, in the same order.

Commit the plan, push, and open a **draft** PR to the default branch with the body in a file
(`gh pr create --draft --body-file .artifacts/pr-body.md`):

````markdown
## Proposal

One or two sentences: what changes and why.

## Implementation

- [ ] First delivered outcome, written as a result.
- [ ] Second delivered outcome, written as a result.

## Automation

<details>
<summary>Used by CI to link this PR to its OpenSpec change</summary>

```openspec-implementation
{
  "version": 3,
  "change": "<change-id>"
}
```

</details>
````

Body rules, enforced by the bot:

- `## Proposal` is the first line. Sections appear in exactly this order; `## Acceptance` is added later.
- Proposal: one or two sentences, no bullets or headings.
- Implementation: at least one checkbox, each one line of 20 to 300 bytes naming a delivered code outcome.
  No duplicates, URLs, `@` mentions, HTML or angle-bracket placeholders. No generic items (CI, review, merge).
  No item that starts with Manually, Validate, Verify, Confirm, Prove, Run or Test, or that is about evidence
  or manual testing.
- The Automation block keeps that exact summary line. A repository without OpenSpec, or a PR that implements
  no change, omits the whole Automation section.

Then hand off and **stop**. Implement only after the maintainer approves the plan and asks for the
implementation. One explicit instruction can do both for a plan already presented; ask only about a decision
that is really missing.

## 3. Implement, one outcome at a time

Work one Implementation outcome at a time: write its code and tests, tick its `tasks.md` tasks, commit and push,
then tick that outcome in the PR body (`[ ]` to `[x]`, nothing else) before starting the next one.

- A tick means the code and tests are written. CI, broad test runs and manual validation never delay it; a later
  defect is fixed in a new commit. Never save ticks for handoff, and never tick unfinished work.
- Adding, removing, reordering or rewording an outcome is a scope change: get approval and update the plan first.
- Before pushing, run only quick targeted checks of what changed. Do not loop broad local suites; CI on the
  final head is the integration gate.

## 4. Finish

Before ticking the **last** outcome:

1. Finish all tasks; state each known gap and what happens to it.
2. Add `## Acceptance` before `## Automation`: one to ten plain bullets (not checkboxes) saying what now holds,
   specific to this change, each one line of 20 to 300 bytes with the same content rules as Implementation.
3. Bring the branch up to date with the default branch and push.
4. Check the final body: `delivery check-body --body-file .artifacts/pr-body.md --final`.

Then tick the last outcome. That ends the agent's part. The bot verifies the exact snapshot and marks the PR
ready, then commits `docs(openspec): finalize <change-id>` to the branch and records the archive in the
Automation block. Always `git pull` before pushing again; never revert a finalization commit, push fixes on top.
A fully ticked draft that stays draft means the bot refused it: read the `Delivery` workflow run for the reason.

A PR that links no change follows the same steps with the Automation section left out: the bot marks it ready
when every outcome is ticked and the body is valid, and there is nothing to finalize.

## 5. CI and handoff

- Drafts run no test suites. The ready, finalized head gets the repository's tests plus the `Delivery check`.
- Do not watch CI in the foreground. Read its current result, report it, and repair failures in the same PR
  without weakening a test or a check.
- Hand off after pushing a plan, after CI is green, and after any repair push: worktree path, branch, commit,
  change, PR, behaviour, known gaps, and one command the maintainer can run. Say when nothing is runnable.

## 6. Merge

The maintainer merges, or arms auto-merge. An agent merges only when the maintainer explicitly asks, in the
current conversation, to merge one identified PR. That request is one-shot: it is not remembered, and green CI
or an earlier approval is not a request.

Immediately before merging, re-read the PR and require: open, not draft, into the default branch, mergeable,
every required check successful on the current head, and that head finalized if it links a change. Then:

```bash
gh pr merge <pr> --squash --match-head-commit <exact-head-sha>
```

No `--admin`, no `--auto`, no waiting or retrying later. If anything is not satisfied, report the blocker and
stop; a new attempt needs a new request.

## 7. After the merge

- The bot deletes the branch of a merged PR, and of a PR closed without merging. To continue closed work, use
  "Restore branch" on the PR page before reopening it.
- Verify the PR merged and, for a linked change, that its archive and synced specs are on the default branch.
  Never edit a merged PR's body.
- In an A1 session still attached to the merged task, run `a1 worktree complete`: it returns the session to the
  primary checkout and then runs the repository's cleanup, so never clean the attached checkout yourself. Stay
  attached until then; `a1 worktree detach` is only for switching tasks or an explicit request.
- Otherwise leave the worktree first, then from the primary checkout run `delivery cleanup` to see what would be
  removed and `delivery cleanup --apply` to remove it.
- Cleanup removes a worktree and its local branch only when its PR merged and the checkout holds nothing else.
  It keeps anything with uncommitted or untracked files, unmerged commits, a `.artifacts/KEEP` marker or a
  separate Git repository inside it, and says why. Never delete a kept worktree by hand or with force; report
  the reason instead. Put a `.artifacts/KEEP` file in a worktree whose ignored files must survive.

## Always

- No AI attribution, for every agent (Claude, Copilot, Cursor, Codex and any other): commit as the maintainer's
  configured Git identity, never as the agent. No `Co-Authored-By` trailer naming a model, agent or vendor, and
  no "Generated with" line, in commits, PR titles or PR bodies. A squash merge copies every branch author into
  the merged commit, so one agent-authored commit puts the agent in the repository's contributors permanently.
  The `Delivery check` fails with `agent-attribution` when it finds one: rewrite those commits under the
  maintainer's identity without the trailer and push with `--force-with-lease`. This is the one case where
  rewriting pushed history is allowed, and never after the bot's finalization commit without pulling it first.
- A command for the maintainer to run is exactly one Git Bash line in one fenced block, starting with
  `cd <absolute path> && ...`, with forward-slash paths.
- Protect uncommitted and unpublished work, other tasks' worktrees and the primary checkout. Respect locks
  and reported blockers.
