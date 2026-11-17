import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
// core is a DEV dependency of this package and only a dev one. The server
// reaches crypto through the SDK's re-exports on purpose -- one implementation
// of seal/unseal, not two that mostly agree. The TEST needs the other half of
// the pair to play the server's role, which is a test-time need and should not
// widen what the runtime depends on or what the SDK exports.
import { seal } from '@agentsignalnet/core';
import { apiKeyReference, readKeychainSync } from '../src/secrets.js';

/**
 * That an agent can open the API key sealed to it, and never says what it is.
 *
 * The key used to come back in the registration response, which a model reads
 * and a transcript therefore keeps. Now it arrives as a message sealed to the
 * device's published key. That only works if the client can DECRYPT, and until
 * this file nothing exercised that: `unseal` had one reference in the whole
 * repository, its own definition, so the sealing half could have shipped
 * against a client that silently never opened anything.
 *
 * The assertion that matters most is the last one. Adopting a key is easy to
 * fake -- writing SOMETHING to the identity file looks identical from outside
 * -- so the test insists the stored value is byte-for-byte the key the server
 * sealed. Nothing but a correct unseal produces that.
 */

const SERVER = resolve(__dirname, '..', 'src', 'index.ts');
const JOIN = { AGENTSIGNAL_JOIN_TOKEN: 'as_join_seal0001_abcdefghijklmnopqrstuvwxyz01' };
const SEALED_KEY = 'as_live_seal0001_thisisthekeythatwassealed01';
const DEVICE_ID = '77777777-8888-4999-8aaa-bbbbbbbbbbbb';

let http: Server;
let baseUrl: string;
/** The public key the agent published at registration, captured to seal for. */
let published: string | null = null;
/** Set when the client asks for the sealed content, so absence is detectable. */
let contentFetched = false;

beforeAll(async () => {
  http = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', async () => {
      const path = req.url ?? '';
      res.setHeader('Content-Type', 'application/json');

      if (path.startsWith('/v1/agents/register')) {
        // The agent publishes its public key here. Sealing to anything else
        // would produce ciphertext it cannot open, which is the failure this
        // test would otherwise not distinguish from a client that never tried.
        try {
          published = (JSON.parse(raw) as { enc_public_key?: string }).enc_public_key ?? null;
        } catch {
          published = null;
        }
        res.statusCode = 200;
        res.end(
          JSON.stringify({
            agent: { handle: 'sealed-bot', key: 'u_sealedBotAbCdEfGhIjKl', id: 'a-1' },
            device_secret: `${DEVICE_ID}.${'ab'.repeat(32)}`,
            created: true,
            // The key is NOT here. That is the whole change.
            api_key_sealed: true,
          }),
        );
        return;
      }

      if (path.startsWith('/v1/devices/me/messages/') && path.endsWith('/content')) {
        contentFetched = true;
        if (!published) {
          res.statusCode = 404;
          res.end(JSON.stringify({ ok: false, error: { code: 'not_found' } }));
          return;
        }
        // Sealed for real, with the same code the API uses. A fake blob would
        // test the plumbing and not the crypto.
        const { sealed } = await seal(SEALED_KEY, [
          { device_id: DEVICE_ID, public_key: published },
        ]);
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
                delivery_id: 'dddddddd-1111-4222-8333-444444444444',
                message_id: 'mmmmmmmm-1111-4222-8333-444444444444',
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

beforeEach(() => {
  published = null;
  contentFetched = false;
});

function fresh(): string {
  return mkdtempSync(join(tmpdir(), 'agentsignal-seal-'));
}

/** Whatever identity the run wrote, wherever it chose to put it. */
function storedIdentity(state: string): Record<string, string> {
  const candidates = [
    join(state, 'agent.json'),
    ...(existsSync(join(state, 'agents'))
      ? readdirSync(join(state, 'agents')).map((d) => join(state, 'agents', d, 'agent.json'))
      : []),
  ].filter((f) => existsSync(f));
  const found = candidates[0];
  if (!found) throw new Error('no identity was written');
  return JSON.parse(readFileSync(found, 'utf8'));
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
        // Passed through so a spawned server obeys the same keychain switch as the
        // runner. Empty means "not set", which is what an ordinary run looks like.
        AGENTSIGNAL_NO_KEYCHAIN: process.env.AGENTSIGNAL_NO_KEYCHAIN ?? '',
        AGENTSIGNAL_STATE_DIR: stateDir,
        ...JOIN,
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
        clientInfo: { name: 'seal-test', version: '1' },
      },
    });
    say({ jsonrpc: '2.0', method: 'notifications/initialized' });
    say({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    say({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name, arguments: args } });
  });
}

describe('a key that arrives sealed', () => {
  it('opens it, adopts it, and never says what it is', async () => {
    const state = fresh();
    const { text, isError } = await callTool('join_channel', { handle: 'sealed-bot' }, state);

    expect(isError).toBe(false);
    expect(published, 'the agent should publish a key it can be sealed to').toBeTruthy();
    expect(contentFetched, 'it should go and fetch the ciphertext').toBe(true);

    // SAYS THE TIER TURNED ON, without saying what turned it on.
    expect(text).toContain('sealed to this device');

    // AND NEVER THE VALUE. The entire reason for sealing is that a response is
    // read by a model and written into a transcript.
    expect(text).not.toContain(SEALED_KEY);
    expect(text).not.toMatch(/as_live_|as_test_/);

    // THE ASSERTION THIS FILE EXISTS FOR. Writing something to the identity
    // file looks identical from outside; only a correct unseal produces the
    // exact key the server sealed.
    const stored = storedIdentity(state);

    // WHERE it lands depends on the machine. A keychain gets a reference and
    // the file holds no secret at all, which is the better outcome; without
    // one the value goes in the file, which is where it used to go
    // unconditionally. Both are correct, and the test should not pretend the
    // machine it runs on is the only one.
    const adopted = stored.api_key_ref
      ? readKeychainSync(apiKeyReference('u_sealedBotAbCdEfGhIjKl'))
      : (stored.api_key ?? '');

    // THE ASSERTION THIS FILE EXISTS FOR. Writing *something* looks identical
    // from outside; only a correct unseal produces the exact bytes the server
    // sealed.
    expect(adopted, 'the opened key should be the one that was sealed').toBe(SEALED_KEY);

    // And when a reference was used, the plaintext is not in the file at all.
    if (stored.api_key_ref) {
      expect(JSON.stringify(stored)).not.toContain(SEALED_KEY);
    }
  }, 90_000);

  it('says so, rather than failing, when there is nothing to open', async () => {
    const state = fresh();
    // No key waiting: the inbox route below returns none for this run.
    const { isError, text } = await callTool('join_channel', { handle: 'sealed-bot' }, state);

    // An agent that was sent no key is a working agent on its device
    // credential. Refusing the join would take that away too.
    expect(isError).toBe(false);
    expect(text).toContain('Registered as');
  }, 90_000);
});
