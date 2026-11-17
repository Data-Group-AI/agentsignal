import { spawn, type ChildProcess } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  copyFileSync,
  utimesSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * A sweep clears EVERY rival, not just the one a pidfile can name.
 *
 * THE REPORT THIS COMES FROM. A machine ran three watchers for a day. Two were
 * started from the same directory, so the second overwrote the first's pidfile
 * when it claimed the lock -- and from that moment the first was unfindable by
 * anything reading that file, including the code written to sweep it. A fourth
 * daemon started beside all three, on a version carrying every fix, swept the
 * one the pidfile named and left the others polling. The owner reasonably
 * expected it to settle on the next start; it could not, because the next start
 * does exactly what the last one did.
 *
 * The cost is not untidiness. Two watchers on one inbox fetch every message
 * twice and interrupt twice off a single send, and the person on the other end
 * sees a duplicate with no error anywhere to explain it.
 *
 * WHAT MAKES IT A CLASS RATHER THAN AN INCIDENT: a pidfile has one slot, so the
 * sweep can only ever be as plural as its bookkeeping. Any race that lets two
 * watchers start at once -- two sessions opening together is enough, both
 * reading the lock before either writes it -- leaves one of them permanently
 * invisible. The registry replaces one slot with one file per watcher so the
 * count is honest, and these tests assert on the plural case specifically,
 * because the single-rival case passed throughout.
 *
 * WHY THE REGISTRY AND NOT `ps`. Walking the process table finds watchers that
 * must not be touched: the suites here isolate by HOME and a fixture isolates
 * by `--state-dir`, and neither is visible in an argument list. A sweep keyed
 * on argv cannot tell a developer's real daemon from a test's, so running these
 * tests would kill the daemon they are using. Scoping to the lock directory
 * keeps isolation working for free, since isolation already IS a different lock
 * directory.
 */

const DAEMON = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../plugins/agentsignal/scripts/inbox-daemon.mjs',
);

// Nothing listens here, so a poll fails and is counted rather than fatal, and
// the watcher stays up long enough to be asked whether it is alone.
const UNREACHABLE = 'http://127.0.0.1:9';

/** Every .mjs beside the daemon, so a fixture install matches a real one. */
function siblingModules() {
  const dir = dirname(DAEMON);
  return readdirSync(dir)
    .filter((name) => name.endsWith('.mjs') && name !== 'inbox-daemon.mjs')
    .map((name) => ({ name, from: join(dir, name) }));
}

const running: ChildProcess[] = [];

afterEach(() => {
  for (const child of running.splice(0)) {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
});

/** A throwaway machine: its own HOME, so the real lock is never touched. */
function machine() {
  const home = mkdtempSync(join(tmpdir(), 'agentsignal-sweep-'));
  const data = join(home, '.claude', 'plugins', 'data');
  mkdirSync(data, { recursive: true });
  return { home, data };
}

/**
 * A copy of the daemon stamped at a chosen age.
 *
 * Vintage is decided on mtime, so "older" and "newer" have to be real file
 * times rather than an argument -- the test would otherwise be checking a knob
 * that does not exist in the shipped path.
 */
function daemonAged(dir: string, name: string, secondsAgo: number) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  copyFileSync(DAEMON, path);
  // EVERY sibling module, not a named list. The daemon imports `state.mjs`
  // and `watchers.mjs`, and a real install ships them together; a fixture that
  // copies the script alone starts a daemon that dies on its first import --
  // which reads, from the outside, exactly like a daemon that stood down.
  //
  // Copying the whole directory rather than the imports of the day means
  // adding an import does not silently turn these tests into a test of nothing.
  // Naming them individually already broke once, when watchers.mjs was split
  // out of the daemon.
  for (const sibling of siblingModules()) {
    copyFileSync(sibling.from, join(dir, sibling.name));
  }
  const when = new Date(Date.now() - secondsAgo * 1000);
  utimesSync(path, when, when);
  return path;
}

function start(home: string, lockDir: string, script: string) {
  const inherited = { ...process.env };
  delete inherited.AGENTSIGNAL_DEVICE_SECRET;

  const child = spawn(process.execPath, [script, 'watch', '--state-dir', lockDir], {
    env: {
      ...inherited,
      HOME: home,
      // Passed through so a spawned server obeys the same keychain switch as the
      // runner. Empty means "not set", which is what an ordinary run looks like.
      AGENTSIGNAL_NO_KEYCHAIN: process.env.AGENTSIGNAL_NO_KEYCHAIN ?? '',
      AGENTSIGNAL_STATE_DIR: lockDir,
      AGENTSIGNAL_BASE_URL: UNREACHABLE,
      AGENTSIGNAL_DEVICE_SECRET: 'sweep-test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  running.push(child);

  let output = '';
  child.stdout?.on('data', (chunk) => (output += chunk));
  child.stderr?.on('data', (chunk) => (output += chunk));
  return {
    child,
    pid: child.pid!,
    said: () => output,
    alive: () => child.exitCode === null && child.signalCode === null,
  };
}

const settle = (ms = 1500) => new Promise((resolve) => setTimeout(resolve, ms));

/** The registry as the daemon writes it: one file per watcher. */
function registryPids(lockDir: string): number[] {
  try {
    return readdirSync(join(lockDir, 'watchers'))
      .filter((n) => n.endsWith('.json'))
      .map((n) => JSON.parse(readFileSync(join(lockDir, 'watchers', n), 'utf8')).pid as number)
      .sort((a, b) => a - b);
  } catch {
    return [];
  }
}

/**
 * Put a live watcher into a lock scope it did not start in.
 *
 * This is the state a start-time race leaves: two watchers each concluded the
 * scope was free, so both are running and both are registered. It cannot be
 * produced by starting two daemons in sequence -- the second would correctly
 * stand down -- so the state is written directly, from the real process and its
 * real script, rather than reproduced by timing luck.
 */
function registerInto(lockDir: string, pid: number, script: string) {
  const dir = join(lockDir, 'watchers');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${pid}.json`),
    JSON.stringify({ pid, script, mtime: statSync(script).mtimeMs }),
  );
}

const gone = (pid: number) => {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
};

describe('a sweep clears every rival', () => {
  it('stands down two watchers, not one', async () => {
    const { home } = machine();
    const scope = join(home, 'lock');
    const older = daemonAged(join(home, 'a'), 'inbox-daemon.mjs', 600);

    // Two watchers, genuinely running, each isolated so they coexist the way a
    // race would have left them.
    const first = start(home, join(home, 'scope-a'), older);
    const second = start(home, join(home, 'scope-b'), older);
    await settle();
    expect(first.alive(), `first died: ${first.said()}`).toBe(true);
    expect(second.alive(), `second died: ${second.said()}`).toBe(true);

    // Both belong to the contested scope.
    registerInto(scope, first.pid, older);
    registerInto(scope, second.pid, older);
    expect(registryPids(scope)).toEqual([first.pid, second.pid].sort((a, b) => a - b));

    // A newer watcher arrives. THE assertion: it clears both.
    //
    // A pidfile could only have named one of these, so before the registry this
    // test's second expectation was the bug -- one rival swept, one left
    // polling, and nothing anywhere reporting a second watcher.
    const newer = daemonAged(join(home, 'b'), 'inbox-daemon.mjs', 0);
    const third = start(home, scope, newer);
    await settle(4000);

    expect(third.alive(), `newer watcher died: ${third.said()}`).toBe(true);
    expect(gone(first.pid), 'first rival survived the sweep').toBe(true);
    expect(gone(second.pid), 'second rival survived the sweep').toBe(true);
  }, 30_000);

  it('names both of them, so a duplicate is not swept in silence', async () => {
    const { home } = machine();
    const scope = join(home, 'lock');
    const older = daemonAged(join(home, 'a'), 'inbox-daemon.mjs', 600);

    const first = start(home, join(home, 'scope-a'), older);
    const second = start(home, join(home, 'scope-b'), older);
    await settle();
    registerInto(scope, first.pid, older);
    registerInto(scope, second.pid, older);

    const newer = daemonAged(join(home, 'b'), 'inbox-daemon.mjs', 0);
    const third = start(home, scope, newer);
    await settle(4000);

    // Both pids in the log. A sweep that clears two watchers while reporting
    // one reads, later, as a machine that only ever had one -- which is how the
    // original went a day without being noticed.
    expect(third.said()).toContain(`superseding pid ${first.pid}`);
    expect(third.said()).toContain(`superseding pid ${second.pid}`);
  }, 30_000);

  it('kills nobody when it is the one that should stand down', async () => {
    const { home } = machine();
    const scope = join(home, 'lock');

    // Beaten by one rival, newer than the other. The tempting implementation
    // evicts as it walks the list and discovers too late that it loses, having
    // already taken down a watcher on its way out -- leaving the machine with
    // fewer watchers than it started with, which is worse than the duplicate.
    const ancient = daemonAged(join(home, 'a'), 'inbox-daemon.mjs', 600);
    const newest = daemonAged(join(home, 'c'), 'inbox-daemon.mjs', 0);

    const loser = start(home, join(home, 'scope-a'), ancient);
    const winner = start(home, join(home, 'scope-b'), newest);
    await settle();
    registerInto(scope, loser.pid, ancient);
    registerInto(scope, winner.pid, newest);

    const middling = daemonAged(join(home, 'b'), 'inbox-daemon.mjs', 300);
    const arriving = start(home, scope, middling);
    await settle(3000);

    expect(arriving.alive(), 'it should have stood down').toBe(false);
    expect(arriving.said()).toContain(`already watching under pid ${winner.pid}`);
    expect(gone(loser.pid), 'it evicted a watcher on its way out').toBe(false);
    expect(gone(winner.pid), 'it evicted the watcher that beat it').toBe(false);
  }, 30_000);

  it('forgets a watcher that died without cleaning up', async () => {
    const { home } = machine();
    const scope = join(home, 'lock');
    const older = daemonAged(join(home, 'a'), 'inbox-daemon.mjs', 600);

    const doomed = start(home, join(home, 'scope-a'), older);
    await settle();
    registerInto(scope, doomed.pid, older);

    // SIGKILL, so no exit handler runs. A reboot leaves the same thing behind.
    doomed.child.kill('SIGKILL');
    await settle(500);
    expect(registryPids(scope)).toEqual([doomed.pid]);

    const newer = daemonAged(join(home, 'b'), 'inbox-daemon.mjs', 0);
    const next = start(home, scope, newer);
    await settle(2500);

    expect(next.alive(), `it should have started: ${next.said()}`).toBe(true);
    // The ghost is gone and only the live watcher remains. A registry that only
    // grows would make every later start read a directory of dead pids, and pid
    // numbers are reused -- a ghost is not merely noise, it is a stranger this
    // would eventually try to kill.
    expect(registryPids(scope)).toEqual([next.pid]);
  }, 30_000);

  it('removes its own entry when asked to stop', async () => {
    const { home } = machine();
    const scope = join(home, 'lock');
    const only = daemonAged(join(home, 'a'), 'inbox-daemon.mjs', 0);

    const watcher = start(home, scope, only);
    await settle();
    expect(registryPids(scope)).toEqual([watcher.pid]);
    expect(existsSync(join(scope, 'inbox-daemon.pid'))).toBe(true);

    watcher.child.kill('SIGTERM');
    await settle(1000);

    expect(registryPids(scope)).toEqual([]);
  }, 30_000);
});
