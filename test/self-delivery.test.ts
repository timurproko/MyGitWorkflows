import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

/** A workflow file without its comment lines and its display name. */
const settings = (text: string) => text.replace(/\r\n/g, "\n").split("\n")
  .filter(line => !line.startsWith("#") && !line.startsWith("name: ")).join("\n").trim();

describe("this repository's own delivery", () => {
  it("calls the reusable workflow with the events, permissions and credentials of the caller template", async () => {
    const template = settings(await readFile("templates/delivery-caller.yml", "utf8"));
    const own = settings(await readFile(".github/workflows/self-delivery.yml", "utf8"));
    expect(own).toBe(template.replace("timurproko/MyWorkflows/.github/workflows/delivery.yml@main", "./.github/workflows/delivery.yml"));
  });

  it("skips the credentialed job for Dependabot and still reports the delivery check", async () => {
    const workflow = await readFile(".github/workflows/delivery.yml", "utf8");
    const job = (from: string, to: string) => workflow.slice(workflow.indexOf(`\n  ${from}:`), workflow.indexOf(`\n  ${to}:`));
    expect(job("finalize", "check")).toContain("github.event.pull_request.user.login != 'dependabot[bot]'");
    expect(job("check", "refresh")).not.toContain("dependabot");
  });
});
