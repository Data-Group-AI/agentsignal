import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { seal } from '@agentsignalnet/core';

/**
 * That an agent whose key was reissued keeps working.
 *
 * Reissuing from the dashboard revokes the old key IMMEDIATELY -- that is the
 * strict behaviour, chosen so a widened or narrowed key cannot be worked around
 * by holding on to the old one -- and seals the replacement into the agent's
 * inbox. The API says as much in its own response: "it is unauthenticated until
 * it reads its inbox."
 *
 * Nothing on this side kept that promise. `claimSealedKey` was gated on holding
 * NO key, which is true of an agent that has just joined and false of one whose
 * key was replaced: it holds a dead one. So the claim returned false, the
 * replacement was never opened, and every keyed tool 401'd forever -- through
 * restarts, since the dead key is reloaded from the identity file each time. The
 * button shipped yesterday was, from the agent's side, a way to disconnect an
 * agent permanently.
 *
 * None of that is visible in a unit test of either half. The sealing worked. The
 * delivery worked. The message was real, encrypted, addressed to the right
 * device, and read by nothing. So this test is end-to-end on purpose, and the
 * assertion that matters is the LAST one: that the server saw the retry arrive
 * bearing the new key. A test that only checked the call succeeded would pass
 * against a server that never rotated anything.
 */

const SERVER = resolve(__dirname, '..', 'src', 'index.ts');
const JOIN = { AGENTSIGNAL_JOIN_TOKEN: 'as_join_rkey0001_abcdefghijklmnopqrstuvwxyz01' };
const FIRST_KEY = 'as_live_rkey0001_thekeyitjoinedwith000001';
const REISSUED_KEY = 'as_live_rkey0001_thekeyitwasreissued00002';
const DEVICE_ID = '55555555-6666-4777-8888-999999999999';
const AGENT_KEY = 'u_reissueBotAbCdEfGhIj';

let http: Server;
let baseUrl: string;
/** The public key the agent published at registration, captured to seal for. */
let published: string | null = null;
/** Which key the channel currently considers live. Flipped to stage a reissue. */
let liveKey = FIRST_KEY;
/** Every Authorization the keyed endpoint was called with, in order. */
const presented: string[] = [];

beforeAll(async () => {
  http = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', async () => {
      const path = req.url ?? '';
      res.setHeader('Content-Type', 'application/json');

      if (path.startsWith('/v1/agents/register')) {
        try {
          published = (JSON.parse(raw) as { enc_public_key?: string }).enc_public_key ?? null;
        } catch {
          published = null;
        }
        res.statusCode = 200;
        res.end(
          JSON.stringify({
            agent: { handle: 'reissue-bot', key: AGENT_KEY, id: 'a-1' },
            device_secret: `${DEVICE_ID}.${'cd'.repeat(32)}`,
            created: true,
            api_key_sealed: true,
          }),
        );
        return;
      }

      // The keyed endpoint behind list_people, and the only thing in here that
      // checks a credential. It answers exactly as the API does: 401 with code
      // `unauthorized`, which is the signal the recovery keys off.
      if (path.startsWith('/v1/recipients')) {
        const bearer = (req.headers.authorization ?? '').replace(/^Bearer /, '');
        presented.push(bearer);
        if (bearer !== liveKey) {
          res.statusCode = 401;
          res.end(
            JSON.stringify({
              ok: false,
              error: { code: 'unauthorized', message: 'That API key is not valid.' },
            }),
          );
          return;
        }
        res.statusCode = 200;
        res.end(
          JSON.stringify({
            channel: { name: 'Reissue Test', is_sandbox: false },
            recipients: [{ key: 'u_personAbCdEfGhIjKlMn', name: 'Dana', devices: 1, reachable: true }],
          }),
        );
        return;
      }

      if (path.startsWith('/v1/devices/me/messages/') && path.endsWith('/content')) {
        if (!published) {
          res.statusCode = 404;
          res.end(JSON.stringify({ ok: false, error: { code: 'not_found' } }));
          return;
        }
        // Whatever the channel currently considers live -- so the same inbox
        // message means "your first key" before the reissue and "your new key"
        // after it, which is how the real one behaves.
        const { sealed } = await seal(liveKey, [{ device_id: DEVICE_ID, public_key: published }]);
        res.statusCode = 200;
        res.end(
          JSON.stringify({
            ok: true,
            ciphertext: sealed.ciphertext,
            nonce: sealed.nonce,
            wrapped_key: sealed.keys[0]!.wrapped_key,
            ephemeral_public_key: sealed.keys[0]!.ephemeral_public_key,
          }),
        );
        return;
      }

      if (path.startsWith('/v1/devices/me/messages')) {
        res.statusCode = 200;
        res.end(
          JSON.stringify({
            messages: [
              {
                delivery_id: 'eeeeeeee-1111-4222-8333-444444444444',
                message_id: 'ffffffff-1111-4222-8333-444444444444',
                title: 'Your AgentSignal key',
                body: null,
                priority: 0,
                options: null,
                created_at: new Date(0).toISOString(),
                read_at: null,
                encrypted: true,
              },
            ],
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

/**
 * One tool call in its own process.
 *
 * A separate process for the second call is the point, not an accident of the
 * harness: the failure being tested survives a restart, so a test that stayed
 * in the joining process would be testing the easier half.
 */
function callTool(
  name: string,
  args: Record<string, unknown>,
  stateDir: string,
  extraEnv: Record<string, string> = {},
): Promise<{ text: string; isError: boolean }> {
  return new Promise((resolveCall, reject) => {
    const child: ChildProcess = spawn('npx', ['tsx', SERVER], {
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        AGENTSIGNAL_BASE_URL: baseUrl,
        // Passed through so a spawned server obeys the same keychain switch as the
        // runner. Empty means "not set", which is what an ordinary run looks like.
        AGENTSIGNAL_NO_KEYCHAIN: process.env.AGENTSIGNAL_NO_KEYCHAIN ?? '',
        AGENTSIGNAL_STATE_DIR: stateDir,
        ...extraEnv,
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
        clientInfo: { name: 'reissue-test', version: '1' },
      },
    });
    say({ jsonrpc: '2.0', method: 'notifications/initialized' });
    say({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    say({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name, arguments: args } });
  });
}

describe('a key that was reissued out from under a running agent', () => {
  it('is claimed on the next keyed call, and the call goes through', async () => {
    const state = mkdtempSync(join(tmpdir(), 'agentsignal-reissue-'));

    // Join, and adopt the key sealed at that moment.
    const joined = await callTool('join_channel', { handle: 'reissue-bot' }, state, JOIN);
    expect(joined.isError, joined.text).toBe(false);

    // THE REISSUE. The old key stops being accepted the instant the owner
    // presses the button; the new one is sealed into the same inbox.
    liveKey = REISSUED_KEY;
    presented.length = 0;

    // A NEW PROCESS, and deliberately WITHOUT a join token. An agent whose key
    // was reissued has no reason to be holding one, and the advice this used to
    // give -- rejoin -- was unavailable as well as wrong.
    const listed = await callTool('list_people', {}, state);

    expect(listed.isError, listed.text).toBe(false);
    expect(listed.text).toContain('Dana');

    // THE ASSERTION THIS FILE EXISTS FOR. Succeeding is not enough: it has to
    // have succeeded by rotating. Two calls, the dead key first and the sealed
    // replacement second, is the shape of a recovery and nothing else produces
    // it.
    expect(presented).toEqual([FIRST_KEY, REISSUED_KEY]);

    // And the value never reaches anything a transcript keeps, which is the
    // reason the key is sealed rather than returned.
    expect(listed.text).not.toContain(REISSUED_KEY);
  }, 120_000);
});
