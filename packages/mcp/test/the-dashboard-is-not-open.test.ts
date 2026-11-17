import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * The chat dashboard's front door.
 *
 * It was a read-only window and is now a control surface: it can send
 * messages, approve an agent's proposal, mint an invitation, and register a
 * new agent. Every one of those is something a stranger would enjoy doing on
 * somebody else's behalf.
 *
 * It also spent its whole life bound to every interface, because
 * `server.listen(port)` with no host does that quietly. While it only read,
 * that was "anyone on this network can see your channel". With the write
 * routes it became "anyone on this network can page your colleagues".
 *
 * None of that had a test. It was checked by hand with curl, once, by
 * somebody who already knew the answer -- which is exactly the arrangement
 * that lets a boundary regress in silence, since nothing about a missing guard
 * looks different from a working one until it is used.
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

/** A stand-in AgentSignal, so no test ever reaches the real one. */
async function fakeApi() {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    if ((req.url ?? '').startsWith('/v1/agents')) {
      res.end(
        JSON.stringify({
          ok: true,
          channel: { name: 'Test', ref: 'test0001', is_sandbox: true },
          recipients: [{ key: 'u_someone', handle: 'someone', is_agent: true, reachable: true }],
        }),
      );
      return;
    }
    res.end(JSON.stringify({ ok: true, messages: [] }));
  });
  servers.push(server);
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(null)));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

/** Start the dashboard and hand back its port and the token it printed. */
async function dashboard(api: string) {
  const home = mkdtempSync(join(tmpdir(), 'agentsignal-dashboard-'));
  mkdirSync(join(home, 'state'), { recursive: true });
  // A credential, so the identity-dependent routes have something to work
  // with rather than being skipped for the wrong reason.
  writeFileSync(
    join(home, 'state', 'agent.json'),
    JSON.stringify({
      base_url: api,
      handle: 'someone',
      key: 'u_someone',
      credential: 'install.secret',
    }),
  );

  const child = spawn(process.execPath, [VIEWER], {
    env: {
      ...process.env,
      HOME: home,
      PORT: '0',
      AGENTSIGNAL_API_KEY: 'as_test_test0001_000000000000000000000000000000000',
      AGENTSIGNAL_BASE_URL: api,
      // Passed through so a spawned server obeys the same keychain switch as the
      // runner. Empty means "not set", which is what an ordinary run looks like.
      AGENTSIGNAL_NO_KEYCHAIN: process.env.AGENTSIGNAL_NO_KEYCHAIN ?? '',
      AGENTSIGNAL_STATE_DIR: join(home, 'state'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  running.push(child);

  let out = '';
  const printed = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`dashboard never printed a URL: ${out}`)), 12_000);
    const look = (chunk: Buffer) => {
      out += chunk;
      const match = /http:\/\/127\.0\.0\.1:(\d+)\/\?t=([0-9a-f-]{36})/.exec(out);
      // Both lines: the URL comes first and the loopback note after it, so
      // resolving on the URL alone snapshots the output mid-banner.
      if (match && /Loopback only/.test(out)) {
        clearTimeout(timer);
        resolve(match[0]);
      }
    };
    child.stdout?.on('data', look);
    child.stderr?.on('data', look);
  });

  const url = new URL(printed);
  return {
    port: url.port,
    token: url.searchParams.get('t')!,
    stateDir: join(home, 'state'),
    said: () => out,
  };
}

const status = async (u: string, init?: RequestInit) => (await fetch(u, init)).status;

describe('the dashboard is not open to whoever finds it', () => {
  it('refuses every route without the token, including the write ones', async () => {
    const api = await fakeApi();
    const v = await dashboard(api);
    const at = (p: string) => `http://127.0.0.1:${v.port}${p}`;

    // Flat 404 for everything the PAGE polls, still deliberately: these are
    // the routes a scanner would sweep, and each one that answers differently
    // is a fact about what is here. The two routes a PERSON types are the
    // exception and explain themselves -- see the test below for what they are
    // allowed to say, which is nothing about whose dashboard this is.
    expect(await status(at('/messages'))).toBe(404);
    expect(await status(at('/pending'))).toBe(404);
    expect(await status(at('/setup'))).toBe(404);

    const post = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' };
    // The four that DO something. A read leaking is bad; these page people,
    // approve an agent's work, mint a way into the channel, and register an
    // agent against the account.
    expect(await status(at('/send'), post)).toBe(404);
    expect(await status(at('/respond'), post)).toBe(404);
    expect(await status(at('/invite'), post)).toBe(404);
    expect(await status(at('/connect'), post)).toBe(404);
  }, 30_000);

  it('refuses a guessed token and accepts the printed one', async () => {
    const api = await fakeApi();
    const v = await dashboard(api);
    // 401 rather than 404 because `/` is a page: a wrong token gets the same
    // note a missing one does, and neither gets the channel.
    expect(await status(`http://127.0.0.1:${v.port}/?t=guess`)).toBe(401);
    expect(await status(`http://127.0.0.1:${v.port}/?t=${v.token}`)).toBe(200);
  }, 30_000);

  it('mints a different token each run, so closing it revokes the link', async () => {
    const api = await fakeApi();
    const first = await dashboard(api);
    const second = await dashboard(api);
    expect(first.token).not.toBe(second.token);
    // Yesterday's link must not open today's dashboard. It gets the note, not the
    // channel -- the point of the assertion is that it is not 200.
    expect(await status(`http://127.0.0.1:${second.port}/?t=${first.token}`)).toBe(401);
  }, 40_000);

  it('binds to loopback, not to this machine\u2019s other addresses', async () => {
    const api = await fakeApi();
    const v = await dashboard(api);

    const external = Object.values(networkInterfaces())
      .flat()
      .find((n) => n && n.family === 'IPv4' && !n.internal)?.address;

    expect(v.said()).toMatch(/Loopback only/);

    // Skipped rather than faked when there is no second address to try, which
    // is the case on an isolated CI box. The assertion above still holds.
    if (!external) return;
    await expect(
      fetch(`http://${external}:${v.port}/?t=${v.token}`, {
        signal: AbortSignal.timeout(3000),
      }),
    ).rejects.toThrow();
  }, 30_000);

  /**
   * The one thing the door is allowed to say.
   *
   * Every unauthenticated request used to be a flat 404, and somebody typing
   * the plain address got a page indistinguishable from a dead server -- they
   * reported the dashboard broken while it was working perfectly and had no way
   * to say so. The secrecy was buying little: reading this body needs a
   * same-origin read, so a process on this machine, which can already see the
   * port with `lsof`. A hostile page in a browser cannot read a cross-origin
   * response at all.
   *
   * So it may say a link is needed. It may not say WHOSE dashboard needs it, and
   * that is what these assertions pin.
   */
  it('explains itself to a person, without saying whose dashboard it is', async () => {
    const api = await fakeApi();
    const v = await dashboard(api);

    for (const path of ['/', '/a/some-handle']) {
      const response = await fetch(`http://127.0.0.1:${v.port}${path}`);
      expect(response.status).toBe(401);
      const body = await response.text();

      // Enough to end the confusion, and for the case this is USUALLY in: an
      // assistant started it in the background, so "look in the terminal" is a
      // dead end and the page has to say who to ask instead. That was the whole
      // of the first version's advice and somebody hit exactly that wall.
      expect(body).toContain('needs its link');
      expect(body).toMatch(/ask it for the link/);

      // And nothing else. A channel ref, an account name or a handle here
      // would hand an unauthenticated caller the thing the token protects.
      expect(body).not.toContain(v.token);
      expect(body.toLowerCase()).not.toContain('api key');
      expect(body).not.toContain('some-handle');
      expect(body).not.toMatch(/as_(live|test|join)_/);

      // Served at the address the real page will occupy, so a cached copy
      // would greet somebody again after their cookie was granted.
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
  }, 30_000);

  /**
   * The failure that reads as a crash and is usually a success.
   *
   * A second start on a taken port used to throw node's raw listen error --
   * "Unhandled 'error' event" and a stack through node:net -- which names no
   * remedy and buries the port. And the cause is nearly always a dashboard
   * ALREADY RUNNING and working, so the reader sees a crash while the thing
   * they wanted is up, needing only the link the first one printed.
   *
   * It then spent a while refusing politely instead, on the grounds that two
   * dashboards is how somebody reads a stale one. That was right about silence
   * and wrong about stopping: two dashboards is the SUPPORTED way to watch two
   * companies, so the collision is the ordinary path. It moves up a port and
   * pays off the silence by naming what it stepped over.
   */
  it('steps past a taken port and says so, rather than throwing a stack', async () => {
    const api = await fakeApi();
    const first = await dashboard(api);

    const clash = spawn(process.execPath, [VIEWER], {
      env: {
        ...process.env,
        PORT: first.port,
        AGENTSIGNAL_API_KEY: 'as_test_test0001_000000000000000000000000000000000',
        AGENTSIGNAL_BASE_URL: api,
        AGENTSIGNAL_NO_KEYCHAIN: process.env.AGENTSIGNAL_NO_KEYCHAIN ?? '',
        // The SAME state directory as the one it is about to collide with, so
        // it can find that one's link. Two dashboards on a machine share this;
        // splitting it here would test a pair that cannot exist.
        AGENTSIGNAL_STATE_DIR: first.stateDir,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    running.push(clash);

    let said = '';
    const landed = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 15_000);
      const look = (chunk: Buffer) => {
        said += chunk;
        if (/Loopback only/.test(said)) {
          clearTimeout(timer);
          resolve(true);
        }
      };
      clash.stdout?.on('data', look);
      clash.stderr?.on('data', look);
      clash.on('exit', () => {
        clearTimeout(timer);
        setTimeout(() => resolve(false), 50);
      });
    });

    // Starts, rather than refusing: the second one is usually the thing the
    // person actually wanted.
    expect(landed, said).toBe(true);
    expect(clash.exitCode).toBeNull();

    const mine = /Watching \S+ on http:\/\/127\.0\.0\.1:(\d+)\//.exec(said);
    expect(mine, said).toBeTruthy();
    expect(mine![1]).not.toBe(first.port);

    expect(said).toContain(`Port ${first.port} is already in use`);
    // Not silent about it. Both dashboards named, and the first one's link
    // handed over -- which is the only copy of it that is not inside a process.
    expect(said).toMatch(/already running/);
    expect(said).toMatch(/Both are now running/);
    expect(said).toContain(first.token);

    // No stack. That is the original complaint and it still stands.
    expect(said).not.toMatch(/node:net|Unhandled 'error' event/);
  }, 30_000);

  it('says nothing about itself on an unknown path', async () => {
    const api = await fakeApi();
    const v = await dashboard(api);
    const response = await fetch(`http://127.0.0.1:${v.port}/wp-admin?t=${v.token}`);
    const body = await response.text();
    expect(response.status).toBe(404);
    // With a valid token an unknown path may explain the real ones; without
    // one it must not, and the previous tests cover that. What it must never
    // do is hand a scanner the product name.
    expect(body.toLowerCase()).not.toContain('api key');
  }, 30_000);
});

describe('what the dashboard will not do', () => {
  it('refuses to answer as a recipient whose credential it does not hold', async () => {
    const api = await fakeApi();
    const v = await dashboard(api);
    const response = await fetch(`http://127.0.0.1:${v.port}/respond?t=${v.token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ delivery_id: 'd', as: 'u_notmine', option_index: 0 }),
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/No credential on this machine/);
  }, 30_000);

  it('refuses an answer that is not one of the three the API accepts', async () => {
    const api = await fakeApi();
    const v = await dashboard(api);
    // The API takes an index of 0, 1 or 2. Anything else is a page that has
    // drifted from the buttons it rendered, and forwarding it would turn a
    // client bug into a confusing server error.
    for (const option_index of [-1, 3, 'approve', null]) {
      const response = await fetch(`http://127.0.0.1:${v.port}/respond?t=${v.token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ delivery_id: 'd', as: 'u_someone', option_index }),
      });
      expect(response.status, `option_index ${JSON.stringify(option_index)}`).toBe(400);
    }
  }, 30_000);

  it('refuses to connect a directory that is not a checkout', async () => {
    const api = await fakeApi();
    const v = await dashboard(api);
    const response = await fetch(`http://127.0.0.1:${v.port}/connect?t=${v.token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: tmpdir(), handle: 'nowhere' }),
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/not inside a git repository/);
  }, 30_000);

  it('refuses to send with nothing to say', async () => {
    const api = await fakeApi();
    const v = await dashboard(api);
    const response = await fetch(`http://127.0.0.1:${v.port}/send?t=${v.token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: 'u_someone' }),
    });
    expect(response.status).toBe(400);
  }, 30_000);
});
