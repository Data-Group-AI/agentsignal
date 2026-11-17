import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type AddressInfo } from 'node:net';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * A newer dashboard takes the port from an older one.
 *
 * The dashboard is a long-lived process nobody restarts on purpose. Update the
 * plugin and the running one keeps serving the old code -- indefinitely, and
 * silently, because it works. The port-in-use message made that worse by
 * saying "that is usually a dashboard already running, find the link it
 * printed", which after an update is advice to keep using the stale one.
 *
 * The watcher solved this long ago and this is the same machinery: compare
 * BUILD times, take over when newer, stand down when not. Build time rather
 * than start time, because an old process started five minutes ago is still
 * old -- start time would mean "whoever restarted last wins", which is how a
 * stale build reclaims the port from the fix for it.
 *
 * KEYED ON THE PORT, unlike the watcher. One watcher per machine is right; one
 * dashboard per machine is not -- a second company needs a second dashboard,
 * and the one-company rule says so. Two on different ports are two scopes,
 * deliberately; only a collision on the SAME port is settled here.
 */

const SCRIPTS = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../plugins/agentsignal/scripts',
);

const running: ChildProcess[] = [];

afterEach(async () => {
  for (const child of running.splice(0)) {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
  // Not for the port any more -- each case allocates its own. SIGKILL returns
  // before the process is reaped, and `alive()` in the next case would see a
  // pid that is on its way out.
  await new Promise((r) => setTimeout(r, 300));
});

/**
 * A copy of the real script, with its modification time set.
 *
 * Copied rather than run in place because the age is the input: the check
 * compares the mtime of the file each process was started from, and two
 * processes running the SAME file are the same vintage by definition.
 */
function build(dir: string, name: string, ageMinutes: number) {
  mkdirSync(dir, { recursive: true });
  for (const file of readdirSync(SCRIPTS)) {
    if (file.endsWith('.mjs')) copyFileSync(join(SCRIPTS, file), join(dir, file));
  }
  const path = join(dir, name);
  copyFileSync(join(SCRIPTS, 'dashboard.mjs'), path);
  const when = new Date(Date.now() - ageMinutes * 60_000);
  utimesSync(path, when, when);
  return path;
}

/**
 * A port nothing else on this machine is using.
 *
 * These were four literals, 8931 to 8934, which held for as long as one run of
 * this file existed at a time. The `checks` runner is configured `network:
 * host` -- deliberately, so `supabase start` can reach the database it
 * publishes on the host -- and its capacity is four. Four pull requests opened
 * together therefore put four copies of this file on ONE loopback, fighting
 * over the same four ports.
 *
 * What that looked like was the worst possible lie: "an older build served
 * when it should have stood down", which is precisely the regression this file
 * exists to catch, reported on a machine where the port had a different owner
 * entirely. A false red here costs more than most, because the true version of
 * it is a stale build killing the fix for itself.
 *
 * Binding port 0 lets the OS name a free one. It is released before the
 * dashboard claims it, so there is a window -- but it is an ephemeral port
 * chosen from a range of thousands, against four literals chosen from a range
 * of one.
 */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

function start(script: string, port: number, state: string) {
  const child = spawn(process.execPath, [script], {
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      PORT: String(port),
      AGENTSIGNAL_STATE_DIR: state,
      AGENTSIGNAL_NO_KEYCHAIN: '1',
      AGENTSIGNAL_API_KEY: 'as_test_test0001_000000000000000000000000',
      // Deliberately dead: the port arithmetic is what is under test, and a
      // dashboard serves whether or not the API answers.
      AGENTSIGNAL_BASE_URL: 'http://127.0.0.1:9',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  running.push(child);

  let out = '';
  const settled = new Promise<{ serving: boolean; out: string; code: number | null }>((done) => {
    const timer = setTimeout(() => done({ serving: /Loopback only/.test(out), out, code: null }), 12_000);
    const look = (chunk: Buffer) => {
      out += chunk;
      if (/Loopback only/.test(out)) {
        clearTimeout(timer);
        done({ serving: true, out, code: null });
      }
    };
    child.stdout?.on('data', look);
    child.stderr?.on('data', look);
    child.on('exit', (code) => {
      clearTimeout(timer);
      done({ serving: /Loopback only/.test(out), out, code });
    });
  });
  return { child, settled };
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('a newer dashboard supersedes the one running', () => {
  it('takes the port from an older build, and says whose it took', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentsignal-supersede-'));
    const state = join(dir, 'state');
    const older = build(join(dir, 'a'), 'dashboard.mjs', 120);
    const newer = build(join(dir, 'b'), 'dashboard.mjs', 0);

    const port = await freePort();

    const first = start(older, port, state);
    expect((await first.settled).serving, 'the older build should serve first').toBe(true);
    const oldPid = first.child.pid!;

    const second = start(newer, port, state);
    const result = await second.settled;

    expect(result.serving, `the newer build should have taken over: ${result.out}`).toBe(true);
    // Named, not silent. "It stopped working" is what this looks like from the
    // other end otherwise.
    expect(result.out).toMatch(new RegExp(`superseding pid ${oldPid}`));
    await new Promise((r) => setTimeout(r, 400));
    expect(alive(oldPid), 'the older build should be gone').toBe(false);
  }, 60_000);

  it('stands down to a newer build rather than fighting for the port', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentsignal-standdown-'));
    const state = join(dir, 'state');
    const older = build(join(dir, 'a'), 'dashboard.mjs', 120);
    const newer = build(join(dir, 'b'), 'dashboard.mjs', 0);

    const port = await freePort();

    const first = start(newer, port, state);
    expect((await first.settled).serving).toBe(true);
    const newPid = first.child.pid!;

    const second = start(older, port, state);
    const result = await second.settled;

    expect(result.serving).toBe(false);
    expect(result.code).toBe(0);
    expect(result.out).toMatch(/same build or newer/);
    // THE ONE THAT MATTERS. A stale build that killed the fix for it would be
    // the bug this whole file is about, arriving by the door marked exit.
    expect(alive(newPid), 'the newer build must still be serving').toBe(true);

    /*
      AND IT MUST NOT TIDY UP ON ITS WAY OUT. The lock on this port belongs to
      the dashboard still serving; a standing-down process that deleted it
      would leave a live process with no lock -- so the next start finds no
      holder, supersedes nothing, and collides on the port instead. The first
      version did exactly that, and it survived a whole round of tests because
      nothing asserted on a lock after somebody had exited.
    */
    expect(existsSync(join(state, `dashboard-${port}.pid`)), "the survivor's lock").toBe(true);
  }, 60_000);

  /**
   * A second dashboard on another port is not a collision, it is a second
   * scope -- the one-company rule tells people to start exactly this. It must
   * not be superseded, and its lock must survive the other one's arrival.
   */
  it('leaves a dashboard on a different port entirely alone', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentsignal-twoports-'));
    const state = join(dir, 'state');
    const newer = build(join(dir, 'b'), 'dashboard.mjs', 0);
    const older = build(join(dir, 'a'), 'dashboard.mjs', 120);

    const onePort = await freePort();
    const otherPort = await freePort();

    const first = start(newer, onePort, state);
    expect((await first.settled).serving).toBe(true);
    const firstPid = first.child.pid!;

    const second = start(older, otherPort, state);
    const result = await second.settled;

    expect(result.serving, 'the second port should serve').toBe(true);
    expect(result.out).not.toMatch(/superseding/);
    expect(alive(firstPid)).toBe(true);

    /*
      BOTH LOCKS PRESENT. A process that stands down used to delete the lock on
      its way out -- any lock, including one it did not own -- which left a live
      dashboard with no lock, so the next start found no holder, superseded
      nothing, and collided on the port instead. Found by this test rather than
      by reading the code.
    */
    expect(existsSync(join(state, `dashboard-${onePort}.pid`)), 'first lock').toBe(true);
    expect(existsSync(join(state, `dashboard-${otherPort}.pid`)), 'second lock').toBe(true);
  }, 60_000);
});
