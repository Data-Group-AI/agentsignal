import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * That joining a new channel puts down the old channel's key.
 *
 * A key belongs to ONE identity in ONE channel. Joining a different channel
 * mints a different identity -- the server says so, loudly, in the response --
 * but the key was in a module variable and nothing put it down.
 *
 * What that looked like in practice, and how it was found: a session joined a
 * new channel, was told "Registered", and then answered `my_channels` about the
 * NEW channel and `list_people` about the OLD one. The first reads the device
 * credential, which had been replaced; the second reads the API key, which had
 * not. Both tools were working exactly as written. Neither was wrong on its own
 * and together they were two channels in one session -- the cross-channel reach
 * this system is explicitly not supposed to have yet, arrived at by leaving a
 * variable alone rather than by any decision anybody made.
 *
 * Nothing failed, which is why it needs a test rather than an error message. A
 * revoked key would have 401'd and been noticed in a minute. A key that still
 * works, pointed at a channel you have left, answers every question correctly
 * and about the wrong place.
 *
 * The assertion is therefore about what must NOT be on the wire: after the
 * rejoin, no request may carry the first channel's key. Asserting that the
 * second call merely "failed" would pass against a server that sent the stale
 * key and got a 403 for unrelated reasons.
 */

const SERVER = resolve(__dirname, '..', 'src', 'index.ts');
const FIRST_KEY = 'as_live_chan0001_thekeyfromthefirstchannel';
const FIRST_AGENT = 'u_firstAgentAbCdEfGhIj';

let http: Server;
let baseUrl: string;
/** Every Authorization presented to the keyed endpoint, in order. */
let presented: string[] = [];

beforeAll(async () => {
  http = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const path = req.url ?? '';
      res.setHeader('Content-Type', 'application/json');

      if (path.startsWith('/v1/agents/register')) {
        res.statusCode = 201;
        res.end(
          JSON.stringify({
            ok: true,
            created: true,
            agent: { handle: 'second-agent', key: 'u_secondAgentAbCdEfGhI', id: 'a-2' },
            instance: { id: '11111111-2222-4333-8444-555555555555', instance_id: 'i-2' },
            device_secret: `11111111-2222-4333-8444-555555555555.${'ef'.repeat(32)}`,
            webhook_secret: null,
            // The shape an AGENT-minted invitation produces: no key, and a
            // reason saying why, because there is no person whose role a key
            // could be cut from.
            api_key_sealed: false,
            api_key_reason: 'invitation_not_minted_by_a_person',
            channel: { ref: 'chan0002', name: 'Second', is_sandbox: false },
          }),
        );
        return;
      }

      if (path.startsWith('/v1/recipients')) {
        presented.push((req.headers.authorization ?? '').replace(/^Bearer /, ''));
        res.statusCode = 200;
        res.end(
          JSON.stringify({
            channel: { name: 'Whichever', is_sandbox: false },
            recipients: [{ key: 'u_personAbCdEfGhIjKlMn', name: 'Dana', devices: 1, reachable: true }],
          }),
        );
        return;
      }

      // No key waiting for anybody in this file.
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
  presented = [];
});

/**
 * A state directory already holding an agent that has a key.
 *
 * Seeded rather than produced by a first join, because the key has to be in the
 * process at STARTUP -- that is where the real one comes from, read out of the
 * identity file before any tool runs. `api_key` in plain text rather than a
 * keychain reference for the same reason the suite sets AGENTSIGNAL_NO_KEYCHAIN:
 * a test must not put anything in a developer's login keychain.
 */
function seeded(): string {
  const state = mkdtempSync(join(tmpdir(), 'agentsignal-carryover-'));
  writeFileSync(
    join(state, 'agent.json'),
    JSON.stringify({
      base_url: baseUrl,
      handle: 'first-agent',
      key: FIRST_AGENT,
      credential: `99999999-8888-4777-8666-555555555555.${'ab'.repeat(32)}`,
      saved_at: new Date(0).toISOString(),
      api_key: FIRST_KEY,
    }),
  );
  return state;
}

/** Two tool calls down one server process — the drop is an in-memory thing. */
function callTwo(
  calls: { name: string; args: Record<string, unknown> }[],
  stateDir: string,
): Promise<{ text: string; isError: boolean }[]> {
  return new Promise((resolveCalls, reject) => {
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

    const results: { text: string; isError: boolean }[] = [];
    let buffer = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('no response'));
    }, 45_000);

    child.stdout?.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.trim().startsWith('{')) continue;
        let message: { id?: unknown; result?: { content?: { text?: string }[]; isError?: boolean } };
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (typeof message.id !== 'number' || message.id < 10) continue;

        const content = message.result?.content ?? [];
        results[message.id - 10] = {
          text: content.map((c) => c.text ?? '').join('\n'),
          isError: Boolean(message.result?.isError),
        };

        const done = results.filter(Boolean).length;
        if (done === calls.length) {
          clearTimeout(timer);
          child.kill();
          resolveCalls(results);
          return;
        }
        // One at a time: the second call is only meaningful after the first.
        send(done);
      }
    });

    child.on('error', reject);
    const say = (o: unknown) => child.stdin?.write(JSON.stringify(o) + '\n');

    function send(i: number) {
      say({
        jsonrpc: '2.0',
        id: 10 + i,
        method: 'tools/call',
        params: { name: calls[i]!.name, arguments: calls[i]!.args },
      });
    }

    say({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'carryover-test', version: '1' },
      },
    });
    say({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send(0);
  });
}

describe('a key does not follow you to a new channel', () => {
  it('is put down on joining as somebody else, and never reaches the wire', async () => {
    const state = seeded();

    const [joined, listed] = await callTwo(
      [
        {
          name: 'join_channel',
          args: { handle: 'second-agent', token: 'as_join_chan0002_abcdefghijklmnopqrstuvwxyz01' },
        },
        { name: 'list_people', args: {} },
      ],
      state,
    );

    expect(joined!.isError, joined!.text).toBe(false);

    // THE ASSERTION THIS FILE EXISTS FOR. Not "the second call failed" -- that
    // would pass against a server that sent the stale key and was refused for
    // some other reason. The first channel's key must not have been on the wire
    // at all.
    expect(presented, 'the previous channel key must never be sent from the new identity').not.toContain(
      FIRST_KEY,
    );
    expect(presented, 'nothing keyed should have gone out with no key of its own').toEqual([]);

    // And the agent is told, rather than left to discover its tools missing.
    expect(joined!.text).toContain('put down');
    expect(listed!.isError).toBe(true);
  }, 120_000);

  it('says why no key came, when the invitation could never carry one', async () => {
    const state = seeded();

    const [joined] = await callTwo(
      [
        {
          name: 'join_channel',
          args: { handle: 'second-agent', token: 'as_join_chan0002_abcdefghijklmnopqrstuvwxyz01' },
        },
      ],
      state,
    );

    expect(joined!.isError, joined!.text).toBe(false);

    // The distinction the boolean could not carry: not a fault, and not fixable
    // by waiting. Telling an agent to keep polling an inbox that will never
    // receive a key is worse than telling it nothing.
    expect(joined!.text).toContain('minted by an agent rather than by a person');
    expect(joined!.text).toContain('device credential');
  }, 120_000);
});
