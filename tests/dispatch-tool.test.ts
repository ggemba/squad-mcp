import { describe, it, expect, beforeAll } from 'vitest';
import { registerTools, dispatchTool } from '../src/tools/registry.js';

beforeAll(() => {
  registerTools();
});

describe('dispatchTool error mapping', () => {
  it('returns UNKNOWN_TOOL for unregistered name', async () => {
    const r = await dispatchTool('nope', {}) as { content: { text: string }[]; isError: boolean };
    expect(r.isError).toBe(true);
    const body = JSON.parse(r.content[0]!.text);
    expect(body.error.code).toBe('UNKNOWN_TOOL');
  });

  it('returns INVALID_INPUT when zod validation fails', async () => {
    const r = await dispatchTool('select_squad', { work_type: 'Invalid' }) as { content: { text: string }[]; isError: boolean };
    expect(r.isError).toBe(true);
    const body = JSON.parse(r.content[0]!.text);
    expect(body.error.code).toBe('INVALID_INPUT');
  });

  it('returns INVALID_INPUT when agent enum rejects unknown name', async () => {
    const r = await dispatchTool('slice_files_for_agent', {
      agent: 'made-up-agent',
      files: [],
    }) as { content: { text: string }[]; isError: boolean };
    expect(r.isError).toBe(true);
    const body = JSON.parse(r.content[0]!.text);
    expect(body.error.code).toBe('INVALID_INPUT');
  });

  it('returns success shape on a valid call', async () => {
    const r = await dispatchTool('score_risk', {
      touches_auth: true,
      touches_money: false,
      touches_migration: false,
      files_count: 0,
      new_module: false,
      api_contract_change: false,
    }) as { content: { text: string }[]; isError?: boolean };
    expect(r.isError).toBeUndefined();
    const body = JSON.parse(r.content[0]!.text);
    expect(body.level).toBe('Low');
  });

  it('PATH_TRAVERSAL_DENIED surfaces in select_squad low_confidence_files (does not abort batch)', async () => {
    const r = await dispatchTool('select_squad', {
      work_type: 'Bug Fix',
      files: ['../etc/passwd', 'src/legit.ts'],
      read_content: true,
      workspace_root: process.cwd(),
    }) as { content: { text: string }[]; isError?: boolean };
    expect(r.isError).toBeUndefined();
    const body = JSON.parse(r.content[0]!.text);
    const denied = body.low_confidence_files.find((f: { reason: string }) => f.reason.includes('PATH_TRAVERSAL_DENIED'));
    expect(denied).toBeDefined();
  });
});
