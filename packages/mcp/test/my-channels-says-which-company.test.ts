import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * `my_channels` says which company, when there is more than one.
 *
 * A session works in one company -- a company being a set of rules, a billing
 * account, its own people and its own data -- and work done under the wrong one
 * went to the wrong company rather than to the wrong folder.
 *
 * That rule was written into three instruction files before this, and none of
 * them could be obeyed: the channel list carried ref, name, slug, is_home,
 * is_sandbox, mine and who created it, and NOT the account. So an agent asked
 * to settle which company it was working in had nothing to settle it with. The
 * rule existed and the fact did not.
 *
 * Printed only when the channels span more than one, because a label identical
 * on every line is the furniture the rail learned not to render -- and because
 * one company is not a decision.
 */

const SERVER = resolve(__dirname, '..', 'src', 'index.ts');
const KEY = 'as_live_chan0001_thekeyforthisagentschannel';

let http: Server;
let baseUrl: string;
let channels: unknown[] = [];

beforeAll(async () => {
  http = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if ((req.url ?? '').startsWith('/v1/channels')) {
        res.statusCode = 200;
        res.end(JSON.stringify({ ok: true, channels }));
        return;
      }
      if ((req.url ?? '').startsWith('/v1/devices/me/messages')) {
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

const channel = (over: Record<string, unknown>) => ({
  ref: 'chan0001',
  name: 'Default',
  slug: 'default',
  is_home: true,
  is_sandbox: false,
  mine: false,
  created_by: null,
  created_by_handle: null,
  members: 2,
  account: 'acct-one',
  company: 'Company One',
  ...over,
});

function callTool(name: string): Promise<string> {
  const state = mkdtempSync(join(tmpdir(), 'agentsignal-company-'));
  writeFileSync(
    join(state, 'agent.json'),
    JSON.stringify({
      base_url: baseUrl,
      handle: 'someone',
      key: 'u_someoneAbCdEfGhIjKl',
      credential: `99999999-8888-4777-8666-555555555555.${'ab'.repeat(32)}`,
      saved_at: new Date(0).toISOString(),
      api_key: KEY,
    }),
  );

  return new Promise((done, reject) => {
    const child: ChildProcess = spawn('npx', ['tsx', SERVER], {
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        AGENTSIGNAL_BASE_URL: baseUrl,
        AGENTSIGNAL_NO_KEYCHAIN: process.env.AGENTSIGNAL_NO_KEYCHAIN ?? '',
        AGENTSIGNAL_STATE_DIR: state,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
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
        let message: { id?: unknown; result?: { content?: { text?: string }[] } };
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id !== 10) continue;
        clearTimeout(timer);
        child.kill();
        done((message.result?.content ?? []).map((c) => c.text ?? '').join('\n'));
        return;
      }
    });
    child.on('error', reject);
    const say = (o: unknown) => child.stdin?.write(JSON.stringify(o) + '\n');
    say({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } },
    });
    say({ jsonrpc: '2.0', method: 'notifications/initialized' });
    say({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name, arguments: {} } });
  });
}

describe('my_channels says which company, when there is more than one', () => {
  it('says nothing about companies when they are all the same one', async () => {
    channels = [
      channel({}),
      channel({ ref: 'chan0002', name: 'Sandbox', slug: 'sandbox', is_home: false, is_sandbox: true }),
    ];
    const text = await callTool('my_channels');

    expect(text).toContain('Default');
    expect(text).toContain('Sandbox');
    // One company is not a decision, and a label repeated on every line is the
    // furniture this deliberately does not render.
    expect(text).not.toMatch(/Company One/);
    expect(text).not.toMatch(/DIFFERENT COMPANIES/);
  }, 60_000);

  it('names the company on every line, and says to ask, when they differ', async () => {
    channels = [
      channel({}),
      channel({
        ref: 'chan0002',
        name: 'Sandbox',
        slug: 'sandbox',
        is_home: false,
        account: 'acct-two',
        company: 'Company Two',
      }),
    ];
    const text = await callTool('my_channels');

    expect(text).toMatch(/in Company One/);
    expect(text).toMatch(/in Company Two/);
    // And the instruction, once, at the end. An agent that can see two and has
    // not been told to pick will pick anyway.
    expect(text).toMatch(/DIFFERENT COMPANIES/);
    expect(text).toMatch(/ask rather than defaulting/i);
  }, 60_000);

  /**
   * An older API sends no account at all. Treating that as a mismatch would
   * make every channel look like a different company and put the warning on
   * every list, against a server that simply has not been deployed yet.
   */
  it('stays quiet when the API does not say', async () => {
    channels = [
      channel({ account: undefined, company: undefined }),
      channel({ ref: 'chan0002', name: 'Sandbox', account: undefined, company: undefined }),
    ];
    const text = await callTool('my_channels');
    expect(text).toContain('Sandbox');
    expect(text).not.toMatch(/DIFFERENT COMPANIES/);
  }, 60_000);
});
