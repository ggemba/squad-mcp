import { describe, it, expect, afterEach } from 'vitest';
import { spawnServer, initialize, type ServerHandle } from './stdio-helpers.js';

let handle: ServerHandle | null = null;

afterEach(async () => {
  await handle?.close();
  handle = null;
});

function assertAllStdoutValidJsonRpc(lines: string[]): void {
  for (const line of lines) {
    if (!line.trim()) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      throw new Error(`stdout contained non-JSON line: ${JSON.stringify(line.slice(0, 200))}`);
    }
    expect(obj.jsonrpc).toBe('2.0');
  }
}

describe('stdout purity', () => {
  it('happy path emits only JSON-RPC frames on stdout', async () => {
    handle = await spawnServer();
    await initialize(handle, 1);
    handle.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    await handle.recv(2);
    handle.send({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'score_risk',
        arguments: { touches_auth: false, files_count: 0 },
      },
    });
    await handle.recv(3);
    assertAllStdoutValidJsonRpc(handle.stdoutLines());
    expect(handle.stderrText().length).toBeGreaterThan(0);
  }, 15_000);

  it('failure paths keep stdout pure', async () => {
    handle = await spawnServer();
    await initialize(handle, 1);

    handle.send({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'no_such_tool', arguments: {} },
    });
    await handle.recv(2);

    handle.send({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'select_squad', arguments: { work_type: 'Bogus' } },
    });
    await handle.recv(3);

    handle.send({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'select_squad',
        arguments: {
          work_type: 'Feature',
          files: ['../../../etc/passwd'],
          read_content: true,
          workspace_root: process.cwd(),
        },
      },
    });
    await handle.recv(4);

    assertAllStdoutValidJsonRpc(handle.stdoutLines());
    const stderr = handle.stderrText();
    expect(stderr).toContain('"level":"warn"');
  }, 20_000);
});
