import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * An agent that registers an ENDPOINT keeps the secret its deliveries are
 * signed with.
 *
 * The API mints `webhook_secret` only when there is an endpoint to send to,
 * returns it exactly once, and signs every POST to that endpoint with it. The
 * CLI printed it. The SDK typed it. This client read straight past it, so an
 * agent that registered an endpoint through MCP was receiving signed requests
 * it had no way to verify -- and an endpoint that cannot check a signature is
 * an open door for anyone who finds the URL in a log.
 *
 * Nothing failed. Messages arrived. The secret was simply gone, once, quietly.
 *
 * Kept rather than printed, which is the convention beside it: the credential
 * is only read aloud when nothing wrote it down, because otherwise it is a
 * secret spoken into a transcript for no reason.
 */

const SERVER = resolve(__dirname, '..', 'src', 'index.ts');
const AGENT = 'u_endpointAgentAbCdEf';
const SECRET = 'fe'.repeat(32);
const ENDPOINT = 'https://agent.example.com/agentsignal';

let http: Server;
let baseUrl: string;
/** What the last registration asked for, so the stub can answer in kind. */
let lastEndpoint: string | undefined;

beforeAll(async () => {
  http = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const path = req.url ?? '';
      res.setHeader('Content-Type', 'application/json');

      if (path.startsWith('/v1/agents/register')) {
        let sent: { endpoint?: string } = {};
        try {
          sent = JSON.parse(raw || '{}');
        } catch {
          sent = {};
        }
        lastEndpoint = sent.endpoint;
        res.statusCode = 200;
        res.end(
          JSON.stringify({
            ok: true,
            created: true,
            agent: { handle: 'endpoint-agent', key: AGENT, id: 'a-9' },
            instance: { id: '99999999-4444-4555-8666-777777777777', instance_id: 'i-9' },
            device_secret: `99999999-4444-4555-8666-777777777777.${'ab'.repeat(32)}`,
            // Exactly what the API does: a secret when there is somewhere to
            // send, and null for an inbox reader with nothing to verify.
            webhook_secret: sent.endpoint ? SECRET : null,
            api_key_sealed: false,
            api_key_reason: null,
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
        AGENTSIGNAL_API_KEY: 'as_live_chan0009_akeythatregisters00000001',
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
        clientInfo: { name: 'endpoint-test', version: '1' },
      },
    });
    say({ jsonrpc: '2.0', method: 'notifications/initialized' });
    say({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    say({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name, arguments: args } });
  });
}

function stateDir(): string {
  return mkdtempSync(join(tmpdir(), 'agentsignal-endpoint-'));
}

/**
 * The saved identity, wherever it landed.
 *
 * Inside a checkout it is `agents/<slug>/agent.json`, and at the top level it
 * is `agent.json` -- so this looks for the file rather than assuming which
 * rule applied to the directory the test happened to run from.
 */
function storedFile(dir: string): string | null {
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true } as never) as unknown as {
    name: string;
    parentPath?: string;
    path?: string;
  }[]) {
    if (entry.name === 'agent.json') return join(entry.parentPath ?? entry.path ?? dir, entry.name);
  }
  return null;
}

function stored(dir: string): Record<string, unknown> {
  const file = storedFile(dir);
  if (!file) throw new Error(`no agent.json written anywhere under ${dir}`);
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
}

describe('registering with an endpoint', () => {
  it('keeps the secret its deliveries are signed with', async () => {
    const dir = stateDir();
    const { isError, text } = await callTool(
      'register_self',
      { handle: 'endpoint-agent', description: 'A service that listens.', endpoint: ENDPOINT },
      dir,
    );

    expect(isError, text).toBe(false);
    expect(lastEndpoint, 'the endpoint never reached the API').toBe(ENDPOINT);

    // THE ASSERTION THIS FILE EXISTS FOR. Not what was said -- what survived.
    expect(
      stored(dir).webhook_secret,
      'the signing secret was shown once and dropped; deliveries to this endpoint are now unverifiable',
    ).toBe(SECRET);
  }, 120_000);

  it('tells the agent to verify, because a secret nobody uses is no better', async () => {
    const dir = stateDir();
    const { text } = await callTool(
      'register_self',
      { handle: 'endpoint-agent', description: 'A service that listens.', endpoint: ENDPOINT },
      dir,
    );

    expect(text.toLowerCase()).toContain('verify');
    expect(text).toContain('docs/hosting-an-endpoint.md');
  }, 120_000);

  it('does not read the secret aloud when it has been written down', async () => {
    const dir = stateDir();
    const { text } = await callTool(
      'register_self',
      { handle: 'endpoint-agent', description: 'A service that listens.', endpoint: ENDPOINT },
      dir,
    );

    // Same bargain as the device credential beside it: saved means not spoken.
    expect(stored(dir).webhook_secret).toBe(SECRET);
    expect(text, 'a secret was spoken into the transcript despite being saved').not.toContain(
      SECRET,
    );
  }, 120_000);

  /**
   * The other half. Almost every agent has no endpoint, and a paragraph about
   * verifying signatures it will never receive is noise in a tool result that
   * is read by a model with better things to do.
   */
  it('says nothing about webhooks when there is no endpoint', async () => {
    const dir = stateDir();
    const { isError, text } = await callTool(
      'register_self',
      { handle: 'endpoint-agent', description: 'An ordinary inbox reader.' },
      dir,
    );

    expect(isError, text).toBe(false);
    expect(lastEndpoint).toBeUndefined();
    expect(stored(dir).webhook_secret).toBeUndefined();
    expect(text.toLowerCase()).not.toContain('signing secret');
  }, 120_000);
});
