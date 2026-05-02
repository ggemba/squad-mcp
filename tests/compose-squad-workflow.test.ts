import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DetectChangedFilesOutput } from '../src/tools/detect-changed-files.js';

vi.mock('../src/tools/detect-changed-files.js', () => ({
  detectChangedFiles: vi.fn(),
}));

import { detectChangedFiles } from '../src/tools/detect-changed-files.js';
import { composeSquadWorkflow } from '../src/tools/compose-squad-workflow.js';

const detectChangedFilesMock = detectChangedFiles as unknown as ReturnType<typeof vi.fn>;

const baseChanged: DetectChangedFilesOutput = {
  files: [
    { path: 'src/auth/jwt-validator.ts', status: 'modified', raw_status: 'M' },
    { path: 'src/services/payment-processor.ts', status: 'added', raw_status: 'A' },
    { path: 'src/repositories/order-repository.ts', status: 'modified', raw_status: 'M' },
  ],
  base_ref: 'HEAD~1',
  staged_only: false,
  invocation: 'git diff --name-status --no-renames HEAD~1..HEAD',
};

beforeEach(() => {
  detectChangedFilesMock.mockReset();
});

describe('composeSquadWorkflow', () => {
  it('runs full pipeline and returns aggregated output', async () => {
    detectChangedFilesMock.mockResolvedValue(baseChanged);

    const out = await composeSquadWorkflow({
      workspace_root: 'C:/fake/workspace',
      user_prompt: 'fix authentication bug in JWT validator',
      base_ref: 'main',
      staged_only: false,
      read_content: false,
      force_agents: [],
    });

    expect(out.changed_files).toBe(baseChanged);
    expect(out.classification.work_type).toBe('Bug Fix');
    expect(out.work_type).toBe(out.classification.work_type);
    expect(out.risk).toBeDefined();
    expect(out.squad).toBeDefined();
    expect(out.squad.agents).toEqual(expect.arrayContaining(['senior-developer', 'senior-qa']));
  });

  it('infers risk signals from changed file paths', async () => {
    detectChangedFilesMock.mockResolvedValue(baseChanged);

    const out = await composeSquadWorkflow({
      workspace_root: 'C:/fake/workspace',
      user_prompt: 'add payment flow',
      read_content: false,
      staged_only: false,
      force_agents: [],
    });

    expect(out.inferred_risk_signals.touches_auth).toBe(true);
    expect(out.inferred_risk_signals.touches_money).toBe(true);
    expect(out.inferred_risk_signals.new_module).toBe(true);
    expect(out.inferred_risk_signals.files_count).toBe(3);
    expect(out.risk.score).toBeGreaterThanOrEqual(3);
  });

  it('honors force_work_type override', async () => {
    detectChangedFilesMock.mockResolvedValue(baseChanged);

    const out = await composeSquadWorkflow({
      workspace_root: 'C:/fake/workspace',
      user_prompt: 'fix authentication bug',
      force_work_type: 'Refactor',
      read_content: false,
      staged_only: false,
      force_agents: [],
    });

    expect(out.work_type).toBe('Refactor');
  });

  it('honors explicit risk_signals override', async () => {
    detectChangedFilesMock.mockResolvedValue(baseChanged);

    const out = await composeSquadWorkflow({
      workspace_root: 'C:/fake/workspace',
      user_prompt: 'minor refactor',
      risk_signals: { touches_auth: false, touches_money: false, touches_migration: false },
      read_content: false,
      staged_only: false,
      force_agents: [],
    });

    expect(out.inferred_risk_signals.touches_auth).toBe(false);
    expect(out.inferred_risk_signals.touches_money).toBe(false);
  });

  it('honors force_agents passthrough', async () => {
    detectChangedFilesMock.mockResolvedValue(baseChanged);

    const out = await composeSquadWorkflow({
      workspace_root: 'C:/fake/workspace',
      user_prompt: 'add feature',
      force_agents: ['senior-qa'],
      read_content: false,
      staged_only: false,
    });

    expect(out.squad.agents).toContain('senior-qa');
  });

  it('detects migrations folder as touches_migration', async () => {
    detectChangedFilesMock.mockResolvedValue({
      files: [{ path: 'src/Migrations/20260101_add_users.cs', status: 'added', raw_status: 'A' }],
      base_ref: null,
      staged_only: true,
      invocation: 'git diff --name-status --no-renames --cached',
    });

    const out = await composeSquadWorkflow({
      workspace_root: 'C:/fake/workspace',
      user_prompt: 'add user table migration',
      staged_only: true,
      read_content: false,
      force_agents: [],
    });

    expect(out.inferred_risk_signals.touches_migration).toBe(true);
  });

  it('passes base_ref through to detectChangedFiles', async () => {
    detectChangedFilesMock.mockResolvedValue(baseChanged);

    await composeSquadWorkflow({
      workspace_root: 'C:/fake/workspace',
      user_prompt: 'small change',
      base_ref: 'release/1.2',
      read_content: false,
      staged_only: false,
      force_agents: [],
    });

    expect(detectChangedFilesMock).toHaveBeenCalledWith(
      expect.objectContaining({ base_ref: 'release/1.2', workspace_root: 'C:/fake/workspace' }),
    );
  });
});
