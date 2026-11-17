import { spawn, type ChildProcess } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * UPDATING REMOVES THE CODE IT REPLACED.
 *
 * `claude plugin update` copies the new version into a directory of its own and
 * leaves every previous one in place. On the machine this was written on that
 * had reached twenty-six of them, and updating had never removed one.
 *
 * Disk is not the problem -- seven megabytes. Old code that still RUNS is. A
 * version directory is a complete, working plugin root: a session that loads
 * one starts ITS daemon from ITS copy of the script. Both halves were seen for
 * real -- a 0.2.79 watcher alive under a 0.2.81 install, and a 0.2.76 dashboard
 * before it. And a root older than 0.2.22 cannot see the shared lock at all, so
 * it starts a SECOND watcher with no superseding line and nothing in any log:
 * every urgent message simply arrives twice. Updating never reached that root,
 * because updating only ever wrote the new one.
 *
 * These tests drive the real script rather than a copy of the rule, because
 * every guard here is about paths -- which directory, whose parent, what is
 * running from where -- and a reimplementation would reproduce the wiring it is
 * supposed to be checking.
 */

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), '../../../plugins/agentsignal/scripts');
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

/**
 * A plugin cache with several versions in it, each a real root.
 *
 * Copied rather than symlinked, because the thing under test deletes
 * directories and a link would make a passing test out of removing nothing.
 */
function cacheWith(versions: string[]) {
  const home = mkdtempSync(join(tmpdir(), 'agentsignal-sweep-'));
  const parent = join(home, '.claude', 'plugins', 'cache', 'agentsignal', 'agentsignal');
  for (const v of versions) {
    cpSync(SCRIPTS, join(parent, v, 'scripts'), { recursive: true });
  }
  const data = join(home, '.claude', 'plugins', 'data');
  mkdirSync(data, { recursive: true });
  return { home, parent, data };
}

/** A credential on disk, exactly as join_channel would have left one. */
function credentialIn(dir: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'agent.json'),
    JSON.stringify({ credential: 'install.secret', base_url: UNREACHABLE, handle: 'sweep-test' }),
  );
}

/**
 * Run one version's daemon and wait for it to get past its lock.
 *
 * UNREACHABLE upstream on purpose: a refused connection is a poll failure the
 * daemon carries on from, unlike a 401, so it stays up long enough to have
 * swept and be looked at.
 */
function startFrom(home: string, data: string, parent: string, version: string) {
  const inherited = { ...process.env };
  delete inherited.AGENTSIGNAL_STATE_DIR;
  delete inherited.AGENTSIGNAL_DEVICE_SECRET;

  const child = spawn(process.execPath, [join(parent, version, 'scripts', 'inbox-daemon.mjs'), 'watch'], {
    env: {
      ...inherited,
      HOME: home,
      CLAUDE_PLUGIN_DATA: data,
      AGENTSIGNAL_BASE_URL: UNREACHABLE,
      AGENTSIGNAL_NO_KEYCHAIN: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  running.push(child);
  let out = '';
  child.stdout?.on('data', (c) => (out += c));
  child.stderr?.on('data', (c) => (out += c));

  return {
    child,
    said: () => out,
    /** Resolves once the daemon has announced it is watching, or it gave up. */
    settled: () =>
      new Promise<void>((done) => {
        const timer = setTimeout(() => done(), 12_000);
        const look = () => {
          if (/started \(pid \d+\) watching/.test(out) || child.exitCode !== null) {
            clearTimeout(timer);
            setTimeout(done, 150);
          }
        };
        child.stdout?.on('data', look);
        child.stderr?.on('data', look);
        child.on('exit', look);
      }),
  };
}

const at = (parent: string, v: string) => existsSync(join(parent, v));

describe('updating removes the code it replaced', () => {
  it('sweeps versions older than the one running, and keeps that one', async () => {
    const { home, parent, data } = cacheWith(['0.2.50', '0.2.60', '0.2.81']);
    credentialIn(join(data, 'agentsignal-agentsignal'));

    const watcher = startFrom(home, data, parent, '0.2.81');
    await watcher.settled();

    expect(at(parent, '0.2.50'), 'an old version should be gone').toBe(false);
    expect(at(parent, '0.2.60'), 'an old version should be gone').toBe(false);
    expect(at(parent, '0.2.81'), 'the running version must survive').toBe(true);
    expect(watcher.said()).toMatch(/swept 2 superseded plugin versions/);
  }, 40_000);

  /**
   * A rollback is somebody's deliberate act. Running an older build must not
   * delete the newer one they are rolling back FROM -- that turns a reversible
   * decision into a one-way door.
   */
  it('never removes a version newer than the one running', async () => {
    const { home, parent, data } = cacheWith(['0.2.50', '0.2.81', '0.3.0']);
    credentialIn(join(data, 'agentsignal-agentsignal'));

    const watcher = startFrom(home, data, parent, '0.2.81');
    await watcher.settled();

    expect(at(parent, '0.3.0'), 'a newer version must survive').toBe(true);
    expect(at(parent, '0.2.81')).toBe(true);
    expect(at(parent, '0.2.50')).toBe(false);
  }, 40_000);

  /**
   * THE ONE THAT WOULD HURT. A developer runs the daemon out of a checkout,
   * whose parent is a repository full of directories that are not versions of
   * anything. Sweeping there would delete their working tree.
   */
  it('sweeps nothing when it is running from a checkout rather than the cache', async () => {
    const home = mkdtempSync(join(tmpdir(), 'agentsignal-checkout-'));
    const repo = join(home, 'AgentSignal', 'plugins', 'agentsignal');
    cpSync(SCRIPTS, join(repo, 'scripts'), { recursive: true });
    // Siblings that look nothing like versions, and one that does -- a repo can
    // contain anything, and none of it is the sweep's business.
    mkdirSync(join(dirname(repo), 'commands'), { recursive: true });
    mkdirSync(join(dirname(repo), '0.0.1'), { recursive: true });
    const data = join(home, '.claude', 'plugins', 'data');
    mkdirSync(data, { recursive: true });
    credentialIn(join(data, 'agentsignal-agentsignal'));

    const inherited = { ...process.env };
    delete inherited.AGENTSIGNAL_STATE_DIR;
    delete inherited.AGENTSIGNAL_DEVICE_SECRET;
    const child = spawn(process.execPath, [join(repo, 'scripts', 'inbox-daemon.mjs'), 'watch'], {
      env: {
        ...inherited,
        HOME: home,
        CLAUDE_PLUGIN_DATA: data,
        AGENTSIGNAL_BASE_URL: UNREACHABLE,
        AGENTSIGNAL_NO_KEYCHAIN: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    running.push(child);
    let out = '';
    child.stdout?.on('data', (c) => (out += c));
    child.stderr?.on('data', (c) => (out += c));
    // WAIT FOR IT TO REACH THE SWEEP, rather than for a stopwatch. A daemon
    // that died on startup also deletes nothing, and this test would have
    // passed on that -- proving the crash, not the guard.
    await new Promise<void>((done) => {
      const timer = setTimeout(() => done(), 12_000);
      const look = () => {
        if (/started \(pid \d+\) watching/.test(out)) {
          clearTimeout(timer);
          setTimeout(done, 150);
        }
      };
      child.stdout?.on('data', look);
      child.stderr?.on('data', look);
    });
    expect(out, 'the daemon has to get past its lock for this to prove anything').toMatch(
      /started \(pid \d+\) watching/,
    );

    expect(existsSync(join(dirname(repo), 'commands')), 'the checkout must be untouched').toBe(true);
    expect(existsSync(join(dirname(repo), '0.0.1')), 'even a version-shaped sibling').toBe(true);
    expect(existsSync(join(repo, 'scripts', 'inbox-daemon.mjs'))).toBe(true);
    expect(out).not.toMatch(/swept/);
  }, 40_000);

  /** Anything not named like a version is not the sweep's to judge. */
  it('leaves directories that are not version numbers alone', async () => {
    const { home, parent, data } = cacheWith(['0.2.50', '0.2.81']);
    mkdirSync(join(parent, 'scratch'), { recursive: true });
    mkdirSync(join(parent, '0.2.x'), { recursive: true });
    credentialIn(join(data, 'agentsignal-agentsignal'));

    const watcher = startFrom(home, data, parent, '0.2.81');
    await watcher.settled();

    expect(at(parent, 'scratch')).toBe(true);
    expect(at(parent, '0.2.x')).toBe(true);
    expect(at(parent, '0.2.50')).toBe(false);
    // One, not three: the count says the two odd names were skipped rather
    // than merely surviving by accident.
    expect(watcher.said()).toMatch(/swept 1 superseded plugin version\b/);
  }, 40_000);
});
