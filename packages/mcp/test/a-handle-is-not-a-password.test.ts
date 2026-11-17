import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * F1, 2026-11-14: A HANDLE IS NOT A PASSWORD.
 *
 * Jeff's machine joined with the handle `company-orchestrator`, which already
 * belonged to the live orchestrator on another machine. The server attached
 * it to that agent, and the client then moved Jeff's own identity aside into
 * `previous/` -- so the machine lost the identity it had and gained one that
 * was somebody else's.
 *
 * The server now refuses (409 handle_taken) unless the joiner proves it holds
 * the agent's credential. This file holds the client to its half:
 *   - a refused join leaves the identity on disk exactly as it was;
 *   - rejoining under the REMEMBERED handle sends the remembered credential,
 *     which is the proof a legitimate re-invitation needs;
 *   - joining under any OTHER handle sends no credential at all.
 */

const SERVER = resolve(__dirname, '..', 'src', 'index.ts');
/**
 * FAKE fixtures, built at runtime so nothing in this file is shaped like a
 * real secret. The shapes match what the API returns: a join code is
 * `as_join_<channel>_<secret>`, a device credential `<install id>.<64 hex>`.
 */
const FAKE_INSTALL_ID = '33333333-4444-4555-8666-777777777777';
const fakeJoinCode = (channel: string) => ['as', 'join', channel, 'k'.repeat(28)].join('_');
const fakeDeviceSecret = (pair: string) => [FAKE_INSTALL_ID, pair.repeat(32)].join('.');

const TOKEN = fakeJoinCode('chanf1f1');
const MINE = 'u_mineAgentAbCdEfGhIjKl';
const HELD = fakeDeviceSecret('ab');

let http: Server;
let baseUrl: string;
/** Bodies the register endpoint received, in order. */
let registers: Array<Record<string, unknown>> = [];
/** What the register endpoint answers. */
let answer: 'taken' | 'ok' = 'ok';

beforeAll(async () => {
  http = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const path = req.url ?? '';
      res.setHeader('Content-Type', 'application/json');

      if (path.startsWith('/v1/agents/register')) {
        registers.push(JSON.parse(raw || '{}'));
        if (answer === 'taken') {
          res.statusCode = 409;
          res.end(
            JSON.stringify({
              ok: false,
              error: {
                code: 'handle_taken',
                message:
                  'The handle "company-orchestrator" already belongs to another agent in this channel, so this join was refused and nothing was spent. A new machine is a new agent: join again with a handle of its own, e.g. "company-orchestrator-<machine>".',
              },
            }),
          );
          return;
        }
        res.statusCode = 200;
        res.end(
          JSON.stringify({
            ok: true,
            created: false,
            agent: { handle: 'mine-agent', key: MINE, id: 'a-1' },
            instance: { id: FAKE_INSTALL_ID, instance_id: 'i-1' },
            device_secret: fakeDeviceSecret('cd'),
            webhook_secret: null,
            api_key_sealed: false,
            api_key_reason: null,
            channel: { ref: 'chanf1f1', name: 'Other', is_sandbox: false },
          }),
        );
        return;
      }

      // The device-credential send. It answers recipient_not_found the way
      // ingest_as_agent did for the orchestrator before F2 was fixed.
      if (path.startsWith('/v1/messages')) {
        res.statusCode = 404;
        res.end(
          JSON.stringify({
            ok: false,
            error: { code: 'recipient_not_found', message: 'Could not send: recipient not found.' },
          }),
        );
        return;
      }

      if (path.startsWith('/v1/channels')) {
        res.statusCode = 200;
        res.end(JSON.stringify({ ok: true, channels: [] }));
        return;
      }

      if (path.startsWith('/v1/devices/me/messages')) {
        res.statusCode = 200;
        res.end(JSON.stringify({ messages: [] }));
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
  registers = [];
  answer = 'ok';
});

/** A machine that already is `mine-agent`. Returns the state dir. */
function seeded(): string {
  const state = mkdtempSync(join(tmpdir(), 'agentsignal-handle-'));
  writeFileSync(
    join(state, 'agent.json'),
    JSON.stringify({
      base_url: baseUrl,
      handle: 'mine-agent',
      key: MINE,
      credential: HELD,
      saved_at: new Date(0).toISOString(),
    }),
  );
  return state;
}

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
        AGENTSIGNAL_NO_KEYCHAIN: process.env.AGENTSIGNAL_NO_KEYCHAIN ?? '',
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
        clientInfo: { name: 'handle-test', version: '1' },
      },
    });
    say({ jsonrpc: '2.0', method: 'notifications/initialized' });
    say({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    say({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name, arguments: args } });
  });
}

describe('joining under a handle that is somebody else’s', () => {
  it('leaves this machine’s own identity exactly where it was', async () => {
    answer = 'taken';
    const state = seeded();
    const before = readFileSync(join(state, 'agent.json'), 'utf8');

    const { isError, text } = await callTool(
      'join_channel',
      { handle: 'company-orchestrator', token: TOKEN },
      state,
    );

    expect(isError, text).toBe(true);
    expect(text).toMatch(/handle of its own/);
    expect(registers).toHaveLength(1);
    expect(readFileSync(join(state, 'agent.json'), 'utf8'), 'identity untouched').toBe(before);
    expect(existsSync(join(state, 'previous')), 'nothing moved aside').toBe(false);
  }, 120_000);

  it('does not send this machine’s credential under another handle', async () => {
    answer = 'taken';
    await callTool('join_channel', { handle: 'company-orchestrator', token: TOKEN }, seeded());

    expect(registers).toHaveLength(1);
    expect(registers[0]).not.toHaveProperty('current_credential');
  }, 120_000);
});

describe('rejoining as the agent this machine is', () => {
  it('proves it with the remembered credential', async () => {
    const { isError, text } = await callTool(
      'join_channel',
      { handle: 'mine-agent', token: TOKEN },
      seeded(),
    );

    expect(isError, text).toBe(false);
    expect(registers).toHaveLength(1);
    expect(registers[0]!.current_credential).toBe(HELD);
    // Its own device as the instance, so the server re-keys it rather than
    // leaving an orphan device with a secret nobody holds.
    expect(registers[0]!.instance_id).toBe(FAKE_INSTALL_ID);
  }, 120_000);
});

/**
 * F2's other half. The partner's refusal was explained as "that channel does
 * not accept pay-as-you-go sends" -- the x402 reading of the code -- and it
 * went looking for an API key. notify_as_self is a device-credential send;
 * the only meaning there is "you share no channel with that key".
 */
describe('a self-send that reaches nobody', () => {
  it('says why without sending the agent after a key or credit', async () => {
    const { isError, text } = await callTool(
      'notify_as_self',
      { to: 'u_notSharedWithMeAbCdEf0', body: 'hello' },
      seeded(),
    );

    expect(isError, text).toBe(true);
    expect(text).toMatch(/not somebody you share a channel with/);
    expect(text).not.toMatch(/pay-as-you-go/);
    expect(text).toMatch(/find_agents_in_my_channels/);
  }, 120_000);
});
