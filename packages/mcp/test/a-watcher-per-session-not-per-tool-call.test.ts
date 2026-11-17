import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * ONE WATCHER PER SESSION, NOT ONE PER TOOL CALL.
 *
 * `watch` is a PostToolUse hook that polls for ten minutes, so the number
 * alive at any moment is the session's tool-call rate times ten minutes -- and
 * each one is a node runtime. Counted on 2026-08-23: 92 at once across four
 * sessions, one session holding 67, 4.1GB of resident memory between them, to
 * read one small JSON file once a second.
 *
 * Nothing was stuck and nothing leaked. Every one of them expired on its own,
 * correctly, ten minutes after the tool call that spawned it, which is exactly
 * why nobody noticed. The comment in the hook predicted "a sleeping process",
 * singular.
 *
 * THE DEADLINE MOVES INSTEAD. Plain "exit if somebody is already watching"
 * would make the feature worse than it was: a thirty-minute build starting
 * nine minutes into an incumbent's life would be covered for one minute rather
 * than ten, and covering long tool calls is the only reason this mode exists.
 * So a later hook extends the incumbent and exits, and coverage still runs to
 * the last tool call plus ten minutes.
 */

const HOOK = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../plugins/agentsignal/scripts/inbox-hook.mjs',
);

const running: ChildProcess[] = [];
afterEach(() => {
  for (const c of running.splice(0)) {
    try {
      c.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
});

/** A machine with a quiet channel -- nothing waiting, which is when watch polls. */
function machine() {
  const home = mkdtempSync(join(tmpdir(), 'agentsignal-watch-flight-'));
  const state = join(home, '.claude', 'plugins', 'data', 'agentsignal-agentsignal');
  mkdirSync(state, { recursive: true });
  writeFileSync(
    join(state, 'agent.json'),
    JSON.stringify({ credential: 'install.secret', base_url: 'http://127.0.0.1:9', handle: 'w' }),
  );
  writeFileSync(
    join(state, 'inbox-spool.json'),
    JSON.stringify({ since: new Date().toISOString(), messages: [] }),
  );
  return { home, state };
}

function envFor(home: string, state: string, session: string | null, seconds: string) {
  const inherited = { ...process.env };
  delete inherited.AGENTSIGNAL_DEVICE_SECRET;
  delete inherited.AGENTSIGNAL_FROM_RESPONDER;
  delete inherited.CLAUDE_CODE_HOST_SESSION_ID;
  return {
    ...inherited,
    HOME: home,
    AGENTSIGNAL_STATE_DIR: state,
    AGENTSIGNAL_BASE_URL: 'http://127.0.0.1:9',
    AGENTSIGNAL_NO_KEYCHAIN: '1',
    AGENTSIGNAL_WATCH_SECONDS: seconds,
    ...(session ? { CLAUDE_CODE_HOST_SESSION_ID: session } : {}),
  };
}

/** A watcher left running, the way a real one outlives the tool call. */
function startWatcher(home: string, state: string, session: string, seconds = '30') {
  const child = spawn(process.execPath, [HOOK, 'watch'], {
    env: envFor(home, state, session, seconds),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  running.push(child);
  return child;
}

function runWatcher(home: string, state: string, session: string | null, seconds = '30') {
  const began = Date.now();
  const run = spawnSync(process.execPath, [HOOK, 'watch'], {
    env: envFor(home, state, session, seconds),
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { ...run, tookMs: Date.now() - began };
}

const lease = (state: string, session: string) => {
  const path = join(state, 'watching', `${session}.json`);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as { pid: number; until: number };
};

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('a watcher per session, not per tool call', () => {
  it('does not start a second poller for a session already being watched', async () => {
    const { home, state } = machine();
    const first = startWatcher(home, state, 'sess-a');
    await settle(1_500);

    const held = lease(state, 'sess-a');
    expect(held, 'the first watcher never claimed the session').toBeTruthy();
    expect(held!.pid).toBe(first.pid);

    // The next tool call. Today this would sit for the full window.
    const second = runWatcher(home, state, 'sess-a');

    expect(second.status, second.stderr).toBe(0);
    expect(
      second.tookMs,
      `the second watcher polled for ${second.tookMs}ms instead of standing down`,
    ).toBeLessThan(5_000);

    // And the one actually doing the work is untouched.
    expect(lease(state, 'sess-a')!.pid).toBe(first.pid);
    expect(first.exitCode, 'the incumbent was displaced').toBeNull();
  }, 60_000);

  /**
   * THE POINT, and the reason this is not just "exit if somebody is watching".
   * Coverage has to reach the last tool call plus the full window, or a long
   * build is covered for less time than it was before this change.
   */
  it('pushes the deadline out so a long tool call is still covered', async () => {
    const { home, state } = machine();
    startWatcher(home, state, 'sess-b');
    await settle(1_500);

    const before = lease(state, 'sess-b')!.until;
    await settle(2_000);
    runWatcher(home, state, 'sess-b');
    const after = lease(state, 'sess-b')!.until;

    expect(
      after - before,
      'a later tool call did not extend coverage; a long build would be uncovered',
    ).toBeGreaterThan(1_500);
  }, 60_000);

  it('gives a different session its own watcher, or nothing could wake it', async () => {
    const { home, state } = machine();
    startWatcher(home, state, 'sess-c');
    await settle(1_500);

    // Two seconds, so a watcher that actually runs is obvious in the timing.
    const other = runWatcher(home, state, 'sess-d', '2');

    expect(
      other.tookMs,
      'a second session stood down and would never have been woken',
    ).toBeGreaterThan(1_500);
  }, 60_000);

  it('takes over from a watcher that died without cleaning up', () => {
    const { home, state } = machine();
    mkdirSync(join(state, 'watching'), { recursive: true });
    // A pid that is not there: SIGKILL, or a reboot, leaves exactly this.
    writeFileSync(
      join(state, 'watching', 'sess-e.json'),
      JSON.stringify({ pid: 999_999, until: Date.now() + 600_000 }),
    );

    const run = runWatcher(home, state, 'sess-e', '2');

    expect(
      run.tookMs,
      'it deferred to a dead pid, so the session had no watcher at all',
    ).toBeGreaterThan(1_500);
  }, 60_000);

  /**
   * A LEASE IT CANNOT WRITE MUST NOT COST THE WATCHER.
   *
   * The claim was unguarded, and on 2026-08-23 a full disk crashed this hook
   * twice -- ENOSPC out of writeAtomic, once on the rename and once on the
   * open, both left in hook.log with a stack trace and nothing watching
   * afterwards. Before the lease existed, watch on a quiet channel wrote
   * nothing at all: this change turned a read-only path into a write on every
   * tool call and then let that write be fatal.
   *
   * The trade is deliberate. Failing here costs single-flight, so the old
   * one-poller-per-tool-call behaviour returns and the machine is wasteful.
   * Failing the other way costs the watcher, and an urgent message never
   * interrupts anybody. Waste is recoverable; a message nobody saw is not.
   *
   * ENOSPC cannot be forced portably, so the lease PATH is made unusable
   * instead: `watching` is a file, so mkdir of it throws ENOTDIR. Same branch,
   * same guard, no need to fill a disk.
   */
  it('keeps watching when it cannot write its own lease', () => {
    const { home, state } = machine();

    // Not a directory. Every route to the lease now fails.
    writeFileSync(join(state, 'watching'), 'this is not a directory');

    const run = runWatcher(home, state, 'sess-f', '2');

    expect(run.status, `it crashed instead of degrading: ${run.stderr}`).toBe(0);
    expect(run.stderr).not.toMatch(/ENOTDIR|ENOSPC|Error:/);
    // It fell back to the old behaviour: no lease, still polls the full window.
    expect(
      run.tookMs,
      'it exited early, so nothing was watching for that session',
    ).toBeGreaterThan(1_500);
  }, 60_000);

  /**
   * An older host, the SDK, or a direct invocation. With no session id there is
   * no safe key -- one machine-wide watcher would leave other sessions
   * unwakeable -- so it must behave exactly as it did before.
   */
  it('falls back to the old behaviour when there is no session to key on', () => {
    const { home, state } = machine();

    const run = runWatcher(home, state, null, '2');

    expect(run.status, run.stderr).toBe(0);
    expect(run.tookMs, 'it stood down with no way to know who was covering').toBeGreaterThan(1_500);
    expect(existsSync(join(state, 'watching')), 'it claimed a lease with no key').toBe(false);
  }, 60_000);
});
