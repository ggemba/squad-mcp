#!/usr/bin/env node
// Mirrors bundled agents, shared docs, and skills into the user-scope ~/.claude/ tree.
// The plugin manifest (.claude-plugin/plugin.json) is the canonical distribution path
// when this plugin is enabled in Claude Code; this script is the fallback for users
// running the package without the plugin (Claude Desktop, Cursor, Warp, manual setup).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const HOME = process.env.USERPROFILE || process.env.HOME;
if (!HOME) {
  console.error('No USERPROFILE/HOME environment variable set; cannot resolve target directory.');
  process.exit(1);
}
const userClaudeDir = path.join(HOME, '.claude');

const bundleDir = path.resolve('agents');
const targetDir = path.join(userClaudeDir, 'agents');

const SYNC_MAP = [
  { bundle: 'PO.md', target: 'product-owner.md', name: 'product-owner', defaultDesc: 'Product Owner. Validates business value, functional requirements, and UX. Use for features, business-rule changes, and user-facing surfaces.' },
  { bundle: 'Senior-Architect.md', target: 'senior-architect.md', name: 'senior-architect', defaultDesc: 'Senior Architect. Guards module boundaries, coupling, dependency direction, DI lifetimes, and scalability. Use for structural changes and new modules.' },
  { bundle: 'Senior-DBA.md', target: 'senior-dba.md', name: 'senior-dba', defaultDesc: 'Senior DBA. Reviews queries, migrations, EF mappings, cache, concurrency, and persistence stack. Use for data-layer changes.' },
  { bundle: 'Senior-Developer.md', target: 'senior-developer.md', name: 'senior-developer', defaultDesc: 'Pragmatic senior developer. Reviews technical correctness, robustness, API contracts, external integrations, observability, and application performance.' },
  { bundle: 'Senior-Dev-Reviewer.md', target: 'senior-dev-reviewer.md', name: 'senior-dev-reviewer', defaultDesc: 'Senior code reviewer. Focuses on readability, code smells, naming, idioms, async/await correctness, and error handling.' },
  { bundle: 'Senior-Dev-Security.md', target: 'senior-dev-security.md', name: 'senior-dev-security', defaultDesc: 'Application security specialist. Finds OWASP Top 10 vulnerabilities, validates authn/authz, sensitive data, input validation, and dependency CVEs.' },
  { bundle: 'Senior-QA.md', target: 'senior-qa.md', name: 'senior-qa', defaultDesc: 'Quality and testing specialist. Assesses coverage, test strategy, reliability, mocks, and missing scenarios.' },
  { bundle: 'TechLead-Planner.md', target: 'tech-lead-planner.md', name: 'tech-lead-planner', defaultDesc: 'Tech lead at plan time. Reviews proposed implementation plans BEFORE execution to catch design mistakes, misplaced complexity, and missing deploy considerations. Use for plan-stage review only — not for line-by-line code review.' },
  { bundle: 'TechLead-Consolidator.md', target: 'tech-lead-consolidator.md', name: 'tech-lead-consolidator', defaultDesc: 'Tech lead AFTER the code is written. Convergence point for advisory reports, arbitrates conflicts, issues the final merge verdict, owns rollback plan and deploy considerations.' },
];

function ensureFrontmatter(existing, name, fallbackDesc) {
  if (!existing) {
    return `---\nname: ${name}\ndescription: ${fallbackDesc}\nmodel: inherit\n---\n\n`;
  }
  const m = existing.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) {
    return `---\nname: ${name}\ndescription: ${fallbackDesc}\nmodel: inherit\n---\n\n`;
  }
  return `---\n${m[1]}\n---\n\n`;
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

let written = 0;
let created = 0;

for (const entry of SYNC_MAP) {
  const bundlePath = path.join(bundleDir, entry.bundle);
  const targetPath = path.join(targetDir, entry.target);
  if (!fs.existsSync(bundlePath)) {
    console.error(`MISSING BUNDLE: ${entry.bundle}`);
    process.exit(1);
  }
  const body = fs.readFileSync(bundlePath, 'utf8');
  const existed = fs.existsSync(targetPath);
  if (existed) {
    // Refuse to write through a symlinked agent destination — symmetric with the
    // skills path. An attacker with write access to ~/.claude/agents/ could plant
    // a symlink to redirect writes; lstat-and-refuse closes that vector.
    const targetLstat = fs.lstatSync(targetPath);
    if (targetLstat.isSymbolicLink()) {
      console.warn(`agent: refusing to write through symlinked destination: ${entry.target} (unlink it first)`);
      continue;
    }
  }
  const existingContent = existed ? fs.readFileSync(targetPath, 'utf8') : null;
  const frontmatter = ensureFrontmatter(existingContent, entry.name, entry.defaultDesc);
  const out = frontmatter + body;
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, out, 'utf8');
  if (existed) {
    written++;
    console.log(`updated: ${entry.target}`);
  } else {
    created++;
    console.log(`created: ${entry.target}`);
  }
}

const sharedDocs = ['_Severity-and-Ownership.md', 'Skill-Squad-Dev.md', 'Skill-Squad-Review.md'];
const sharedTargetDir = path.join(targetDir, '_squad-shared');
fs.mkdirSync(sharedTargetDir, { recursive: true });
for (const doc of sharedDocs) {
  const src = path.join(bundleDir, doc);
  const dst = path.join(sharedTargetDir, doc);
  if (!fs.existsSync(src)) continue;
  // Symmetric symlink defense — refuse to write through symlinks at either
  // end. The shared-doc copy historically used unguarded copyFileSync, which
  // would follow a planted symlink at ~/.claude/agents/_squad-shared/.
  const srcLstat = fs.lstatSync(src);
  if (srcLstat.isSymbolicLink()) {
    console.warn(`shared: refusing to copy symlinked source: ${doc}`);
    continue;
  }
  if (fs.existsSync(dst)) {
    const dstLstat = fs.lstatSync(dst);
    if (dstLstat.isSymbolicLink()) {
      console.warn(`shared: refusing to write through symlinked destination: ${doc} (unlink it first)`);
      continue;
    }
  }
  fs.copyFileSync(src, dst);
  console.log(`shared: ${doc}`);
}

// Skills sync. Whole-directory copy with recursive walk. Uses a baseline-hash
// store (`<skillsTargetDir>/.bundle-hashes.json`) to distinguish three states:
//   1. destination matches current bundle hash       -> identical, no-op
//   2. destination matches stored baseline hash      -> stale prior bundle, overwrite (skillsUpdated++)
//   3. destination matches neither                   -> user-modified, skip with warning (skillsSkipped++)
// Without the baseline, legitimate bundle updates would be misclassified as
// user edits and silently skipped after the first install.
const skillsBundleDir = path.resolve('skills');
const skillsTargetDir = path.join(userClaudeDir, 'skills');
// MIGRATION CONSTRAINT: this path is part of the installer's persistent state
// contract. Changing skillsTargetDir or BASELINE_FILE in a future version
// requires migration logic that reads the old file, re-keys entries to the new
// label scheme if changed, writes the new file, then deletes the old one.
// Without migration, all skills would be reclassified as user-modified.
const BASELINE_FILE = path.join(skillsTargetDir, '.bundle-hashes.json');
const BASELINE_SCHEMA_VERSION = 1;
let skillsCreated = 0;
let skillsUpdated = 0;
let skillsSkipped = 0;
let skillsFailed = 0;

function loadBaselines() {
  if (!fs.existsSync(BASELINE_FILE)) return {};
  let stat;
  try {
    stat = fs.lstatSync(BASELINE_FILE);
  } catch {
    return {};
  }
  if (stat.isSymbolicLink()) {
    console.warn(`baseline: refusing to read through symlinked file: ${BASELINE_FILE}`);
    return {};
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8'));
  } catch (err) {
    console.warn(`baseline: file unreadable, treating all destinations as user-modified: ${BASELINE_FILE} (${err.message})`);
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  // Versioned envelope: { version: N, baselines: { ... } }. Older flat-map files
  // (no `version` key) are accepted for backward compat with v0.4.0-pre installs.
  if (typeof parsed.version === 'number' && parsed.baselines && typeof parsed.baselines === 'object') {
    return parsed.baselines;
  }
  return parsed;
}

function saveBaselines(state) {
  try {
    fs.mkdirSync(skillsTargetDir, { recursive: true });
    // Refuse to follow a symlinked baseline file. Symmetric with loadBaselines.
    if (fs.existsSync(BASELINE_FILE)) {
      const stat = fs.lstatSync(BASELINE_FILE);
      if (stat.isSymbolicLink()) {
        console.warn(`baseline: refusing to write through symlinked file: ${BASELINE_FILE}`);
        return;
      }
    }
    // Atomic write: temp file with O_EXCL, then rename. The rename is atomic on
    // POSIX and NTFS; partial writes never corrupt the live file.
    const sortedBaselines = Object.fromEntries(Object.entries(state).sort());
    const envelope = { version: BASELINE_SCHEMA_VERSION, baselines: sortedBaselines };
    const body = JSON.stringify(envelope, null, 2) + '\n';
    const tmpFile = BASELINE_FILE + '.tmp';
    try { fs.unlinkSync(tmpFile); } catch { /* may not exist */ }
    fs.writeFileSync(tmpFile, body, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    fs.renameSync(tmpFile, BASELINE_FILE);
  } catch (err) {
    console.error(`baseline: save failed: ${err.message}`);
  }
}

const baselines = loadBaselines();

function hasPathSeparator(name) {
  return name.includes('/') || name.includes('\\');
}

function copyFileWithGuard(srcPath, dstPath, label) {
  // Reject symlinks at the source. lstat avoids following the link.
  const srcLstat = fs.lstatSync(srcPath);
  if (srcLstat.isSymbolicLink()) {
    console.warn(`skill: refusing to copy symlinked source: ${label} (${srcPath})`);
    skillsFailed++;
    return;
  }
  const srcBuf = fs.readFileSync(srcPath);
  const srcHash = sha256(srcBuf);

  if (fs.existsSync(dstPath)) {
    const dstLstat = fs.lstatSync(dstPath);
    if (dstLstat.isSymbolicLink()) {
      console.warn(`skill: refusing to write through symlinked destination: ${label} (${dstPath}). Unlink it first.`);
      skillsFailed++;
      return;
    }
    const dstHash = sha256(fs.readFileSync(dstPath));
    if (srcHash === dstHash) {
      baselines[label] = srcHash; // keep baseline current even when identical
      return;
    }
    const baseline = baselines[label];
    if (baseline && dstHash === baseline) {
      // Stale prior-bundle copy. User has not edited it; safe to overwrite.
      fs.copyFileSync(srcPath, dstPath);
      baselines[label] = srcHash;
      skillsUpdated++;
      console.log(`skill: updated: ${label}`);
      return;
    }
    // Destination differs from current bundle AND from last known baseline.
    // Treat as user-modified and preserve.
    console.warn(`skill: skipped (user-modified, hash differs): ${label}. Delete it to receive updates.`);
    skillsSkipped++;
    return;
  }
  fs.mkdirSync(path.dirname(dstPath), { recursive: true });
  // COPYFILE_EXCL fails if the destination races into existence between the
  // existsSync check and the copy. On EEXIST we fall back to the full guard.
  try {
    fs.copyFileSync(srcPath, dstPath, fs.constants.COPYFILE_EXCL);
  } catch (err) {
    if (err && err.code === 'EEXIST') {
      copyFileWithGuard(srcPath, dstPath, label);
      return;
    }
    throw err;
  }
  baselines[label] = srcHash;
  skillsCreated++;
  console.log(`skill: created: ${label}`);
}

function walkSkillDir(srcDir, dstDir, prefix) {
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    // Defensive: Dirent.name is leaf-only by Node contract, but reject anything
    // that smuggles a path separator on either platform. Match the top-level
    // loop's behavior: warn and increment skillsFailed so anomalies are
    // observable.
    if (entry.name === '.' || entry.name === '..' || hasPathSeparator(entry.name)) {
      console.error(`skill: refusing entry with separator or dot-name: ${prefix}/${entry.name}`);
      skillsFailed++;
      continue;
    }
    const srcPath = path.join(srcDir, entry.name);
    const dstPath = path.join(dstDir, entry.name);
    const label = `${prefix}/${entry.name}`;
    if (entry.isSymbolicLink()) {
      // Dirent.isFile()/isDirectory() return false for symlinks, so without an
      // explicit branch the symlink leaf would silently disappear from the sync.
      console.warn(`skill: refusing symlink leaf: ${label}`);
      skillsFailed++;
      continue;
    }
    if (entry.isDirectory()) {
      fs.mkdirSync(dstPath, { recursive: true });
      walkSkillDir(srcPath, dstPath, label);
    } else if (entry.isFile()) {
      copyFileWithGuard(srcPath, dstPath, label);
    }
  }
}

if (fs.existsSync(skillsBundleDir)) {
  const skillsTargetPrefix = skillsTargetDir.endsWith(path.sep)
    ? skillsTargetDir
    : skillsTargetDir + path.sep;
  for (const skill of fs.readdirSync(skillsBundleDir, { withFileTypes: true })) {
    if (!skill.isDirectory()) continue;
    if (hasPathSeparator(skill.name) || skill.name === '.' || skill.name === '..') {
      console.error(`skill: refusing escape via name: ${skill.name}`);
      skillsFailed++;
      continue;
    }
    const srcDir = path.join(skillsBundleDir, skill.name);
    const dstDir = path.join(skillsTargetDir, skill.name);
    // Containment assert: refuse any skill name whose join escapes the target root.
    const resolvedDst = path.resolve(dstDir);
    if (!resolvedDst.startsWith(skillsTargetPrefix)) {
      console.error(`skill: refusing escape via name: ${skill.name} -> ${resolvedDst}`);
      skillsFailed++;
      continue;
    }
    try {
      walkSkillDir(srcDir, dstDir, skill.name);
    } catch (err) {
      skillsFailed++;
      console.error(`skill: ${skill.name} failed: ${err.message}`);
    }
  }
  saveBaselines(baselines);
} else {
  console.log('skills/ bundle directory not found, skipping skill sync.');
}

const skillsWritten = skillsCreated + skillsUpdated;
console.log(
  `\nsync complete: ${created} agents created, ${written} agents updated, ` +
  `${skillsWritten} skill files written (${skillsCreated} created, ${skillsUpdated} updated, ${skillsSkipped} skipped, ${skillsFailed} failed), ` +
  `agents target=${targetDir}, skills target=${skillsTargetDir}`
);

if (skillsFailed > 0) {
  process.exitCode = 1;
}
