import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * That opening an account writes the key down instead of saying it.
 *
 * `open_account` is the bootstrap: no agent, no device, nothing to seal to, so
 * the key genuinely has nowhere to go but the caller. It therefore PRINTED it,
 * and told the agent to set AGENTSIGNAL_API_KEY before the next start.
 *
 * Two things wrong with that, and the second is the expensive one. An agent
 * inside a plugin cannot edit the config it was launched from, so the ordinary
 * outcome of opening an account was opening a different one next time. And a
 * key that can page real devices was written into a transcript on the way --
 * the exact exposure the join path spent a release removing, on the reasoning
 * that a response is read by a model and a model's context is written down.
 *
 * Both halves are asserted, because either alone is a worse product than what
 * it replaces: not printing a key you then lose is just losing the key, and
 * persisting one you also print protects nothing.
 */

const SERVER = resolve(__dirname, '..', 'src', 'index.ts');
const MINTED = 'as_live_boot0001_thekeytheaccountwasgiven1';

let http: Server;
let baseUrl: string;
/** Every Authorization the keyed endpoint was called with. */
let presented: string[] = [];

beforeAll(async () => {
  http = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const path = req.url ?? '';
      res.setHeader('Content-Type', 'application/json');

      if (path.startsWith('/v1/agents/signup')) {
        res.statusCode = 201;
        res.end(
          JSON.stringify({
            ok: true,
            account: { id: 'acc-1', name: 'Bootstrapped', slug: 'bootstrapped' },
            channel: { id: 'ch-1', ref: 'boot0001', name: 'Default' },
            api_key: MINTED,
            free_human_deliveries: 10,
          }),
        );
        return;
      }

      if (path.startsWith('/v1/recipients')) {
        presented.push((req.headers.authorization ?? '').replace(/^Bearer /, ''));
        res.statusCode = 200;
        res.end(
          JSON.stringify({
            channel: { name: 'Default', is_sandbox: false },
            recipients: [{ key: 'u_personAbCdEfGhIjKlMn', name: 'Dana', devices: 1, reachable: true }],
          }),
        );
        return;
      }

      res.statusCode = 200;
      res.end(JSON.stringify({ ok: true, channels: [], recipients: [] }));
    });
  });

  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  const address = http.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(() => new Promise<void>((r) => http.close(() => r())));

beforeEach(() => {
  presented = [];
});

function callTool(
  name: string,
  args: Record<string, unknown>,
  stateDir: string,
): Promise<{ text: string; isError: boolean }> {
  return new Promise((resolveCall, reject) => {
    const child: ChildProcess = spawn('npx', ['tsx', SERVER], {
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        AGENTSIGNAL_BASE_URL: baseUrl,
        // With the keychain off the value lands in the file, which is the
        // shape a machine without one gets -- and the shape whose plaintext
        // this test can actually look for.
        AGENTSIGNAL_NO_KEYCHAIN: '1',
        AGENTSIGNAL_STATE_DIR: stateDir,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let buffer = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`no response from ${name}`));
    }, 45_000);

    child.stdout?.on('data', (chunk) => {
      buffer += chunk;
      for (const line of buffer.split('\n')) {
        if (!line.trim().startsWith('{')) continue;
        try {
          const message = JSON.parse(line);
          if (message.id !== 3) continue;
          clearTimeout(timer);
          child.kill();
          const content = message.result?.content ?? [];
          resolveCall({
            text: content.map((c: { text?: string }) => c.text ?? '').join('\n'),
            isError: Boolean(message.result?.isError),
          });
          return;
        } catch {
          // Partial line.
        }
      }
    });

    child.on('error', reject);
    const say = (o: unknown) => child.stdin?.write(JSON.stringify(o) + '\n');
    say({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'bootstrap-test', version: '1' },
      },
    });
    say({ jsonrpc: '2.0', method: 'notifications/initialized' });
    say({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    say({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name, arguments: args } });
  });
}

describe('an account opened from nothing', () => {
  it('never says the key, and survives the process that opened it', async () => {
    const state = mkdtempSync(join(tmpdir(), 'agentsignal-boot-'));

    const opened = await callTool('open_account', { name: 'Bootstrapped' }, state);
    expect(opened.isError, opened.text).toBe(false);

    // NOT IN THE RESPONSE. This is the half that protects the transcript, and
    // the prefix check catches a future key of any shape rather than only the
    // fixture above.
    expect(opened.text, 'the key must not be in what the model reads').not.toContain(MINTED);
    expect(opened.text).not.toMatch(/as_live_|as_test_/);

    // ON DISK. Written where the next start looks, rather than left to an
    // environment variable an agent inside a plugin cannot set.
    const file = join(state, 'account.json');
    expect(existsSync(file), 'the account should have been written down').toBe(true);
    const record = JSON.parse(readFileSync(file, 'utf8'));
    expect(record.base_url).toBe(baseUrl);
    expect(record.channel_ref).toBe('boot0001');

    // THE ASSERTION THIS FILE EXISTS FOR. A SECOND process, nothing in its
    // environment but the state directory, and the key reaches the wire. That
    // is the difference between remembering an account and merely having said
    // its key out loud once.
    const listed = await callTool('list_people', {}, state);
    expect(listed.isError, listed.text).toBe(false);
    expect(presented, 'the remembered key should have been presented').toEqual([MINTED]);
  }, 120_000);
});
