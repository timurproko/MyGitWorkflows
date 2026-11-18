#!/usr/bin/env node
// The local command agents and maintainers use. Every subcommand works from any repository checkout.
import { parseArgs } from "node:util";

const USAGE = `Usage: delivery <command>

  check-body --body-file <path> [--final]   Validate a pull-request body before pushing it
  check-body --pr <number> [--final]        Validate the current body of a pull request
  cleanup [--apply] [--path <worktree>]     Report, or with --apply remove, merged clean worktrees
  install                                   Link the shared skill into the user-level agent folders
`;

const [command, ...args] = process.argv.slice(2);

try {
  if (command === "check-body") {
    const { main } = await import("../scripts/check-delivery-body.mjs");
    const result = await main(args);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  } else if (command === "cleanup") {
    const { values } = parseArgs({ args, options: { apply: { type: "boolean" }, path: { type: "string" } } });
    const { cleanupWorktrees, formatReport } = await import("../scripts/worktree-cleanup.mjs");
    console.log(formatReport(await cleanupWorktrees({ apply: Boolean(values.apply), only: values.path ?? null })));
  } else if (command === "install") {
    const { install } = await import("../scripts/install.mjs");
    for (const line of await install()) console.log(line);
  } else {
    console.log(USAGE);
    if (command && command !== "help" && command !== "--help") process.exitCode = 2;
  }
} catch (error) {
  console.error(`delivery ${command} failed: ${error.message}`);
  process.exitCode = 2;
}
