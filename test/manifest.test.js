import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const readText = (relative) => readFileSync(join(root, relative), "utf8");
const readJson = (relative) => JSON.parse(readText(relative));
const pkg = readJson("package.json");

function headingsOf(text) {
  return text.split(/\r?\n/u)
    .filter((line) => line.startsWith("## "))
    .map((line) => line.slice(3).trim());
}

test("declares an installable bundle with manifest version 1", () => {
  assert.equal(pkg.private, undefined);
  assert.equal(pkg.dsh?.manifestVersion, 1);
  assert.equal(pkg.dsh?.bundle?.patch, "./cordis.patch.yml");
  assert.equal(pkg.dsh?.client, undefined);
  assert.ok(existsSync(join(root, "cordis.patch.yml")));
});

test("pins the verified dsh and node engine ranges", () => {
  assert.equal(pkg.engines?.dsh, ">=0.2.1-rc.2 <0.3.0-0");
  assert.equal(pkg.engines?.node, ">=22.19.0");
});

test("pins official peer ranges to the baseline", () => {
  assert.equal(pkg.peerDependencies?.["@deepseek-ai/cordis"], "~4.0.4");
  assert.equal(pkg.peerDependencies?.["@deepseek-ai/dsh-tools"], ">=0.2.1-0 <0.3.0");
  assert.equal(pkg.dependencies?.["@deepseek-ai/cordis"], undefined);
  assert.equal(pkg.dependencies?.["@deepseek-ai/dsh-tools"], undefined);
});

test("whitelists runtime and display files and publishes to npm", () => {
  for (const entry of [
    "src",
    "cordis.patch.yml",
    "locale",
    "icon.svg",
    "SECURITY.md",
    "README.md",
    "README.zh.md",
    "CHANGELOG.md",
    "LICENSE",
  ]) {
    assert.ok(pkg.files.includes(entry), `files includes ${entry}`);
  }
  for (const entry of pkg.files) {
    assert.equal(entry.startsWith("test"), false);
    assert.equal(entry.startsWith("scripts"), false);
    assert.equal(entry.startsWith(".github"), false);
  }
  assert.equal(pkg.publishConfig?.registry, "https://registry.npmjs.org");
  assert.equal(pkg.publishConfig?.tag, "latest");
  assert.match(pkg.repository?.url ?? "", /github\.com\/NingYuanLee\/dsh-web-fetch-fake-ip/);
  assert.equal(pkg.icon, "./icon.svg");
});

test("publishes non-empty English and Chinese display metadata", () => {
  assert.equal(pkg.exports?.["./locale/*.json"], "./locale/*.json");
  for (const lang of ["en", "zh"]) {
    const meta = readJson(`locale/${lang}.json`).meta;
    assert.equal(typeof meta?.title, "string");
    assert.notEqual(meta.title.trim(), "");
    assert.equal(typeof meta?.description, "string");
    assert.notEqual(meta.description.trim(), "");
  }
});

test("exports an icon within the harness size limit", () => {
  assert.equal(pkg.exports?.["./icon"], "./icon.svg");
  const icon = join(root, "icon.svg");
  assert.ok(existsSync(icon));
  const size = statSync(icon).size;
  assert.ok(size > 0);
  assert.ok(size <= 256 * 1024);
});

test("cordis row id is stable and name is the published package", () => {
  const patch = readText("cordis.patch.yml");
  const escaped = pkg.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assert.match(patch, /id:\s*dsh-web-fetch-fake-ip/);
  assert.match(patch, new RegExp(`name:\\s*"?${escaped}"?`));
});

test("READMEs share level-2 headings and include the install command", () => {
  const english = readText("README.md");
  const chinese = readText("README.zh.md");
  const englishHeadings = headingsOf(english);
  assert.deepEqual(headingsOf(chinese), englishHeadings);
  assert.ok(englishHeadings.length >= 6);
  assert.match(english, /dsh plugin --profile web add /);
  assert.match(chinese, /dsh plugin --profile web add /);
  assert.match(english, /dsh plugin --profile web remove /);
  assert.match(chinese, /dsh plugin --profile web remove /);
});
