import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * The watcher waits instead of asking.
 *
 * It asked `/v1/devices/me/messages` every two seconds per identity, forever:
 * about 43,200 requests a machine a day to be told "nothing" almost every
 * time, and still up to two seconds of dead time on the one occasion something
 * had arrived. `?wait=` holds the request open and the server rings as it
 * writes the delivery row, so the request count collapses and the latency goes
 * with it.
 *
 * THE FALLBACK IS THE DANGEROUS HALF, and it is why this file exists rather
 * than a latency assertion on its own. The loop has no timer any more -- the
 * wait IS the delay -- so against a server that answers an empty inbox
 * instantly, it would spin at the floor. That is not a degraded fallback; it
 * is several times MORE traffic than the polling this replaced. So the second
 * test here matters more than the first.
 */

const DAEMON = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../plugins/agentsignal/scripts/inbox-daemon.mjs',
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
  for (const server of servers.splice(0)) {
    await new Promise((resolve) => server.close(resolve));
  }
});

/** A stand-in API. `hold` decides whether it answers or waits. */
async function fakeApi(options: {
  /** Hold an empty answer open for this long, as a real `?wait=` server does. */
  holdMs: number | null;
  /** What to advertise as the doorbell, if anything. */
  pushUrl?: string | null;
}) {
  const hits: { at: number; wait: string | null }[] = [];
  /** Set to hand the next poll a message. */
  const pending: unknown[] = [];

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    /*
      The watcher asks the API where the doorbell is before connecting to one,
      so a stand-in API has to answer that too. `pushUrl` is set per test: a
      doorbell is advertised only when a test has one running.
    */
    if (url.pathname.endsWith('/v1/devices/me')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, device_id: 'device-under-test', push_url: options.pushUrl ?? null }));
      return;
    }
    if (!url.pathname.endsWith('/v1/devices/me/messages')) {
      res.writeHead(404).end('{}');
      return;
    }
    const wait = url.searchParams.get('wait');
    hits.push({ at: Date.now(), wait });

    const answer = (waitedMs?: number) => {
      const messages = pending.splice(0);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          messages,
          // Only a server that actually waited reports this, which is exactly
          // what the client latches on.
          ...(waitedMs === undefined ? {} : { waited_ms: waitedMs }),
        }),
      );
    };

    // No wait asked for, or this server does not do them: answer at once and
    // say nothing about waiting.
    if (!wait || options.holdMs === null) {
      answer();
      return;
    }

    const started = Date.now();
    const timer = setInterval(() => {
      const elapsed = Date.now() - started;
      if (pending.length > 0 || elapsed >= options.holdMs!) {
        clearInterval(timer);
        answer(elapsed);
      }
    }, 25);
    req.on('close', () => clearInterval(timer));
  });

  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return { base: `http://127.0.0.1:${port}`, hits, pending };
}

/**
 * A server that tells identities apart by their credential, and holds every
 * request open until there is something for THAT one.
 */
async function apiPerIdentity() {
  const hits: { secret: string; at: number }[] = [];
  const pending = new Map<string, unknown[]>();

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (!url.pathname.endsWith('/v1/devices/me/messages')) {
      res.writeHead(404).end('{}');
      return;
    }
    const secret = (req.headers.authorization ?? '').replace(/^Device\s+/i, '');
    hits.push({ secret, at: Date.now() });

    const started = Date.now();
    const timer = setInterval(() => {
      const waiting = pending.get(secret) ?? [];
      const elapsed = Date.now() - started;
      if (waiting.length > 0 || elapsed >= 25_000) {
        clearInterval(timer);
        pending.set(secret, []);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, messages: waiting, waited_ms: elapsed }));
      }
    }, 25);
    req.on('close', () => clearInterval(timer));
  });

  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    base: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    hits,
    give: (secret: string, message: unknown) => pending.set(secret, [message]),
  };
}

/** One machine, two agents -- which is ordinary: one per checkout. */
function machineWithTwo(base: string) {
  const home = mkdtempSync(join(tmpdir(), 'agentsignal-two-'));
  const root = join(home, '.claude', 'plugins', 'data');
  const make = (name: string, credential: string) => {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'agent.json'),
      JSON.stringify({ credential, base_url: base, handle: name }),
    );
    return { dir, credential, spool: join(dir, 'inbox-spool.json') };
  };
  return {
    home,
    data: root,
    first: make('agentsignal-agentsignal', 'first.secret'),
    second: make('agentsignal-other', 'second.secret'),
  };
}

function machine(base: string) {
  const home = mkdtempSync(join(tmpdir(), 'agentsignal-wait-'));
  const data = join(home, '.claude', 'plugins', 'data', 'agentsignal-agentsignal');
  mkdirSync(data, { recursive: true });
  writeFileSync(
    join(data, 'agent.json'),
    JSON.stringify({ credential: 'install.secret', base_url: base, handle: 'waiter' }),
  );
  return { home, data: join(home, '.claude', 'plugins', 'data'), spool: join(data, 'inbox-spool.json') };
}

function start(home: string, data: string, base: string, extra: Record<string, string> = {}) {
  const inherited = { ...process.env };
  delete inherited.AGENTSIGNAL_STATE_DIR;
  delete inherited.AGENTSIGNAL_DEVICE_SECRET;

  const child = spawn(process.execPath, [DAEMON, 'watch'], {
    env: {
      ...inherited,
      HOME: home,
      CLAUDE_PLUGIN_DATA: data,
      AGENTSIGNAL_BASE_URL: base,
      AGENTSIGNAL_NO_KEYCHAIN: '1',
      ...extra,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  running.push(child);
  let out = '';
  child.stdout?.on('data', (c) => (out += c));
  child.stderr?.on('data', (c) => (out += c));
  return { child, said: () => out };
}

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('the watcher waits instead of asking', () => {
  /**
   * Against a server that holds requests open, ten seconds of watching should
   * cost about one request rather than five.
   */
  it('asks once and waits, rather than asking every two seconds', async () => {
    const api = await fakeApi({ holdMs: 30_000 });
    const { home, data } = machine(api.base);
    const watcher = start(home, data, api.base);

    await settle(10_000);

    expect(watcher.child.exitCode, watcher.said()).toBeNull();
    // Five polls in ten seconds is what the old cadence would have produced.
    // Two allows for the startup poll and one cycle boundary.
    expect(api.hits.length, `hits: ${api.hits.length}\n${watcher.said()}`).toBeLessThanOrEqual(2);
    expect(api.hits.length).toBeGreaterThan(0);
    // And it actually asked for a wait rather than getting lucky.
    expect(api.hits.at(0)?.wait).toBe('25');
  }, 40_000);

  /**
   * THE ONE THAT MATTERS. A server that answers instantly and does not say it
   * waited must put the client back on a timer. Without the latch the loop
   * spins at its 250ms floor -- four requests a second, against the two
   * seconds this replaced.
   */
  it('falls back to a timer against a server that does not hold the request', async () => {
    const api = await fakeApi({ holdMs: null });
    const { home, data } = machine(api.base);
    const watcher = start(home, data, api.base);

    await settle(8_000);

    expect(watcher.child.exitCode, watcher.said()).toBeNull();
    expect(watcher.said()).toMatch(/falling back to polling on a timer/);

    // At the 250ms floor this would be about 32. On the interval it is about
    // 4. Ten is comfortably between them and fails loudly on a spin.
    expect(
      api.hits.length,
      `spinning: ${api.hits.length} requests in 8s\n${watcher.said()}`,
    ).toBeLessThan(10);

    // It also stops asking for a wait it now knows is not honoured.
    expect(api.hits.at(-1)?.wait).toBeNull();
  }, 40_000);

  /**
   * A message written while the watcher is parked has to land in the spool
   * without waiting for the hold to expire.
   */
  it('picks up a message that arrives while it is parked', async () => {
    const api = await fakeApi({ holdMs: 30_000 });
    const { home, data, spool } = machine(api.base);
    const watcher = start(home, data, api.base);

    // Let it get parked before anything exists to find.
    await settle(3_000);
    const before = api.hits.length;

    api.pending.push({
      delivery_id: 'd-1',
      message_id: 'm-1',
      title: 'Sent while you waited',
      body: 'here',
      urgency: 'normal',
      created_at: new Date().toISOString(),
    });

    await settle(3_000);

    const written = JSON.parse(readFileSync(spool, 'utf8'));
    expect(
      written.messages.map((m: { delivery_id: string }) => m.delivery_id),
      watcher.said(),
    ).toContain('d-1');
    // It did not need a new cadence of requests to notice.
    expect(api.hits.length - before).toBeLessThanOrEqual(2);
  }, 40_000);
});

/**
 * TWO INBOXES ON ONE MACHINE, which is ordinary rather than exotic: one agent
 * per checkout, and this repo's own machine has run five at once.
 *
 * Polling them was sequential, and that was right while a poll returned at
 * once -- a handful of small requests cost a few hundred milliseconds. Holding
 * the request open changes it completely: waiting on the first identity for
 * twenty-five seconds means the second is not even ASKED for twenty-five
 * seconds, the third fifty, and a latency fix becomes a latency bug that gets
 * worse the more agents a machine runs.
 *
 * The change to concurrent shipped with that argument written in a comment and
 * nothing exercising it -- every daemon test in this repo watches exactly one
 * identity. This is that gap.
 */
describe('two inboxes on one machine', () => {
  it('does not make the second identity wait for the first', async () => {
    const api = await apiPerIdentity();
    const { home, data, second } = machineWithTwo(api.base);
    const watcher = start(home, data, api.base);

    // Both parked before anything exists to find.
    await settle(3_000);
    expect(
      new Set(api.hits.map((h) => h.secret)).size,
      `only one identity was asked:\n${watcher.said()}`,
    ).toBe(2);

    // Something for the SECOND one only. If the poll is sequential, this waits
    // out the first identity's full hold before it is even requested.
    api.give('second.secret', {
      delivery_id: 'd-second',
      message_id: 'm-second',
      title: 'For the second agent',
      body: 'here',
      urgency: 'normal',
      created_at: new Date().toISOString(),
    });

    const sent = Date.now();
    let landed = 0;
    while (Date.now() - sent < 15_000 && !landed) {
      try {
        const spool = JSON.parse(readFileSync(second.spool, 'utf8')) as {
          messages: { delivery_id: string }[];
        };
        if (spool.messages.some((m) => m.delivery_id === 'd-second')) landed = Date.now() - sent;
      } catch {
        /* not written yet */
      }
      await settle(100);
    }

    expect(landed, `never landed:\n${watcher.said()}`).toBeGreaterThan(0);
    // Sequential would be twenty-five seconds. Five is generous and still fails
    // loudly if the second identity is queued behind the first.
    expect(landed, `took ${landed}ms, which is the first identity's hold`).toBeLessThan(5_000);
  }, 60_000);
});

/**
 * A doorbell the watcher holds open.
 *
 * The long poll works and costs more than it looks: the held request is
 * answered by a Durable Object, billed on wall-clock time at 128MB whether it
 * uses it or not, and one continuously watching agent runs to 83% of the whole
 * included monthly allowance. A plain server holding a socket costs the memory
 * of a socket.
 *
 * So a doorbell arrives down a connection somebody else is holding, and the
 * watcher stops asking the API to hold anything. What must be true is that it
 * delivers, that it costs the API almost nothing while it is up, and -- most
 * importantly -- that losing it is survivable rather than silent.
 */
describe('a doorbell the watcher holds open', () => {
  /** A stand-in doorbell: holds the response open and rings on demand. */
  async function fakeDoorbell() {
    const open: ServerResponse[] = [];
    const server = createServer((req, res) => {
      if (!(req.url ?? '').includes('/v1/wake')) {
        res.writeHead(404).end('{}');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      res.write(': subscribed\n\n');
      open.push(res);
      req.on('close', () => {
        const at = open.indexOf(res);
        if (at >= 0) open.splice(at, 1);
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return {
      url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
      connections: () => open.length,
      ring: () => {
        for (const res of open) res.write(`data: ${JSON.stringify({ type: 'wake' })}\n\n`);
      },
      hangUp: () => {
        for (const res of open.splice(0)) res.destroy();
      },
    };
  }

  /**
   * THE PATH A REAL AGENT TAKES, and the one that was inert.
   *
   * The watcher read AGENTSIGNAL_PUSH_URL from its environment and nothing
   * ever set it -- not the hook, not the install, not the plugin. The doorbell
   * was deployed, reachable, and verified end to end by hand, and no watcher
   * would have connected to it. Every other test in this describe passes the
   * variable in, which is exactly why none of them caught it.
   *
   * So the API advertises it, and the watcher asks. No variable here.
   */
  it('finds the doorbell by asking the API, with nothing in its environment', async () => {
    const bell = await fakeDoorbell();
    const api = await fakeApi({ holdMs: 30_000, pushUrl: bell.url });
    const { home, data, spool } = machine(api.base);
    const watcher = start(home, data, api.base);

    await settle(4_000);
    expect(
      bell.connections(),
      `it never found the doorbell:\n${watcher.said()}`,
    ).toBe(1);

    api.pending.push({
      delivery_id: 'd-discovered',
      message_id: 'm-discovered',
      title: 'Found without being told',
      body: 'here',
      urgency: 'normal',
      created_at: new Date().toISOString(),
    });
    bell.ring();

    let landed = false;
    const rungAt = Date.now();
    while (Date.now() - rungAt < 8_000 && !landed) {
      try {
        const written = JSON.parse(readFileSync(spool, 'utf8')) as {
          messages: { delivery_id: string }[];
        };
        landed = written.messages.some((m) => m.delivery_id === 'd-discovered');
      } catch {
        /* not written yet */
      }
      await settle(50);
    }
    expect(landed, `never landed:\n${watcher.said()}`).toBe(true);
  }, 60_000);

  it('fetches the moment it is rung, without asking the API to wait', async () => {
    const api = await fakeApi({ holdMs: 30_000 });
    const bell = await fakeDoorbell();
    const { home, data, spool } = machine(api.base);
    const watcher = start(home, data, api.base, { AGENTSIGNAL_PUSH_URL: bell.url });

    // Let it connect and settle into its slow safety poll.
    await settle(4_000);
    expect(bell.connections(), `never connected:\n${watcher.said()}`).toBe(1);

    const asked = api.hits.length;
    api.pending.push({
      delivery_id: 'd-rung',
      message_id: 'm-rung',
      title: 'Rung, not asked for',
      body: 'here',
      urgency: 'normal',
      created_at: new Date().toISOString(),
    });

    const rungAt = Date.now();
    bell.ring();

    let landed = 0;
    while (Date.now() - rungAt < 10_000 && !landed) {
      try {
        const written = JSON.parse(readFileSync(spool, 'utf8')) as {
          messages: { delivery_id: string }[];
        };
        if (written.messages.some((m) => m.delivery_id === 'd-rung')) landed = Date.now() - rungAt;
      } catch {
        /* not written yet */
      }
      await settle(50);
    }

    expect(landed, `never landed:\n${watcher.said()}`).toBeGreaterThan(0);
    expect(landed, `took ${landed}ms`).toBeLessThan(3_000);

    // THE COST, which is the whole reason for this. A rung watcher asks once,
    // and asks for no wait -- so the Durable Object behind `?wait=` is never
    // involved at all.
    expect(api.hits.length - asked).toBeLessThanOrEqual(2);
    expect(api.hits.at(-1)?.wait, 'it still asked the API to hold the request open').toBeNull();
  }, 60_000);

  /**
   * THE ONE THAT MAKES A SINGLE MACHINE ACCEPTABLE IN FRONT OF DELIVERY. No
   * doorbell must mean slower, never quieter.
   */
  it('falls back to the long poll when there is no doorbell at all', async () => {
    const api = await fakeApi({ holdMs: 30_000 });
    const { home, data } = machine(api.base);
    const watcher = start(home, data, api.base, {
      AGENTSIGNAL_PUSH_URL: 'http://127.0.0.1:9',
    });

    await settle(6_000);

    expect(watcher.child.exitCode, watcher.said()).toBeNull();
    expect(watcher.said()).toMatch(/no doorbell/);
    expect(watcher.said()).toMatch(/messages will arrive on the poll/);
    // And it is holding the request open again, which is the fallback working.
    expect(api.hits.at(-1)?.wait).toBe('25');
  }, 60_000);

  it('goes back to holding the request open if the doorbell drops', async () => {
    const api = await fakeApi({ holdMs: 30_000 });
    const bell = await fakeDoorbell();
    const { home, data } = machine(api.base);
    const watcher = start(home, data, api.base, { AGENTSIGNAL_PUSH_URL: bell.url });

    await settle(4_000);
    expect(bell.connections()).toBe(1);

    bell.hangUp();
    await settle(6_000);

    // Whatever it does about reconnecting, the poll must have gone back to
    // carrying the latency -- a watcher that kept resting on a doorbell that
    // is gone is a watcher that has stopped watching.
    expect(api.hits.at(-1)?.wait).toBe('25');
  }, 60_000);
});
