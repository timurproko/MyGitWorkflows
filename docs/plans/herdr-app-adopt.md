# Adopt herdr-app protection

## Proposal

Declare the newly seeded public repository `timurproko/herdr-app` in the shared protection inventory, matching `timurproko/crew`. The application source remains outside this change and will be imported separately.

## Implementation outcomes

1. Herdr app protection matches Crew for required checks, squash-only merges, linear history and delivery events.
   - Add a `timurproko/herdr-app` entry to `protection/repositories.json`, identical to Crew's declaration: `default-branch`, `checks: ["CI required"]`, `mergeMethods: ["squash"]`, `linearHistory: true`.
   - Add `workflow-events` for `.github/workflows/delivery.yml` with `pull_request_target` and `workflow_dispatch`.
   - Extend `test/repository-protection.test.ts` to assert the new declaration matches Crew and builds the expected rules and event policy, including the shared `delivery / Delivery check`.
2. Adoption documentation lists Herdr app among the repositories using the shared workflow.
   - Update the README Status inventory to include `timurproko/herdr-app`, without implying that application source has been imported.

## Targeted checks

- Run `npx vitest run test/repository-protection.test.ts` after implementing the declaration and regression test.
- Review the README change and run `git diff --check`.
- Leave broad integration checks to the pull request workflow.

## Boundaries and prerequisites

- The maintainer approved this plan and implementation was completed in the same pull request.
- Do not apply live protection. The maintainer applies it after this pull request is merged.
- The maintainer has added `DELIVERY_BOT_PRIVATE_KEY` to the target repository; the App installation and `DELIVERY_BOT_APP_ID` were already supplied.
- Do not import application source or read the personal Herdr configuration.
- No OpenSpec folder exists in MyWorkflows, so this plan has no linked OpenSpec change.

## Completed seed prerequisite

The explicitly approved one-time direct push seeded `timurproko/herdr-app` main with commit `85bfcaea7fa850cc836669d2bbd248144be0ce99` (`chore: herdr-app as its own repository`). Author and committer are both `Timur Prokopiev <80062439+timurproko@users.noreply.github.com>`.

The seed includes the unchanged delivery caller and bootstrap templates, generated shared instructions, initialized OpenSpec structure, MIT license, Node scaffold, a placeholder scaffold test, and Crew-style cross-platform CI with a fail-closed `CI required` gate. All six local tests passed. GitHub CI ran on main and failed: Windows Node 20 treated `tests/*.test.mjs` as a literal filename, so the Windows suite and `CI required` failed; Ubuntu, readiness and OpenSpec passed. GitHub CI run: https://github.com/timurproko/herdr-app/actions/runs/44942068687.

The maintainer separately authorized one additional direct commit for the explicit test filenames. Commit `d499702a289dbff145c68bef3dae4f9a9bae02df` changes only the test script to `node --test tests/scaffold.test.mjs scripts/ci-required.test.mjs`, using the same noreply author and committer identity. [CI run 44942352369](https://github.com/timurproko/herdr-app/actions/runs/44942352369) passed all five jobs: readiness, OpenSpec, Windows tests, Ubuntu tests and `CI required`. No history was rewritten.
