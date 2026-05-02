import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..', '..');

export interface ServerHandle {
  child: ChildProcessWithoutNullStreams;
  send: (req: Record<string, unknown>) => void;
  recv: (id: number, timeoutMs?: number) => Promise<Record<string, unknown>>;
  stdoutLines: () => string[];
  stderrText: () => string;
  close: () => Promise<void>;
}

export async function spawnServer(): Promise<ServerHandle> {
  const tsxBin = path.resolve(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const entry = path.resolve(projectRoot, 'src', 'index.ts');
  const child = spawn(process.execPath, [tsxBin, entry], {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: projectRoot,
  }) as ChildProcessWithoutNullStreams;

  const stdoutLines: string[] = [];
  let stdoutBuf = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdoutBuf += chunk.toString('utf8');
    let idx;
    while ((idx = stdoutBuf.indexOf('\n')) !== -1) {
      const line = stdoutBuf.slice(0, idx);
      stdoutBuf = stdoutBuf.slice(idx + 1);
      stdoutLines.push(line);
    }
  });

  let stderrBuf = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderrBuf += chunk.toString('utf8');
  });

  function send(req: Record<string, unknown>): void {
    child.stdin.write(JSON.stringify(req) + '\n');
  }

  async function recv(id: number, timeoutMs = 5000): Promise<Record<string, unknown>> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      for (const line of stdoutLines) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line) as Record<string, unknown>;
          if (obj.id === id) return obj;
        } catch {
          // skip malformed
        }
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`recv timeout for id=${id}; stderr=${stderrBuf.slice(0, 500)}`);
  }

  async function close(): Promise<void> {
    if (!child.killed) {
      child.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          if (!child.killed) child.kill('SIGKILL');
          resolve();
        }, 2000);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  // Wait briefly for spawn to settle
  await new Promise((r) => setTimeout(r, 100));

  return {
    child,
    send,
    recv,
    stdoutLines: () => stdoutLines.slice(),
    stderrText: () => stderrBuf,
    close,
  };
}

export function initialize(handle: ServerHandle, id = 1): Promise<Record<string, unknown>> {
  handle.send({
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'integration', version: '0.0' } },
  });
  return handle.recv(id);
}
