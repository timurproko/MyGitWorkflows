import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE = "@fission-ai/openspec";
const MANIFEST = resolve(dirname(fileURLToPath(import.meta.url)), "..", "package.json");

/** The one OpenSpec version every repository and the delivery bot use: the exact version this repository pins. */
export async function openspecVersion(manifest = MANIFEST) {
  const version = JSON.parse(await readFile(manifest, "utf8")).dependencies?.[PACKAGE];
  if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) throw new Error(`${PACKAGE} must be pinned to an exact version in package.json`);
  return version;
}

/** Run the OpenSpec command line at that version in the current folder. Returns its exit status. */
export async function runOpenspec(args, { run = spawnSync } = {}) {
  const version = await openspecVersion();
  const result = run("npx", ["--yes", `${PACKAGE}@${version}`, ...args], { stdio: "inherit", shell: process.platform === "win32" });
  return result.status ?? 1;
}
