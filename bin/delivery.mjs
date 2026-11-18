#!/usr/bin/env node
// The local command agents and maintainers use. Every subcommand works from any repository checkout.
import { parseArgs } from "node:util";

const USAGE = `Usage: delivery <command>

  check-body --body-file <path> [--final]   Validate a pull-request body before pushing it
  check-body --pr <number> [--final]        Validate the current body of a pull request
  cleanup [--apply] [--path <worktree>]     Report, or with --apply remove, merged clean worktrees
  protect [--repo <owner/name>] [--apply]   Report, or with --apply set, the rulesets declared for the repository
                                            in protection/repositories.json
  install [--dev]                           Download the shared workflow to ~/.config/git-workflows and link
                                            its skill and this command from there; --dev links this checkout
  update                                    Fast-forward ~/.config/git-workflows now (otherwise hourly)
`;

const [command, ...args] = process.argv.slice(2);

try {
  if (command && command !== "install" && command !== "update") {
    const { refreshManagedCopy } = await import("../scripts/managed-copy.mjs");
    const note = await refreshManagedCopy();
    if (note) console.error(note);
  }
  if (command === "check-body") {
    const { main } = await import("../scripts/check-delivery-body.mjs");
    const result = await main(args);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  } else if (command === "cleanup") {
    const { values } = parseArgs({ args, options: { apply: { type: "boolean" }, path: { type: "string" } } });
    const { cleanupWorktrees, formatReport } = await import("../scripts/worktree-cleanup.mjs");
    console.log(formatReport(await cleanupWorktrees({ apply: Boolean(values.apply), only: values.path ?? null })));
  } else if (command === "protect") {
    const { values } = parseArgs({ args, options: { repo: { type: "string" }, apply: { type: "boolean" } } });
    const { formatProtection, protectRepository } = await import("../scripts/repository-protection.mjs");
    let repository = values.repo;
    if (!repository) {
      const { execFileSync } = await import("node:child_process");
      repository = execFileSync("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], { encoding: "utf8" }).trim();
    }
    console.log(formatProtection(await protectRepository({ repository, apply: Boolean(values.apply) })));
  } else if (command === "install") {
    const { values } = parseArgs({ args, options: { dev: { type: "boolean" } } });
    const { installEverything } = await import("../scripts/install.mjs");
    for (const line of await installEverything({ dev: Boolean(values.dev) })) console.log(line);
  } else if (command === "update") {
    const { refreshManagedCopy } = await import("../scripts/managed-copy.mjs");
    console.log(await refreshManagedCopy({ force: true }));
  } else {
    console.log(USAGE);
    if (command && command !== "help" && command !== "--help") process.exitCode = 2;
  }
} catch (error) {
  console.error(`delivery ${command} failed: ${error.message}`);
  process.exitCode = 2;
}
