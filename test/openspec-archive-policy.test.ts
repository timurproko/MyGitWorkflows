import { describe, expect, it } from "vitest";
import { ARCHIVE_TASKS, archivePaths, assertArchiveDiff, assertRepositoryPath, inspectTasks, metadataBlock, parseImplementation, retiredCapability } from "../scripts/openspec-archive-policy.mjs";

const headSha = "a".repeat(40);
const implementation = { version: 1 as const, change: "example-change", specificationPr: 10 };
const acceptance = {
  version: 1, change: implementation.change, headSha, specBaseSha: "b".repeat(40), verdict: "accepted",
  implementationComplete: true, manualReview: "passed", specSyncReviewed: true, evidence: "Reviewed exact candidate and fixture results.",
};
const block = (name: string, value: unknown) => `\`\`\`${name}\n${JSON.stringify(value)}\n\`\`\``;

describe("archive evidence metadata", () => {

  it("accepts versioned implementation links while preserving legacy linkage", () => {
    const value = { version: 2, change: "example-change" };
    expect(parseImplementation(block("openspec-implementation", value))).toEqual(value);
    expect(parseImplementation(block("openspec-implementation", { ...value, archivePreparationTasks: { stageArchive: "7.2" } }))).toMatchObject({ version: 2 });
    expect(() => parseImplementation(block("openspec-implementation", { ...value, specificationPr: 10 }))).toThrow("metadata-fields");
    expect(() => parseImplementation(block("openspec-implementation", { ...value, version: 1 }))).toThrow("specification-pr");
    const draft = { version: 3, change: "example-change" };
    expect(parseImplementation(block("openspec-implementation", draft))).toEqual(draft);
    const legacyFinalized = { ...draft, archive: "openspec/changes/archive/2026-09-15-example-change/",
      acceptanceManifest: "openspec/changes/archive/2026-09-15-example-change/acceptance.md" };
    expect(parseImplementation(block("openspec-implementation", legacyFinalized))).toEqual(legacyFinalized);
    const finalized = { ...legacyFinalized, finalizedHead: "a".repeat(40) };
    expect(parseImplementation(block("openspec-implementation", finalized))).toEqual(finalized);
    expect(() => parseImplementation(block("openspec-implementation", { ...draft, archive: finalized.archive }))).toThrow("delivery-paths");
    expect(() => parseImplementation(block("openspec-implementation", { ...draft, finalizedHead: finalized.finalizedHead }))).toThrow("delivery-paths");
    expect(() => parseImplementation(block("openspec-implementation", { ...legacyFinalized, finalizedHead: "short" }))).toThrow("delivery-head");
    expect(() => parseImplementation(block("openspec-implementation", { ...finalized, specificationPr: 10 }))).toThrow("metadata-fields");
    expect(() => parseImplementation(block("openspec-implementation", { ...finalized, archivePreparationTasks: {} }))).toThrow("metadata-fields");
    expect(() => parseImplementation(block("openspec-implementation", { ...value, finalizedHead: "a".repeat(40) }))).toThrow("metadata-fields");
  });

  it("rejects duplicate JSON keys, including escaped aliases", () => {
    expect(() => parseImplementation('```openspec-implementation\n{"version":1,"version":2,"change":"example","specificationPr":1}\n```')).toThrow("metadata-duplicate-key");
    expect(() => parseImplementation('```openspec-implementation\n{"version":1,"\\u0076ersion":1,"change":"example","specificationPr":1}\n```')).toThrow("metadata-duplicate-key");
  });

  it("rejects malformed, unclosed, duplicate and oversized metadata", () => {
    expect(() => parseImplementation("```openspec-implementation\n{\n```" )).toThrow("metadata-json");
    expect(() => parseImplementation("```openspec-implementation\n{}" )).toThrow("metadata-unclosed");
    const text = block("openspec-implementation", implementation);
    expect(() => parseImplementation(`${text}\n${text}`)).toThrow("metadata-duplicate");
    expect(() => parseImplementation("x".repeat(256 * 1024 + 1))).toThrow("metadata-size");
    expect(() => metadataBlock(text, "arbitrary.*")).toThrow("metadata-label");
  });

  it.each([
    { ...implementation, version: 2 }, { ...implementation, change: "../unsafe" },
    { ...implementation, change: "valid/other" }, { ...implementation, change: "" },
    { ...implementation, specificationPr: -1 }, { ...implementation, extra: true },
    { ...implementation, archivePreparationTasks: { unknown: "1.1" } },
    { ...implementation, archivePreparationTasks: { recordEvidence: "1.1", stageArchive: "1.1" } },
  ])("rejects invalid implementation identity %#", value => {
    expect(() => parseImplementation(block("openspec-implementation", value))).toThrow();
  });
});

describe("honest task completion", () => {
  const mapping = { recordEvidence: "7.1", stageArchive: "7.2" };
  const text = `## Tasks\n- [x] 1.1 Implement and verify behavior.\n- [ ] 7.1 ${ARCHIVE_TASKS.recordEvidence}\n- [ ] 7.2 ${ARCHIVE_TASKS.stageArchive}\n`;
  it("admits only explicitly designated exact mechanical tasks", () => {
    expect(inspectTasks(text, mapping)).toHaveLength(3);
    expect(() => inspectTasks(text)).toThrow("tasks-incomplete");
    expect(() => inspectTasks(text.replace("- [x] 1.1", "- [ ] 1.1"), mapping)).toThrow("tasks-incomplete");
    expect(() => inspectTasks(text.replace(ARCHIVE_TASKS.recordEvidence, "Record user acceptance and archive."), mapping)).toThrow("task-designation");
  });
  it("refuses fenced task lists and additional conditions hidden under mechanical tasks", () => {
    expect(() => inspectTasks(`\`\`\`markdown\n${text}\`\`\``, mapping)).toThrow("task-in-fence");
    expect(() => inspectTasks(`${text}  Also obtain physical acceptance.\n`, mapping)).toThrow("task-designation-continuation");
  });
  it.each([
    "- [ ] Missing task ID", "- [x] 1.1 Done\n- [ ] 1.1 Duplicate", "- [x] 1.1 Done\n* [ ] 2.1 Hidden",
  ])("refuses ambiguous task syntax: %s", value => {
    expect(() => inspectTasks(value)).toThrow();
  });
});

describe("archive mutation scope", () => {
  it.each(["../escape", "/absolute", "a/../b", "a\\b", "a%2fb", "a//b", "C:/a", "a/.", "a/file.\n"])("rejects unsafe path %s", value => {
    expect(() => assertRepositoryPath(value)).toThrow("unsafe-path");
  });
  it("preserves nested capabilities and avoids doubled dates", () => {
    expect(archivePaths("example", "2026-09-13", ["nested/capability"])).toEqual({
      active: "openspec/changes/example/", archive: "openspec/changes/archive/2026-09-13-example/",
      specs: ["openspec/specs/nested/capability/spec.md"], branch: "docs/archive-example",
    });
    expect(archivePaths("2026-09-12-example", "2026-09-13", []).archive).toBe("openspec/changes/archive/2026-09-12-example/");
  });
  it("admits only selected artifacts and deltas, including both sides of renames", () => {
    const paths = archivePaths("example", "2026-09-13", ["one"]);
    expect(() => assertArchiveDiff([
      { filename: `${paths.archive}.openspec.yaml`, previous_filename: `${paths.active}.openspec.yaml`, status: "renamed" },
      { filename: paths.specs[0]!, status: "modified" },
    ], paths)).not.toThrow();
    for (const filename of ["src/unsafe.ts", "config/baselines/example.json", "openspec/specs/other/spec.md", "openspec/changes/example-other/tasks.md"]) {
      expect(() => assertArchiveDiff([{ filename, status: "modified" }], paths)).toThrow("archive-diff-scope");
      expect(() => assertArchiveDiff([{ filename: `${paths.archive}tasks.md`, previous_filename: filename, status: "renamed" }], paths)).toThrow("archive-diff-scope");
    }
  });
});

describe("capability retirement", () => {
  const removed = "## REMOVED Requirements\n\n### Requirement: Old\n**Reason**: Gone.\n\n**Migration**: None.\n";
  it.each([
    ["a declared retirement whose delta only removes", "schema: spec-driven\nretire_capabilities: true\n", removed, true],
    ["CRLF metadata and delta", "schema: spec-driven\r\nretire_capabilities: true\r\n", removed.replaceAll("\n", "\r\n"), true],
    ["metadata without the declaration", "schema: spec-driven\n", removed, false],
    ["a declaration set to false", "retire_capabilities: false\n", removed, false],
    ["a delta that also adds", "retire_capabilities: true\n", `${removed}\n## ADDED Requirements\n\n### Requirement: New\nThe system SHALL work.\n`, false],
    ["a delta that modifies", "retire_capabilities: true\n", "## MODIFIED Requirements\n\n### Requirement: Old\nThe system SHALL work.\n", false],
    ["a delta without requirement sections", "retire_capabilities: true\n", "# Notes\n", false],
    ["absent metadata", undefined, removed, false],
  ])("treats %s as retired: %s", (_label, metadata, delta, retired) => {
    expect(retiredCapability(metadata, delta)).toBe(retired);
  });
});
