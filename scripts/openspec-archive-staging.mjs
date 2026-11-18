import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { archiveFailure, assertRepositoryPath, SHA } from "./openspec-archive-policy.mjs";

const execute = promisify(execFile);
const MAX_BLOB = 8 * 1024 * 1024;
const MAX_TREE = 32 * 1024 * 1024;
export const OPENSPEC_VERSION = "1.11.0";

export async function loadArchiveTool(packageRoot, { deadline = Infinity } = {}) {
  const root = resolve(packageRoot);
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  if (pkg.name !== "@fission-ai/openspec" || pkg.version !== OPENSPEC_VERSION) throw archiveFailure("openspec-version");
  const parser = await import(pathToFileURL(join(root, "dist/core/parsers/requirement-blocks.js")).href);
  const apply = await import(pathToFileURL(join(root, "dist/core/specs-apply.js")).href);
  const fences = await import(pathToFileURL(join(root, "dist/core/parsers/code-fence.js")).href);
  const yaml = createRequire(join(root, "package.json"))("yaml");
  async function command(cwd, args) {
    // Security: candidate configuration cannot inherit tokens, registered stores, or code-loading flags.
    const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: tmpdir(), TMP: tmpdir(),
      HOME: join(cwd, ".tool-home"), USERPROFILE: join(cwd, ".tool-home"), XDG_CONFIG_HOME: join(cwd, ".tool-home"),
      NO_COLOR: "1", CI: "true", OPENSPEC_TELEMETRY: "0" };
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw archiveFailure("archive-deadline");
    try {
      const result = await execute(process.execPath, [join(root, "bin/openspec.js"), ...args], { cwd, env, timeout: Math.min(30_000, remaining), maxBuffer: MAX_BLOB });
      return args.includes("--json") ? JSON.parse(result.stdout) : result.stdout;
    } catch { throw archiveFailure("openspec-operation", args[0]); }
  }
  return { ...parser, ...apply, ...fences, yaml, command };
}

export async function snapshotOpenSpec(reader, sha) {
  const response = await reader.get(`${reader.prefix}/git/trees/${sha}?recursive=1`);
  if (response.truncated || !Array.isArray(response.tree) || response.tree.length > 20_000) throw archiveFailure("repository-tree");
  const entries = new Map();
  for (const item of response.tree.filter(item => item.path === "openspec" || item.path.startsWith("openspec/"))) {
    assertRepositoryPath(item.path);
    if (!SHA.test(item.sha ?? "") || !(item.type === "tree" && item.mode === "040000"
      || item.type === "blob" && ["100644", "100755"].includes(item.mode))) throw archiveFailure("unsafe-openspec-tree");
    if (item.type === "blob") entries.set(item.path, item.sha);
  }
  const cache = new Map();
  let bytes = 0;
  async function blob(path) {
    const id = entries.get(path);
    if (!id) return null;
    if (!cache.has(id)) {
      const value = await reader.get(`${reader.prefix}/git/blobs/${id}`);
      if (value.encoding !== "base64" || value.size > MAX_BLOB || typeof value.content !== "string") throw archiveFailure("spec-blob");
      const data = Buffer.from(value.content, "base64");
      if (data.length !== value.size || data.length > MAX_BLOB || (bytes += data.length) > MAX_TREE) throw archiveFailure("spec-blob-size");
      const hash = createHash("sha1").update(`blob ${data.length}\0`).update(data).digest("hex");
      if (hash !== id) throw archiveFailure("spec-blob-identity");
      cache.set(id, data);
    }
    return cache.get(id);
  }
  return { entries, blob };
}
