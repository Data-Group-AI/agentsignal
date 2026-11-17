import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * A SECOND DASHBOARD FINDS ITS OWN PORT, and leaves the first one findable.
 *
 * Two dashboards is not a mistake to be prevented -- it is the supported way to
 * watch two companies, because binding is per process and /bind refuses to
 * switch. So the collision on 8899 is the ordinary path, not the error path,
 * and it used to exit(1) with a stack-free but dead-end message.
 *
 * The other half is worse and is what this file mostly exists for. The link is
 * printed once, on stderr, and an agent starting this in the background prints
 * it into a tool result nobody reads again. The dashboard is then running,
 * healthy and unreachable: the bare address gets the guard's "Not found." and
 * the token lives only inside the process. Recovering it once meant finding the
 * pid and reading its open file descriptors to see where stderr had been
 * pointed. So the link is written down, per port, and the dashboard that
 * collides with a running one hands over ITS link on the way past.
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

/** Enough of the API for the dashboard to get as far as printing a link. */
async function fakeApi() {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: true,
        channel: { name: 'chan', ref: 'chanaaaa' },
        account: { id: 'acct-one', name: 'Company One' },
        recipients: [],
        messages: [],
      }),
    );
  });
  servers.push(server);
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(null)));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

/** Something in the way, so the dashboard has a real collision to handle. */
async function occupy(port = 0) {
  const server = createServer((_req, res) => res.end('not a dashboard'));
  servers.push(server);
  await new Promise((r) => server.listen(port, '127.0.0.1', () => r(null)));
  return (server.address() as { port: number }).port;
}

/** A port number nothing is on, for cases that need two starts to agree on one. */
async function freePort() {
  const server = createServer(() => {});
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(null)));
  const port = (server.address() as { port: number }).port;
  await new Promise((r) => server.close(() => r(null)));
  return port;
}

function scratch() {
  const home = mkdtempSync(join(tmpdir(), 'agentsignal-port-'));
  const state = mkdtempSync(join(tmpdir(), 'agentsignal-port-state-'));
  return { home, state };
}

/**
 * Start one, and read its output until it either prints a link or gives up.
 *
 * Resolving on EITHER means a test that expects a refusal does not sit for the
 * full timeout waiting for a link that is never coming.
 */
async function start(
  api: string,
  where: { home: string; state: string },
  env: Record<string, string> = {},
  args: string[] = [],
) {
  writeFileSync(
    join(where.state, 'agent.json'),
    JSON.stringify({
      base_url: api,
      handle: 'now',
      key: 'u_now',
      credential: 'c',
      api_key: 'as_test_chanaaaa_keyoneoneoneoneoneoneone01',
    }),
  );

  const child = spawn(process.execPath, [VIEWER, ...args], {
    env: {
      PATH: process.env.PATH ?? '',
      HOME: where.home,
      AGENTSIGNAL_BASE_URL: api,
      AGENTSIGNAL_NO_KEYCHAIN: '1',
      AGENTSIGNAL_STATE_DIR: where.state,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  running.push(child);

  let out = '';
  const settled = await new Promise<'link' | 'stopped' | null>((done) => {
    const timer = setTimeout(() => done(null), 20_000);
    const look = (chunk: Buffer) => {
      out += chunk;
      if (/Loopback only/.test(out)) {
        clearTimeout(timer);
        done('link');
      }
    };
    child.stdout?.on('data', look);
    child.stderr?.on('data', look);
    child.on('exit', () => {
      clearTimeout(timer);
      // A beat for the last write to arrive, so the refusal text is complete.
      setTimeout(() => done('stopped'), 50);
    });
  });

  expect(settled, `dashboard neither started nor stopped: ${out}`).toBeTruthy();
  /*
    ITS OWN link, off the "Watching ... on" line, not the first URL in the
    output. A dashboard that steps past a running one prints THAT one's link
    first, so the loose match returned the port this process could not have --
    and the assertion that the two differ passed the wrong way round.
  */
  const link = /Watching \S+ on (http:\/\/127\.0\.0\.1:(\d+)\/\?t=[0-9a-f-]{36})/.exec(out);
  return {
    out,
    settled,
    url: link?.[1] ?? null,
    port: link ? Number(link[2]) : null,
    child,
  };
}

describe('a second dashboard finds its own port', () => {
  /**
   * The collision is the ordinary path. Refusing to start left the person who
   * wanted a second company with an error and a homework assignment.
   */
  it('moves up a port instead of refusing to start', async () => {
    const api = await fakeApi();
    const busy = await occupy();

    const second = await start(api, scratch(), { PORT: String(busy) });

    expect(second.settled).toBe('link');
    expect(second.port).not.toBe(busy);
    expect(second.port).toBeGreaterThan(busy);
    // Announced, not silent: two dashboards running and no line saying so is
    // how somebody reads a stale one and wonders why it never updates.
    expect(second.out).toMatch(new RegExp(`Port ${busy} is already in use`));
    expect(second.out).toMatch(/Both are now running/);
  }, 60_000);

  /**
   * THE POINT OF WRITING THE LINK DOWN. The one that cannot have the port is
   * exactly the one holding the question "where is the dashboard that does".
   *
   * It arrives on the STAND-DOWN path rather than the walk-up, because a
   * dashboard that left a lock is settled before listen() is ever reached: the
   * same build stands down to it rather than stepping around it. Which is the
   * right place for it -- that message used to say "find the link it printed",
   * about a link printed once into a tool result nobody reads again.
   */
  it('hands over the running dashboard\'s link instead of telling you to find it', async () => {
    const api = await fakeApi();
    // ONE state directory, because that is what two dashboards on a machine
    // actually share. Splitting it splits the identities too, and a pair that
    // cannot see each other's keys is not the pair this is about.
    const where = scratch();
    const port = await freePort();

    const first = await start(api, where, { PORT: String(port) });
    expect(first.settled).toBe('link');
    expect(first.port).toBe(port);

    const second = await start(api, where, { PORT: String(port) });

    // Same build, so it stands down rather than superseding or moving.
    expect(second.settled).toBe('stopped');
    expect(second.child.exitCode).toBe(0);
    expect(second.out).toMatch(/same build or newer/);
    // The whole recovery: the first one's link, token and all, without anybody
    // reading a file descriptor.
    expect(second.out).toContain(first.url!);
    expect(second.out).not.toMatch(/find the link it printed/i);
  }, 60_000);

  /**
   * A number typed at the moment of running is an instruction. Landing
   * somewhere else would print a link to a port nobody asked for.
   */
  it('refuses a busy --port rather than moving, and says to drop the flag', async () => {
    const api = await fakeApi();
    const busy = await occupy();

    const tried = await start(api, scratch(), {}, ['--port', String(busy)]);

    expect(tried.settled).toBe('stopped');
    expect(tried.url).toBeNull();
    expect(tried.child.exitCode).toBe(1);
    expect(tried.out).toMatch(new RegExp(`Port ${busy} is already in use, so this did not start`));
    expect(tried.out).toMatch(/--port, so no other one was tried/);
    expect(tried.out).toMatch(/Drop the flag/);
  }, 60_000);

  /** A typo reached listen() as NaN, which meant "any free port" -- so it started. */
  it('will not start on a port that is not a number', async () => {
    const api = await fakeApi();

    const tried = await start(api, scratch(), {}, ['--port', 'quite-high']);

    expect(tried.settled).toBe('stopped');
    expect(tried.url).toBeNull();
    expect(tried.out).toMatch(/is not a port/);
  }, 60_000);

  /**
   * `--port` with the number left off. Falling back to 8899 would obey a
   * command nobody finished typing, and an empty value reaches listen() as 0 --
   * which node reads as "any free port", so it would have started somewhere
   * unpredictable and looked like it worked.
   */
  it('will not start on a --port with no number after it', async () => {
    const api = await fakeApi();

    const tried = await start(api, scratch(), {}, ['--port']);

    expect(tried.settled).toBe('stopped');
    expect(tried.url).toBeNull();
    expect(tried.out).toMatch(/is not a port/);
  }, 60_000);

  /** An empty PORT is what an unset one looks like after a spawn passes it on. */
  it('treats an empty PORT as unset rather than as port 0', async () => {
    const api = await fakeApi();

    const tried = await start(api, scratch(), { PORT: '' });

    expect(tried.settled).toBe('link');
    // The default, or the walk up from it -- never one of the high ephemeral
    // ports the OS hands out for 0, which is where Number('') would have led.
    expect(tried.port).toBeGreaterThanOrEqual(8899);
    expect(tried.port).toBeLessThan(8909);
  }, 60_000);

  /**
   * The token is a credential that can send, answer, invite and page real
   * devices. Written down at all, it must be written down for one user only.
   */
  it('writes the link readable by nobody else, and takes it back on exit', async () => {
    const api = await fakeApi();
    const where = scratch();

    const only = await start(api, where, { PORT: '0' });
    expect(only.settled).toBe('link');

    const path = join(where.state, `dashboard-${only.port}.meta.json`);
    const saved = JSON.parse(readFileSync(path, 'utf8'));
    expect(saved.url).toBe(only.url);
    expect(saved.pid).toBe(only.child.pid);
    // 0600. A token in a world-readable file is the same token, handed out.
    expect(statSync(path).mode & 0o077).toBe(0);

    // PORT=0 records where it is and still claims nothing: the pidfile IS the
    // lock, and "any free port" opted out of superseding anybody.
    expect(existsSync(join(where.state, `dashboard-${only.port}.pid`))).toBe(false);

    only.child.kill('SIGTERM');
    await new Promise((r) => only.child.on('exit', () => r(null)));
    await new Promise((r) => setTimeout(r, 200));

    // Closing the dashboard still revokes the token, which is only true if the
    // file goes with the process that minted it.
    expect(() => readFileSync(path, 'utf8')).toThrow();
  }, 60_000);

  /**
   * A file outliving its process names a port nothing answers on. Offering that
   * link sends somebody to a refused connection with no idea why.
   */
  it('does not offer a link left behind by a dashboard that died', async () => {
    const api = await fakeApi();
    const where = scratch();
    const busy = await occupy();

    mkdirSync(where.state, { recursive: true });
    writeFileSync(
      join(where.state, `dashboard-${busy}.meta.json`),
      JSON.stringify({
        url: `http://127.0.0.1:${busy}/?t=00000000-0000-4000-8000-000000000000`,
        // Nothing is running here. A pid this high is not in use on a fresh
        // machine, and being wrong costs one refused connection, not a lie.
        pid: 999_999,
        base_url: api,
        started_at: new Date().toISOString(),
      }),
    );

    const second = await start(api, where, { PORT: String(busy) });

    expect(second.settled).toBe('link');
    expect(second.out).not.toMatch(/A dashboard is already running there/);
    expect(second.out).not.toContain('00000000-0000-4000-8000-000000000000');
    expect(second.out).toMatch(/left no link/);
  }, 60_000);
});
