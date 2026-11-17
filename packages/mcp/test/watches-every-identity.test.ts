import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * One watcher, every identity on the machine.
 *
 * Identities became per-checkout so a laptop with two projects could be in two
 * accounts. The watcher still followed the first one it found, which meant the
 * second agent was registered, addressable, and never interrupted anybody --
 * its messages sitting in an inbox nothing read, which is indistinguishable
 * from a channel where nothing is happening.
 *
 * Still one process: the lock stays machine-wide, because what must not happen
 * twice is a message being delivered twice, and that is a property of the
 * process rather than of the credential.
 *
 * These drive the real script against a real HTTP server, because the thing
 * under test is which credentials go out on the wire.
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
  for (const server of servers.splice(0)) await new Promise((r) => server.close(() => r(null)));
});

/** An inbox endpoint that records who asked, and can reject one caller. */
async function inbox(reject: string[] = []) {
  const asked: string[] = [];
  const server = createServer((req, res) => {
    const secret = (req.headers.authorization ?? '').replace(/^Device\s+/i, '');
    asked.push(secret);
    if (reject.includes(secret)) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'gone' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ messages: [] }));
  });
  servers.push(server);
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(null)));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, asked };
}

function identity(dir: string, credential: string, baseUrl: string, handle: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'agent.json'),
    JSON.stringify({ base_url: baseUrl, handle, key: `u_${handle}`, credential }),
  );
}

function startDaemon(home: string, pluginData: string, baseUrl: string) {
  const env = { ...process.env };
  delete env.AGENTSIGNAL_STATE_DIR;
  delete env.AGENTSIGNAL_DEVICE_SECRET;
  const child = spawn(process.execPath, [DAEMON, 'watch', '--interval', '1'], {
    env: { ...env, HOME: home, CLAUDE_PLUGIN_DATA: pluginData, AGENTSIGNAL_BASE_URL: baseUrl },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  running.push(child);
  let out = '';
  child.stdout?.on('data', (c) => (out += c));
  child.stderr?.on('data', (c) => (out += c));
  return { child, said: () => out, alive: () => child.exitCode === null };
}

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('one watcher, every identity', () => {
  it('polls a sibling directory and a per-checkout one alike', async () => {
    const api = await inbox();
    const home = mkdtempSync(join(tmpdir(), 'agentsignal-many-'));
    const data = join(home, '.claude', 'plugins', 'data');
    const own = join(data, 'agentsignal-agentsignal');
    mkdirSync(own, { recursive: true });

    // The two shapes an identity can have: one written by a differently-named
    // server beside this one, and one written from inside a checkout.
    identity(join(data, 'agentsignal-inline'), 'secret-sibling', api.url, 'sibling');
    identity(join(own, 'agents', 'my-project-abc123abc123'), 'secret-checkout', api.url, 'checkout');

    const daemon = startDaemon(home, own, api.url);
    await settle(3500);

    expect(daemon.alive(), daemon.said()).toBe(true);
    expect(new Set(api.asked)).toContain('secret-sibling');
    expect(new Set(api.asked), 'the per-checkout identity must be polled too').toContain(
      'secret-checkout',
    );

    // A spool beside each credential, which is where the hooks look.
    expect(existsSync(join(data, 'agentsignal-inline', 'inbox-spool.json'))).toBe(true);
    expect(
      existsSync(join(own, 'agents', 'my-project-abc123abc123', 'inbox-spool.json')),
    ).toBe(true);
  }, 25_000);

  it('drops a rejected credential without taking the others down', async () => {
    const api = await inbox(['secret-dead']);
    const home = mkdtempSync(join(tmpdir(), 'agentsignal-401-'));
    const data = join(home, '.claude', 'plugins', 'data');
    const own = join(data, 'agentsignal-agentsignal');
    mkdirSync(own, { recursive: true });

    identity(join(data, 'agentsignal-inline'), 'secret-dead', api.url, 'deleted-agent');
    identity(join(own, 'agents', 'live-project-def456def456'), 'secret-live', api.url, 'still-here');

    const daemon = startDaemon(home, own, api.url);
    await settle(3000);
    const asked = api.asked.length;
    await settle(2500);

    // A deleted agent used to stop the process. On a machine watching several
    // that takes everybody else's interruptions with it, and they have no way
    // to report it -- going quiet is exactly what the failure looks like.
    expect(daemon.alive(), `daemon died: ${daemon.said()}`).toBe(true);
    expect(daemon.said()).toMatch(/401/);
    expect(daemon.said()).toMatch(/other identities continue/);

    // And it stopped asking with the dead one rather than retrying it forever.
    const deadAfter = api.asked.slice(asked).filter((s) => s === 'secret-dead').length;
    expect(deadAfter, 'a rejected credential should not be retried').toBe(0);
    expect(api.asked.slice(asked)).toContain('secret-live');
  }, 25_000);

  it('picks up an identity that registers after it started', async () => {
    const api = await inbox();
    const home = mkdtempSync(join(tmpdir(), 'agentsignal-late-'));
    const data = join(home, '.claude', 'plugins', 'data');
    const own = join(data, 'agentsignal-agentsignal');
    mkdirSync(own, { recursive: true });
    identity(join(data, 'agentsignal-inline'), 'secret-first', api.url, 'first');

    const daemon = startDaemon(home, own, api.url);
    await settle(2000);

    // Joining happens mid-session -- that is the whole point of a join code --
    // and nothing restarts the daemon when it does, because a hook that finds
    // one running stands down. Read once at startup, this identity would never
    // be watched.
    identity(join(own, 'agents', 'late-project-999999999999'), 'secret-late', api.url, 'late');
    await settle(3000);

    expect(daemon.alive(), daemon.said()).toBe(true);
    expect(new Set(api.asked)).toContain('secret-late');
  }, 25_000);

  it('does not poll one identity twice for being reachable by two paths', async () => {
    const api = await inbox();
    const home = mkdtempSync(join(tmpdir(), 'agentsignal-dupe-'));
    const data = join(home, '.claude', 'plugins', 'data');
    const own = join(data, 'agentsignal-agentsignal');
    mkdirSync(own, { recursive: true });

    // The same credential in two directories, which is what the sibling scan
    // is for. Counting it twice would fetch every message twice and interrupt
    // twice off one send.
    identity(own, 'secret-same', api.url, 'once');
    identity(join(data, 'agentsignal-inline'), 'secret-same', api.url, 'once');

    const daemon = startDaemon(home, own, api.url);
    await settle(1600);
    const first = api.asked.length;
    await settle(1200);

    expect(daemon.alive(), daemon.said()).toBe(true);
    // Roughly one poll per interval, not two. Generous bounds: what is being
    // ruled out is doubling, not jitter.
    expect(api.asked.length - first).toBeLessThanOrEqual(2);
  }, 25_000);
});
