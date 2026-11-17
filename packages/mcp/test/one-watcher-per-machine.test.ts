import { spawn, type ChildProcess } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  copyFileSync,
  readdirSync,
  utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * One watcher per machine, including when the credential arrives mid-session.
 *
 * The daemon lives in plugins/, which no test runner reaches; this package is
 * the closest thing that CI already runs, and it owns the other half of the
 * logic under test -- `writeDir()` here and in the daemon have to agree, and
 * the comments in both say so.
 *
 * WHAT BROKE. The lock was `join(stateDir, 'inbox-daemon.pid')`, and
 * `stateDir` is wherever the credential was found. A join writes a credential,
 * so `stateDir` MOVES the moment an agent joins -- which is the ordinary case
 * now that a join code works mid-session. A daemon started before the join
 * locked one path, a daemon started after locked another, neither could see
 * the other's file, and both polled every two seconds. Three were found
 * running on one machine.
 *
 * The daemon already refuses to run twice and says why: "a duplicate urgent
 * message is an interruption that fires twice". That guard was never wrong.
 * It was reading a lock that had moved out from under it.
 *
 * These tests drive the real script rather than a copy of its logic, because
 * every previous bug here was in the wiring -- which path, which directory,
 * which file -- and a reimplementation would have reproduced the wiring it was
 * meant to check.
 */

const DAEMON = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../plugins/agentsignal/scripts/inbox-daemon.mjs',
);

// Nothing listens here. A refused connection is a poll failure, which the
// daemon counts and carries on from -- unlike a 401, which stops it. So it
// stays up long enough to be asked whether it is the only one.
const UNREACHABLE = 'http://127.0.0.1:9';

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
  const home = mkdtempSync(join(tmpdir(), 'agentsignal-watcher-'));
  const data = join(home, '.claude', 'plugins', 'data');
  mkdirSync(data, { recursive: true });
  return { home, data };
}

/** A credential on disk, exactly as join_channel would have left one. */
function credentialIn(dir: string, secret: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'agent.json'),
    JSON.stringify({ credential: secret, base_url: UNREACHABLE, handle: 'watcher-test' }),
  );
}

function start(
  home: string,
  pluginData: string,
  env: Record<string, string> = {},
  script: string = DAEMON,
) {
  const inherited = { ...process.env };
  // DELETED, not set to the empty string. A developer with AGENTSIGNAL_STATE_DIR
  // exported would otherwise make every daemon here exclusive, and exclusive is
  // the one mode in which none of this applies -- the suite would pass by
  // skipping what it claims to test.
  delete inherited.AGENTSIGNAL_STATE_DIR;
  delete inherited.AGENTSIGNAL_DEVICE_SECRET;

  const child = spawn(process.execPath, [script, 'watch'], {
    env: {
      ...inherited,
      HOME: home,
      CLAUDE_PLUGIN_DATA: pluginData,
      AGENTSIGNAL_BASE_URL: UNREACHABLE,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  running.push(child);

  let output = '';
  child.stdout?.on('data', (chunk) => (output += chunk));
  child.stderr?.on('data', (chunk) => (output += chunk));
  return {
    child,
    said: () => output,
    alive: () => child.exitCode === null && child.signalCode === null,
    exited: () =>
      new Promise<number | null>((resolve) => {
        if (child.exitCode !== null) return resolve(child.exitCode);
        child.once('exit', (code) => resolve(code));
      }),
  };
}

const settle = (ms = 1500) => new Promise((resolve) => setTimeout(resolve, ms));

describe('one watcher per machine', () => {
  it('does not start a second watcher when the credential appears mid-session', async () => {
    const { home, data } = machine();
    const own = join(data, 'agentsignal-agentsignal');
    mkdirSync(own, { recursive: true });

    // The watcher that was already running before anybody joined. Its identity
    // comes from the environment, so its state directory is the fallback --
    // which is precisely the case that used to lock a different path.
    const first = start(home, own, { AGENTSIGNAL_DEVICE_SECRET: 'already-watching' });
    await settle();
    expect(first.alive(), `first watcher died: ${first.said()}`).toBe(true);

    // The join. It lands in a SIBLING directory, because CLAUDE_PLUGIN_DATA is
    // named after the server that asked for it and the joining server had a
    // different name. This is the real shape, not a contrived one.
    credentialIn(join(data, 'agentsignal-inline'), 'just-joined');

    const second = start(home, own);
    const code = await second.exited();

    // The assertion that would have caught this. Not "the second one is
    // configured correctly" -- it was, both times -- but that there is still
    // only ONE poller afterwards.
    expect(code, `second watcher should stand down, said: ${second.said()}`).toBe(0);
    expect(second.said()).toMatch(/already watching/);
    expect(first.alive(), 'the incumbent should still be the one running').toBe(true);
  }, 20_000);

  it('puts the lock where /agentsignal-update says it is', async () => {
    const { home, data } = machine();
    const own = join(data, 'agentsignal-agentsignal');
    credentialIn(join(data, 'agentsignal-inline'), 'joined');

    const watcher = start(home, own);
    await settle();
    expect(watcher.alive(), watcher.said()).toBe(true);

    // Documented for as long as the command has existed, and reported missing
    // by somebody whose agent had joined -- correctly, because the join took
    // the lock with it. The spool is allowed to move; the lock is not.
    const canonical = join(home, '.agentsignal', 'inbox-daemon.pid');
    expect(existsSync(canonical), `no lock at ${canonical}`).toBe(true);
    expect(Number(readFileSync(canonical, 'utf8').trim())).toBe(watcher.child.pid);

    // And the spool still sits beside the credential, which is how the hooks
    // find it. Fixing the lock by dragging the spool back would have broken
    // the thing the spool move was for.
    expect(existsSync(join(data, 'agentsignal-inline', 'inbox-spool.json'))).toBe(true);
  }, 20_000);

  it('does not let two installs take turns evicting each other', async () => {
    const { home, data } = machine();
    const own = join(data, 'agentsignal-agentsignal');
    mkdirSync(own, { recursive: true });
    credentialIn(join(data, 'agentsignal-inline'), 'joined');

    // Two roots for one plugin, which is the ordinary state rather than a
    // broken install: a marketplace sourced from a directory is loaded from
    // that directory by a session inside it, and from the cache by a session
    // anywhere else -- and every version leaves its own cache directory behind.
    // One machine had five roots run a daemon between them.
    const older = join(home, 'cache-copy');
    const newer = join(home, 'checkout-copy');
    for (const dir of [older, newer]) mkdirSync(dir, { recursive: true });
    // Every sibling module, not a named list: the daemon imports `state.mjs`
    // and `watchers.mjs` and a real install ships them together, so copying
    // the script alone is a fixture that no longer resembles an install.
    // Naming them individually already broke once, when watchers.mjs was split
    // out of the daemon.
    const siblings = readdirSync(dirname(DAEMON)).filter(
      (name) => name.endsWith('.mjs') && name !== 'inbox-daemon.mjs',
    );
    for (const dir of [older, newer]) {
      copyFileSync(DAEMON, join(dir, 'inbox-daemon.mjs'));
      for (const name of siblings) copyFileSync(join(dirname(DAEMON), name), join(dir, name));
    }
    const minuteAgo = new Date(Date.now() - 60_000);
    utimesSync(join(older, 'inbox-daemon.mjs'), minuteAgo, minuteAgo);

    const first = start(home, own, {}, join(older, 'inbox-daemon.mjs'));
    await settle();
    expect(first.alive(), first.said()).toBe(true);

    // The newer copy takes over, which is the behaviour worth keeping: an
    // update must not need anybody to know a pidfile exists.
    const second = start(home, own, {}, join(newer, 'inbox-daemon.mjs'));
    await settle(2500);
    expect(second.said()).toMatch(/superseding/);
    expect(first.alive(), 'the older copy should have been asked to leave').toBe(false);

    // And now the assertion this test exists for. Starting the older copy
    // again must NOT bounce the newer one back out -- that is the ping-pong,
    // and it survived a restart precisely because neither copy was wrong.
    const third = start(home, own, {}, join(older, 'inbox-daemon.mjs'));
    const code = await third.exited();
    expect(code, `older copy should stand down, said: ${third.said()}`).toBe(0);
    expect(third.said()).toMatch(/already watching/);
    expect(second.alive(), 'the newer copy should still be the one running').toBe(true);
  }, 25_000);

  it('stands down an orphan still holding a pre-fix lock', async () => {
    const { home, data } = machine();
    const own = join(data, 'agentsignal-agentsignal');
    const joined = join(data, 'agentsignal-inline');
    credentialIn(joined, 'joined');

    // An orphan from the old code: alive, and holding a lock beside its
    // credential where nothing looks any more. Without the sweep the fix
    // cannot reach the machines it is for -- the new daemon finds the
    // canonical path free, starts, and leaves the orphan polling forever.
    const orphan = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    });
    running.push(orphan);
    mkdirSync(joined, { recursive: true });
    writeFileSync(join(joined, 'inbox-daemon.pid'), String(orphan.pid));

    const watcher = start(home, own);
    await settle(3000);

    expect(watcher.alive(), watcher.said()).toBe(true);
    expect(watcher.said()).toMatch(/older lock/);
    expect(orphan.exitCode !== null || orphan.signalCode !== null, 'orphan should be gone').toBe(
      true,
    );
  }, 25_000);
});
