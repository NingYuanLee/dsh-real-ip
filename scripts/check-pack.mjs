#!/usr/bin/env node
/**
 * Verify that `npm pack` ships every runtime and metadata file, and nothing
 * that belongs to development only.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

const REQUIRED = [
  "package.json",
  "README.md",
  "README.zh.md",
  "LICENSE",
  "CHANGELOG.md",
  "SECURITY.md",
  "cordis.patch.yml",
  "src/index.js",
  "src/allow.js",
  "src/classify.js",
  "src/real.js",
  "src/dns-patch.js",
  "icon.svg",
  "locale/en.json",
  "locale/zh.json",
];
const FORBIDDEN_PREFIXES = ["test/", "scripts/", ".github/", "node_modules/", ".local/"];

const result = spawnSync(npm, ["pack", "--dry-run", "--json"], {
  cwd: root,
  encoding: "utf8",
  shell: process.platform === "win32",
  maxBuffer: 16 * 1024 * 1024,
});

if (result.status !== 0) {
  process.stderr.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  throw new Error(`npm pack --dry-run failed with exit code ${String(result.status)}`);
}

const report = JSON.parse(result.stdout);
const files = new Set((report[0]?.files ?? []).map((file) => file.path));
const problems = [];
for (const required of REQUIRED) {
  if (!files.has(required)) problems.push(`missing from the tarball: ${required}`);
}
for (const path of files) {
  if (FORBIDDEN_PREFIXES.some((prefix) => path.startsWith(prefix) || path.includes(`/${prefix}`))) {
    problems.push(`development-only file shipped: ${path}`);
  }
}

if (problems.length > 0) {
  process.stderr.write(`check-pack: ${problems.join("\ncheck-pack: ")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`check-pack: ok (${String(files.size)} files, ${pkg.name}@${pkg.version})\n`);
}
