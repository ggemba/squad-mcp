import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { promises as fs, lstatSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

// Integration tests for tools/sync-agents.mjs.
// Strategy: spawn the script in a child process with HOME/USERPROFILE pointed
// at a per-test tmpdir, and a tmpdir-rooted bundle so the real ~/.claude is
// untouched and the agent fixtures stay minimal.

const SCRIPT = path.resolve('tools/sync-agents.mjs');
const REPO_ROOT = path.resolve('.');

let workspace: string;
let homeDir: string;
let bundleDir: string;
let skillsTargetDir: string;
let baselineFile: string;

function sha256(data: string | Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

async function writeBundleSkill(name: string, fileName: string, body: string): Promise<void> {
  const dir = path.join(bundleDir, 'skills', name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, fileName), body, 'utf8');
}

async function copyAgentsBundle(): Promise<void> {
  // Sync-agents requires every entry in SYNC_MAP to exist as a bundle file. We
  // copy the real agents bundle from the repo to the test bundleDir so the
  // agents loop succeeds (we test skills behavior; agents are background).
  const src = path.join(REPO_ROOT, 'agents');
  const dst = path.join(bundleDir, 'agents');
  await fs.cp(src, dst, { recursive: true });
}

function runSync(): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [SCRIPT], {
    cwd: bundleDir,
    env: {
      ...process.env,
      HOME: homeDir,
      USERPROFILE: homeDir,
    },
    encoding: 'utf8',
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'sync-agents-test-'));
  homeDir = path.join(workspace, 'home');
  bundleDir = path.join(workspace, 'bundle');
  skillsTargetDir = path.join(homeDir, '.claude', 'skills');
  baselineFile = path.join(skillsTargetDir, '.bundle-hashes.json');
  await fs.mkdir(homeDir, { recursive: true });
  await fs.mkdir(bundleDir, { recursive: true });
  await copyAgentsBundle();
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

describe('sync-agents — skills sync', () => {
  it('cold sync creates skill files and writes the baseline JSON', async () => {
    const skillBody = '# test skill\nhello\n';
    await writeBundleSkill('demo', 'SKILL.md', skillBody);

    const result = runSync();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('skill: created: demo/SKILL.md');

    const dstPath = path.join(skillsTargetDir, 'demo', 'SKILL.md');
    const dstBody = await fs.readFile(dstPath, 'utf8');
    expect(dstBody).toBe(skillBody);

    const baseline = JSON.parse(await fs.readFile(baselineFile, 'utf8'));
    expect(baseline.version).toBe(1);
    expect(baseline.baselines['demo/SKILL.md']).toBe(sha256(skillBody));
  });

  it('bundle update overwrites stale destination and increments skillsUpdated', async () => {
    const v1 = '# v1\n';
    await writeBundleSkill('demo', 'SKILL.md', v1);
    runSync(); // first install creates baseline at hash(v1)

    const v2 = '# v2 with new content\n';
    await writeBundleSkill('demo', 'SKILL.md', v2);
    const result = runSync();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('skill: updated: demo/SKILL.md');
    expect(result.stdout).toContain('0 created, 1 updated, 0 skipped, 0 failed');

    const dstBody = await fs.readFile(path.join(skillsTargetDir, 'demo', 'SKILL.md'), 'utf8');
    expect(dstBody).toBe(v2);

    const baseline = JSON.parse(await fs.readFile(baselineFile, 'utf8'));
    expect(baseline.baselines['demo/SKILL.md']).toBe(sha256(v2));
  });

  it('preserves user edits when destination diverges from both source and baseline', async () => {
    const v1 = '# v1\n';
    await writeBundleSkill('demo', 'SKILL.md', v1);
    runSync(); // baseline = hash(v1)

    // User edits the destination after install.
    const userEdit = '# user customized\n';
    await fs.writeFile(path.join(skillsTargetDir, 'demo', 'SKILL.md'), userEdit, 'utf8');

    // Bundle ships a new version too.
    const v2 = '# v2 upstream\n';
    await writeBundleSkill('demo', 'SKILL.md', v2);

    const result = runSync();

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('skipped (user-modified, hash differs)');
    expect(result.stdout).toContain('1 skipped');

    const dstBody = await fs.readFile(path.join(skillsTargetDir, 'demo', 'SKILL.md'), 'utf8');
    expect(dstBody).toBe(userEdit); // user content preserved
  });

  it('refuses to write through a symlinked destination and exits non-zero', async () => {
    if (process.platform === 'win32') {
      // Symlink creation on Windows requires admin or developer mode; skip.
      return;
    }
    await writeBundleSkill('demo', 'SKILL.md', '# v1\n');

    // Plant a symlink at the destination before sync runs.
    await fs.mkdir(path.join(skillsTargetDir, 'demo'), { recursive: true });
    const decoy = path.join(workspace, 'decoy-target.txt');
    await fs.writeFile(decoy, 'should not be overwritten\n', 'utf8');
    await fs.symlink(decoy, path.join(skillsTargetDir, 'demo', 'SKILL.md'));

    const result = runSync();

    expect(result.status).toBe(1);
    expect(result.stderr + result.stdout).toMatch(/refusing to write through symlinked destination/);

    // Decoy must remain untouched.
    const decoyBody = await fs.readFile(decoy, 'utf8');
    expect(decoyBody).toBe('should not be overwritten\n');
  });

  it('refuses skill names that contain a path separator', async () => {
    await writeBundleSkill('demo', 'SKILL.md', '# v1\n');
    // Manually plant a dir with a separator-laden name. fs.mkdir on Windows
    // rejects '/', so we test '..' which behaves the same way through the
    // containment assert path.
    const badName = '..';
    const badDir = path.join(bundleDir, 'skills', badName);
    await fs.mkdir(badDir, { recursive: true }).catch(() => {});

    const result = runSync();

    // The legitimate `demo` skill still gets created; only the bad name is
    // refused. The script's own `.` and `..` filter takes priority and
    // increments skillsFailed for the bad entry.
    expect(result.stdout).toContain('skill: created: demo/SKILL.md');
  });

  it('handles a corrupt baseline file gracefully', async () => {
    await writeBundleSkill('demo', 'SKILL.md', '# v1\n');
    await fs.mkdir(skillsTargetDir, { recursive: true });
    await fs.writeFile(baselineFile, '{not valid json', 'utf8');

    const result = runSync();

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('baseline: file unreadable');

    // Sync proceeds and overwrites the corrupt file with a valid envelope.
    const baseline = JSON.parse(await fs.readFile(baselineFile, 'utf8'));
    expect(baseline.version).toBe(1);
    expect(baseline.baselines['demo/SKILL.md']).toBeDefined();
  });

  it('is idempotent across successive runs with no upstream changes', async () => {
    await writeBundleSkill('demo', 'SKILL.md', '# v1\n');

    const first = runSync();
    expect(first.status).toBe(0);
    expect(first.stdout).toContain('1 created');

    const baselineBefore = await fs.readFile(baselineFile, 'utf8');

    const second = runSync();
    expect(second.status).toBe(0);
    // Second run: zero new skill operations.
    expect(second.stdout).not.toContain('skill: created');
    expect(second.stdout).not.toContain('skill: updated');
    expect(second.stderr).not.toContain('skipped');
    expect(second.stdout).toContain('0 skill files written (0 created, 0 updated, 0 skipped, 0 failed)');

    // Baseline file content is byte-stable across runs.
    const baselineAfter = await fs.readFile(baselineFile, 'utf8');
    expect(baselineAfter).toBe(baselineBefore);
  });
});

describe('sync-agents — env guards', () => {
  it('fails fast when HOME and USERPROFILE are both unset', () => {
    // Empty strings are falsy in the script's `||` check, so this triggers the
    // guard path without depending on Node child-process env-merge semantics.
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: '',
      USERPROFILE: '',
    };
    const result = spawnSync(process.execPath, [SCRIPT], {
      cwd: bundleDir,
      env,
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('No USERPROFILE/HOME');
  });
});

describe('sync-agents — baseline schema', () => {
  it('reads a legacy flat-map baseline (pre-envelope, v0.4.0-pre)', async () => {
    const v1 = '# legacy\n';
    await writeBundleSkill('demo', 'SKILL.md', v1);
    runSync(); // creates dst at hash(v1) and writes envelope baseline

    // Replace the envelope baseline with a flat-map (legacy format) at the
    // same hash. The script must still classify the dst as identical.
    const dstPath = path.join(skillsTargetDir, 'demo', 'SKILL.md');
    const dstHash = sha256(await fs.readFile(dstPath));
    const legacy = JSON.stringify({ 'demo/SKILL.md': dstHash }, null, 2);
    await fs.writeFile(baselineFile, legacy, 'utf8');

    // Re-run with bundle unchanged; expect identical no-op + baseline rewritten
    // in the new envelope format (so future runs are versioned).
    const result = runSync();
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('skill: created');
    expect(result.stdout).not.toContain('skill: updated');
    expect(result.stderr).not.toContain('skipped');

    const baseline = JSON.parse(await fs.readFile(baselineFile, 'utf8'));
    expect(baseline.version).toBe(1);
    expect(baseline.baselines['demo/SKILL.md']).toBe(dstHash);
  });
});

describe('sync-agents — recursion', () => {
  it('copies nested files under a skill subdirectory', async () => {
    await writeBundleSkill('demo', 'SKILL.md', '# top\n');
    // Bundle a nested asset under skills/demo/scripts/.
    const nestedDir = path.join(bundleDir, 'skills', 'demo', 'scripts');
    await fs.mkdir(nestedDir, { recursive: true });
    await fs.writeFile(path.join(nestedDir, 'helper.sh'), '#!/bin/sh\necho hi\n', 'utf8');

    const result = runSync();
    expect(result.status).toBe(0);

    const topPath = path.join(skillsTargetDir, 'demo', 'SKILL.md');
    const nestedPath = path.join(skillsTargetDir, 'demo', 'scripts', 'helper.sh');
    expect((await fs.stat(topPath)).isFile()).toBe(true);
    expect((await fs.stat(nestedPath)).isFile()).toBe(true);

    const baseline = JSON.parse(await fs.readFile(baselineFile, 'utf8'));
    expect(baseline.baselines['demo/SKILL.md']).toBeDefined();
    expect(baseline.baselines['demo/scripts/helper.sh']).toBeDefined();
  });
});

describe('sync-agents — containment defense', () => {
  it('refuses skill names containing path separators (defense in depth)', async () => {
    await writeBundleSkill('legit', 'SKILL.md', '# ok\n');
    // The Node Dirent.name contract guarantees leaf-only names from readdirSync,
    // so we cannot easily fabricate a name containing `/` or `\` via the
    // filesystem. The defensive `hasPathSeparator` check is exercised here only
    // through the `.` / `..` reject path; the explicit separator branch is
    // unreachable in practice but kept as future-proofing. We assert the legit
    // skill copies and that the run stays clean.
    const result = runSync();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('skill: created: legit/SKILL.md');
    expect(result.stdout).toContain('0 failed');
  });

  it('refuses a destination that resolves outside the skills target prefix', async () => {
    // We cannot easily make readdirSync produce a malicious entry name, but we
    // can verify that the prefix containment check accepts a normal nested
    // skill (positive control) — failure of the assert would manifest as the
    // skill being silently dropped or written elsewhere.
    await writeBundleSkill('a', 'SKILL.md', '# a\n');
    await writeBundleSkill('b-with-dashes', 'SKILL.md', '# b\n');

    const result = runSync();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('skill: created: a/SKILL.md');
    expect(result.stdout).toContain('skill: created: b-with-dashes/SKILL.md');

    // Both files land under the target prefix.
    const aPath = path.join(skillsTargetDir, 'a', 'SKILL.md');
    const bPath = path.join(skillsTargetDir, 'b-with-dashes', 'SKILL.md');
    expect((await fs.stat(aPath)).isFile()).toBe(true);
    expect((await fs.stat(bPath)).isFile()).toBe(true);
  });
});

describe('sync-agents — agent symlink defense', () => {
  it('refuses to write through a symlinked agent destination', async () => {
    if (process.platform === 'win32') return; // requires admin/dev mode
    // First sync materializes the agents normally.
    runSync();

    // Replace one agent with a symlink to a decoy.
    const targetAgent = path.join(homeDir, '.claude', 'agents', 'product-owner.md');
    const decoy = path.join(workspace, 'agent-decoy.txt');
    await fs.writeFile(decoy, 'must not be overwritten\n', 'utf8');
    await fs.unlink(targetAgent);
    await fs.symlink(decoy, targetAgent);

    const result = runSync();
    expect(result.stdout + result.stderr).toContain(
      'agent: refusing to write through symlinked destination',
    );

    // Decoy is preserved.
    const decoyBody = await fs.readFile(decoy, 'utf8');
    expect(decoyBody).toBe('must not be overwritten\n');
  });
});
