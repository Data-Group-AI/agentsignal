import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * A credential acquired mid-session turns its tier on, in that session.
 *
 * This is what makes "set yourself up" finishable by an agent alone. It can
 * call `open_account` with nothing configured, and the key comes back into a
 * process that cannot edit the config it was launched from and cannot restart
 * itself -- so a tier decided once at startup left it holding a credential it
 * had no way to use. The tools it unlocks have to arrive without a restart, or
 * a human has to do the second half.
 *
 * Asserted through `tools/list` before and after, because that is what a
 * client actually sees. The `notifications/tools/list_changed` in between is
 * what tells the client to look again, so it is checked too -- without it the
 * tools exist and nobody knows.
 */

const SERVER = resolve(__dirname, '..', 'src', 'index.ts');

const ACCOUNT = {
  ok: true,
  account: { id: 'a_1', name: 'Fleet', slug: 'fleet' },
  channel: { id: 'p_1', ref: 'abcd1234', name: 'Default' },
  api_key: 'as_live_abcd1234_secretsecretsecretsecre',
  free_human_deliveries: 10,
};

let http: Server;
let baseUrl: string;

beforeAll(async () => {
  http = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if ((req.url ?? '').startsWith('/v1/agents/signup')) {
        res.statusCode = 200;
        res.end(JSON.stringify(ACCOUNT));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ ok: false, error: { code: 'not_found', message: req.url } }));
    });
  });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  const address = http.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(() => new Promise<void>((r) => http.close(() => r())));

/**
 * List tools, call one, list again — on one long-lived process, because the
 * whole claim is about a single session.
 */
function openAccountAndRelist(): Promise<{
  before: string[];
  after: string[];
  announced: boolean;
  text: string;
}> {
  return new Promise((resolveIt, reject) => {
    const child: ChildProcess = spawn('npx', ['tsx', SERVER], {
      // Nothing configured. This is an agent that has never heard of us.
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        AGENTSIGNAL_BASE_URL: baseUrl,
        // Passed through so a spawned server obeys the same keychain switch as the
        // runner. Empty means "not set", which is what an ordinary run looks like.
        AGENTSIGNAL_NO_KEYCHAIN: process.env.AGENTSIGNAL_NO_KEYCHAIN ?? '',
        AGENTSIGNAL_STATE_DIR: mkdtempSync(join(tmpdir(), 'agentsignal-turnon-')),
      },
      stdio: ['pipe', 'pipe', 'ignore'],
    });

    let buffer = '';
    let before: string[] | null = null;
    let text = '';
    let announced = false;

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('no response'));
    }, 45_000);

    const say = (o: unknown) => child.stdin?.write(JSON.stringify(o) + '\n');

    child.stdout?.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.trim().startsWith('{')) continue;
        let m: {
          id?: unknown;
          method?: string;
          result?: { tools?: { name: string }[]; content?: { text?: string }[] };
        };
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }

        if (m.method === 'notifications/tools/list_changed') {
          announced = true;
          continue;
        }

        if (m.id === 2 && m.result?.tools) {
          before = m.result.tools.map((t) => t.name).sort();
          say({
            jsonrpc: '2.0',
            id: 3,
            method: 'tools/call',
            params: { name: 'open_account', arguments: { name: 'Fleet' } },
          });
          continue;
        }

        if (m.id === 3) {
          text = (m.result?.content ?? []).map((c) => c.text ?? '').join('\n');
          say({ jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} });
          continue;
        }

        if (m.id === 4 && m.result?.tools) {
          clearTimeout(timer);
          child.kill();
          resolveIt({
            before: before ?? [],
            after: m.result.tools.map((t) => t.name).sort(),
            announced,
            text,
          });
          return;
        }
      }
    });

    child.on('error', reject);

    say({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'turnon', version: '1' },
      },
    });
    say({ jsonrpc: '2.0', method: 'notifications/initialized' });
    say({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  });
}

describe('a tier acquired mid-session', () => {
  it('turns on without a restart, and says so', async () => {
    const { before, after, announced, text } = await openAccountAndRelist();

    // An agent with nothing gets the tools that need nothing.
    expect(before).not.toContain('register_self');
    expect(before).not.toContain('notify');
    expect(before).toContain('open_account');

    // And after opening one, the account's tools are simply there.
    expect(after).toContain('register_self');
    expect(after).toContain('notify');
    expect(after).toContain('list_agents');
    expect(after.length).toBeGreaterThan(before.length);

    // The client is told to look again; otherwise the tools exist unnoticed.
    expect(announced).toBe(true);

    // And the answer does not send it looking for a restart it cannot do.
    expect(text).not.toMatch(/restart this MCP server/i);
    expect(text).toContain('without a restart');
  }, 60_000);
});
