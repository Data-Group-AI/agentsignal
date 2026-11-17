import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * A ROSTER THAT COULD NOT BE READ IS NOT AN EMPTY ONE.
 *
 * /onboarding derives every step from real state rather than a stored flag,
 * which is right and is why this went unnoticed: it did ask, it just could not
 * say that the asking failed. `roster.error ? []` collapsed a refusal into an
 * empty list, and two steps then reported something FALSE rather than nothing.
 *
 *   "Have somebody to reach"    -> "nobody else in this channel yet"
 *   "Say what each agent does"  -> "all described"
 *
 * The second is the worse one. Zero agents means zero undescribed agents, so a
 * read that failed came back as a clean bill of health.
 *
 * Seen on 2026-08-23: a dashboard holding a key for a channel its session had
 * since left reported 0 people, indistinguishable from a channel that really
 * is empty. The key is still in the keychain, so the channel is listed at
 * startup and looks watched.
 *
 * Unknown must never render as done. That is the direction this failed in, and
 * it is the direction a status panel must not fail in.
 */

const VIEWER = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../plugins/agentsignal/scripts/dashboard.mjs',
);

const running: ChildProcess[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const child of running.splice(0)) {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
  for (const server of servers.splice(0)) await new Promise((r) => server.close(() => r(null)));
});

/**
 * An API that refuses the roster the way a revoked key is refused.
 *
 * 401 with a message, because the message is the thing the dashboard should be
 * repeating instead of inventing an empty channel.
 */
async function refusingApi() {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/v1/agents') {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: false,
          error: { code: 'unauthorized', message: 'that key is not in this channel' },
        }),
      );
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, channel: null, account: null, recipients: [], messages: [] }));
  });
  servers.push(server);
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(null)));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

async function dashboard(api: string) {
  const home = mkdtempSync(join(tmpdir(), 'agentsignal-unread-'));
  const state = mkdtempSync(join(tmpdir(), 'agentsignal-unread-state-'));
  mkdirSync(join(state, 'previous'), { recursive: true });
  writeFileSync(
    join(state, 'agent.json'),
    JSON.stringify({
      base_url: api,
      handle: 'now',
      key: 'u_now',
      credential: 'c',
      api_key: 'as_live_chanaaaa_abcdefghijklmnopqrstuvwxyz01',
    }),
  );

  const child = spawn(process.execPath, [VIEWER], {
    env: {
      PATH: process.env.PATH ?? '',
      HOME: home,
      PORT: '0',
      AGENTSIGNAL_BASE_URL: api,
      AGENTSIGNAL_NO_KEYCHAIN: '1',
      AGENTSIGNAL_STATE_DIR: state,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  running.push(child);

  let out = '';
  const printed = await new Promise<string | null>((done) => {
    const timer = setTimeout(() => done(null), 15_000);
    const look = (chunk: Buffer) => {
      out += chunk;
      const match = /Watching \S+ on (http:\/\/127\.0\.0\.1:\d+\/\?t=[0-9a-f-]{36})/.exec(out);
      if (match && /Loopback only/.test(out)) {
        clearTimeout(timer);
        done(match[1] ?? null);
      }
    };
    child.stdout?.on('data', look);
    child.stderr?.on('data', look);
  });
  expect(printed, `dashboard never started: ${out}`).toBeTruthy();

  const url = new URL(printed!);
  const origin = `http://127.0.0.1:${url.port}`;
  const first = await fetch(printed!);
  const cookie = (first.headers.get('set-cookie') ?? '').split(';')[0]!;
  const get = async (path: string) =>
    (await (await fetch(`${origin}${path}`, { headers: { Cookie: cookie } })).json()) as {
      steps: { id: string; done: boolean; detail: string }[];
    };
  return { get };
}

describe('a roster that could not be read', () => {
  it('does not report an unreadable channel as an empty one', async () => {
    const api = await refusingApi();
    const { get } = await dashboard(api);

    const body = await get('/onboarding');
    const step = (id: string) => body.steps.find((s) => s.id === id)!;

    const reach = step('reach');
    // THE CLAIM THAT WAS FALSE. The channel may be full; we could not look.
    expect(reach.detail).not.toMatch(/nobody else in this channel yet/);
    expect(reach.detail).toMatch(/could not read/i);
    // And it must not quietly repeat the upstream error as if it were a count.
    expect(reach.detail).toMatch(/not in this channel/);
    expect(reach.done, 'a step nothing could verify was reported as done').toBe(false);
  }, 60_000);

  /**
   * The quieter half, and the one that reads as good news.
   *
   * "all described" is what an empty list produces, because no agents means no
   * undescribed agents. A failed read therefore arrived as a completed step.
   */
  it('does not give a channel it never read a clean bill of health', async () => {
    const api = await refusingApi();
    const { get } = await dashboard(api);

    const role = (await get('/onboarding')).steps.find((s) => s.id === 'role')!;

    expect(role.detail).not.toMatch(/all described/);
    expect(role.detail).toMatch(/could not read/i);
    expect(role.done).toBe(false);
  }, 60_000);
});
