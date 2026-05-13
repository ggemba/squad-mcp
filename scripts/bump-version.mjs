// Bump every version pin the release workflow verifies, in one shot.
//
// The release.yml "verify version matches tag" step compares the git tag
// against four files. They drift trivially if you bump them by hand and
// the CI fails the publish — see commit 387fdf6 (chore(release): 1.0.1)
// for the original incident.
//
// Usage:
//   node scripts/bump-version.mjs <new-version>
//   npm run bump-version -- 1.2.3
//
// Validates SemVer (X.Y.Z, optional -prerelease), rewrites the four pins,
// and prints a summary. Does NOT touch git — commit and tag yourself.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

const newVersion = process.argv[2];
if (!newVersion) {
  console.error("usage: node scripts/bump-version.mjs <new-version>");
  process.exit(2);
}
if (!SEMVER.test(newVersion)) {
  console.error(`error: "${newVersion}" is not a valid SemVer (X.Y.Z[-pre])`);
  process.exit(2);
}

function rewriteJson(relPath, mutate) {
  const abs = resolve(repoRoot, relPath);
  const raw = readFileSync(abs, "utf8");
  const data = JSON.parse(raw);
  const before = JSON.stringify(data);
  mutate(data);
  const after = JSON.stringify(data);
  if (before === after) {
    console.log(`= ${relPath} (unchanged)`);
    return;
  }
  // Preserve trailing newline if the source had one.
  const trailing = raw.endsWith("\n") ? "\n" : "";
  writeFileSync(abs, JSON.stringify(data, null, 2) + trailing);
  console.log(`+ ${relPath} -> ${newVersion}`);
}

function rewriteServerVersion() {
  const relPath = "src/index.ts";
  const abs = resolve(repoRoot, relPath);
  const raw = readFileSync(abs, "utf8");
  const re = /const SERVER_VERSION = "[^"]+";/;
  if (!re.test(raw)) {
    console.error(`error: could not find SERVER_VERSION declaration in ${relPath}`);
    process.exit(1);
  }
  const next = raw.replace(re, `const SERVER_VERSION = "${newVersion}";`);
  if (next === raw) {
    console.log(`= ${relPath} (unchanged)`);
    return;
  }
  writeFileSync(abs, next);
  console.log(`+ ${relPath} -> ${newVersion}`);
}

rewriteJson("package.json", (d) => {
  d.version = newVersion;
});
rewriteJson(".claude-plugin/plugin.json", (d) => {
  d.version = newVersion;
});
rewriteJson(".claude-plugin/marketplace.json", (d) => {
  if (!Array.isArray(d.plugins) || d.plugins.length === 0) {
    console.error("error: .claude-plugin/marketplace.json has no plugins[]");
    process.exit(1);
  }
  for (const p of d.plugins) p.version = newVersion;
});
rewriteServerVersion();

console.log(`\nbumped to ${newVersion}. next steps:`);
console.log("  - update CHANGELOG.md");
console.log(`  - git commit -am "chore(release): ${newVersion}"`);
console.log(`  - git tag v${newVersion} && git push origin main v${newVersion}`);
