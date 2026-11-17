import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * That a second invitation reaches the API when the agent has no key yet.
 *
 * `join_channel` short-circuits when it is already registered, which is right
 * for a restart: redeeming again spends a use of a code that usually has
 * exactly one. It was taught to compare CHANNELS after refusing on the handle
 * alone left an agent unable to join a second channel at all.
 *
 * That was half the question. Membership says where you are; it says nothing
 * about whether you can do anything there. A person-minted code delivers a key
 * on every redemption -- deliberately, so that re-inviting an agent is how you
 * give it one -- and this guard refused all of them on the grounds that the
 * agent was already a member. The invitation reported "nothing to do" without
 * contacting the API, so no key was ever minted.
 *
 * It happened for real: a code was minted from the dashboard for exactly this,
 * and the session went on using a key belonging to a channel it had left.
 *
 * Both directions are asserted, because a guard that never refuses is not a
 * fix -- it is the token-spending bug the guard exists to prevent.
 */

const SERVER = resolve(__dirname, '..', 'src', 'index.ts');
const CHANNEL = 'chan0007';
const TOKEN = `as_join_${CHANNEL}_abcdefghijklmnopqrstuvwxyz01`;
const AGENT = 'u_memberAgentAbCdEfGhI';

let http: Server;
let baseUrl: string;
/** Whether the API was asked to register at all. */
let registered = false;

beforeAll(async () => {
  http = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const path = req.url ?? '';
      res.setHeader('Content-Type', 'application/json');

      if (path.startsWith('/v1/agents/register')) {
        registered = true;
        res.statusCode = 200;
        res.end(
          JSON.stringify({
            ok: true,
            created: false,
            agent: { handle: 'member-agent', key: AGENT, id: 'a-7' },
            instance: { id: '33333333-4444-4555-8666-777777777777', instance_id: 'i-7' },
            device_secret: `33333333-4444-4555-8666-777777777777.${'ab'.repeat(32)}`,
            webhook_secret: null,
            api_key_sealed: false,
            api_key_reason: null,
            channel: { ref: CHANNEL, name: 'Seventh', is_sandbox: false },
          }),
        );
        return;
      }

      // The channels this agent is already in — it IS a member of the one the
      // code is for, which is what used to end the whole call right here.
      if (path.startsWith('/v1/channels')) {
        res.statusCode = 200;
        res.end(
          JSON.stringify({
            ok: true,
            channels: [{ ref: CHANNEL, name: 'Seventh', is_home: true, mine: false, members: 2 }],
          }),
        );
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
  registered = false;
});

/**
 * An identity already registered in the channel, holding `apiKey`.
 *
 * `null` for an agent that has none — the case a second invitation is minted
 * for. The key goes in the file rather than a keychain for the same reason the
 * suite sets AGENTSIGNAL_NO_KEYCHAIN: a test must not touch a real one.
 */
function seeded(apiKey: string | null): string {
  const state = mkdtempSync(join(tmpdir(), 'agentsignal-member-'));
  writeFileSync(
    join(state, 'agent.json'),
    JSON.stringify({
      base_url: baseUrl,
      handle: 'member-agent',
      key: AGENT,
      credential: `33333333-4444-4555-8666-777777777777.${'ab'.repeat(32)}`,
      saved_at: new Date(0).toISOString(),
      ...(apiKey ? { api_key: apiKey } : {}),
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
        clientInfo: { name: 'member-test', version: '1' },
      },
    });
    say({ jsonrpc: '2.0', method: 'notifications/initialized' });
    say({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    say({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name, arguments: args } });
  });
}

describe('a second invitation to a channel you are already in', () => {
  it('is redeemed when you hold no key for it, because that is what it is for', async () => {
    const { isError, text } = await callTool(
      'join_channel',
      { handle: 'member-agent', token: TOKEN },
      seeded(null),
    );

    expect(isError, text).toBe(false);

    // THE ASSERTION THIS FILE EXISTS FOR. Not what the response says -- what
    // reached the API. "Nothing to do" was printed without a single request,
    // so only the server's own record of having been called can tell the
    // difference between joining and claiming to have considered it.
    expect(registered, 'the invitation must actually reach the API').toBe(true);
  }, 120_000);

  it('is redeemed when the key you hold belongs to a different channel', async () => {
    const { isError, text } = await callTool(
      'join_channel',
      { handle: 'member-agent', token: TOKEN },
      seeded('as_live_chan0001_akeyfromsomewhereelse00001'),
    );

    expect(isError, text).toBe(false);
    expect(registered, 'a key for another channel is not a key for this one').toBe(true);
  }, 120_000);

  it('still refuses when you are in the channel and hold its key', async () => {
    // The case the guard exists for. A guard that never refuses is not a fix:
    // it is the bug where a restart quietly spends the last use of a code.
    const { isError, text } = await callTool(
      'join_channel',
      { handle: 'member-agent', token: TOKEN },
      seeded(`as_live_${CHANNEL}_thekeyforthischannel00001`),
    );

    expect(isError, text).toBe(false);
    expect(text).toContain('NOT spent');
    expect(registered, 'nothing should have been redeemed').toBe(false);
  }, 120_000);
});
