import { describe, it, expect } from 'vitest';
import { selectSquad } from '../src/tools/select-squad.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

async function tmpDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'squad-mcp-'));
}

describe('selectSquad', () => {
  it('returns core agents for Feature with no files', async () => {
    const r = await selectSquad({
      work_type: 'Feature',
      files: [],
      read_content: false,
      force_agents: [],
    });
    expect(r.agents).toEqual(expect.arrayContaining(['product-owner', 'senior-developer', 'senior-qa']));
  });

  it('detects DBA via path hint (Repository.cs)', async () => {
    const r = await selectSquad({
      work_type: 'Bug Fix',
      files: ['src/Data/UserRepository.cs'],
      read_content: false,
      force_agents: [],
    });
    expect(r.agents).toContain('senior-dba');
  });

  it('detects DBA via content sniff when name does not match', async () => {
    const dir = await tmpDir();
    const file = 'Services/MyDataAccess.cs';
    const abs = path.join(dir, file);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, 'public class MyDataAccess : DbContext { }');
    const r = await selectSquad({
      work_type: 'Bug Fix',
      files: [file],
      read_content: true,
      workspace_root: dir,
      force_agents: [],
    });
    expect(r.agents).toContain('senior-dba');
    const ev = r.evidence.find((e) => e.agent === 'senior-dba');
    expect(ev?.source).toBe('content');
  });

  it('honors force_agents', async () => {
    const r = await selectSquad({
      work_type: 'Bug Fix',
      files: [],
      read_content: false,
      force_agents: ['senior-dev-security'],
    });
    expect(r.agents).toContain('senior-dev-security');
  });

  it('records low_confidence when nothing matches', async () => {
    const r = await selectSquad({
      work_type: 'Bug Fix',
      files: ['Helpers/Util.cs'],
      read_content: false,
      force_agents: [],
    });
    expect(r.low_confidence_files.map((f) => f.file)).toContain('Helpers/Util.cs');
  });
});
