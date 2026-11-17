import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * TWO WATCHERS CANNOT BOTH WIN.
 *
 * The daemon refuses to run twice and says why -- "a duplicate urgent message
 * is an interruption that fires twice" -- and the stand-down path that enforces
 * it is correct. It just could not help, because asking who is here and saying
 * "me" were a hundred lines apart, with superseding an older build and waiting
 * for it to exit in between. Two daemons started in the same millisecond both
 * asked before either answered.
 *
 * From the machine this was written on:
 *
 *   01:01:03.174Z started (pid 20354)
 *   01:01:03.174Z started (pid 20349)     <- same millisecond, both won
 *   01:04:03.807Z superseding pid 20349
 *   01:04:03.807Z superseding pid 20349   <- twice: two processes, one victim,
 *   01:04:03.808Z superseding pid 20354      neither aware of the other
 *   01:04:03.808Z superseding pid 20354
 *
 * A marketplace sourced from a directory makes that ordinary: two sessions
 * opened in that directory are two SessionStart hooks firing together, from the
 * same root, racing each other.
 *
 * So these start daemons SIMULTANEOUSLY rather than in sequence. A test that
 * starts one, waits, and starts another is testing the stand-down path, which
 * was never the broken one -- and would have passed against the bug.
 */

const DAEMON = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../plugins/agentsignal/scripts/inbox-daemon.mjs',
);

// Nothing listens here. A refused connection is a poll failure the daemon
// carries on from, unlike a 401, so it stays up long enough to be counted.
const UNREACHABLE = 'http://127.0.0.1:9';

const running: ChildProcess[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise((resolve) => server.close(resolve));
  }
  for (const child of running.splice(0)) {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
});

function machineAt(base: string) {
  const home = mkdtempSync(join(tmpdir(), 'agentsignal-race-'));
  const data = join(home, '.claude', 'plugins', 'data', 'agentsignal-agentsignal');
  mkdirSync(data, { recursive: true });
  writeFileSync(
    join(data, 'agent.json'),
    JSON.stringify({ credential: 'install.secret', base_url: base, handle: 'race' }),
  );
  return { home, data: join(home, '.claude', 'plugins', 'data') };
}

function machine() {
  const home = mkdtempSync(join(tmpdir(), 'agentsignal-race-'));
  const data = join(home, '.claude', 'plugins', 'data', 'agentsignal-agentsignal');
  mkdirSync(data, { recursive: true });
  writeFileSync(
    join(data, 'agent.json'),
    JSON.stringify({ credential: 'install.secret', base_url: UNREACHABLE, handle: 'race' }),
  );
  return { home, data: join(home, '.claude', 'plugins', 'data') };
}

function start(home: string, data: string, extra: Record<string, string> = {}) {
  const inherited = { ...process.env };
  delete inherited.AGENTSIGNAL_STATE_DIR;
  delete inherited.AGENTSIGNAL_DEVICE_SECRET;

  const child = spawn(process.execPath, [DAEMON, 'watch'], {
    env: {
      ...inherited,
      HOME: home,
      CLAUDE_PLUGIN_DATA: data,
      AGENTSIGNAL_BASE_URL: UNREACHABLE,
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

/** Alive means it is still watching, not merely that it was started. */
const stillWatching = (w: { child: ChildProcess }) =>
  w.child.exitCode === null && w.child.signalCode === null;

describe('two watchers cannot both win', () => {
  it('leaves exactly one alive when several start in the same instant', async () => {
    const { home, data } = machine();

    // No await between them: spawned as close together as this process can
    // manage, which is the condition the lock is for.
    const racers = [start(home, data), start(home, data), start(home, data)];

    await settle(9_000);

    const alive = racers.filter(stillWatching);
    expect(
      alive.length,
      `expected one watcher, got ${alive.length}:\n${racers.map((r) => r.said()).join('\n---\n')}`,
    ).toBe(1);
  }, 60_000);

  /**
   * The duplicated `superseding` line was the tell: two processes each decided
   * to evict the same incumbent because neither could see the other deciding.
   */
  it('never has two processes supersede the same incumbent', async () => {
    const { home, data } = machine();

    const first = start(home, data);
    await settle(4_000);
    expect(stillWatching(first), first.said()).toBe(true);

    const second = start(home, data);
    const third = start(home, data);
    await settle(9_000);

    const all = [first, second, third].map((r) => r.said()).join('\n');
    const supersedes = all.match(/superseding pid (\d+)/g) ?? [];
    const victims = supersedes.map((line) => line.replace(/\D+/g, ''));
    expect(
      new Set(victims).size,
      `the same incumbent was superseded more than once: ${supersedes.join(', ')}`,
    ).toBe(victims.length);

    /*
      AND COUNT THE SURVIVORS, which this test did not do and should have.

      Unique victims was the tell for one shape of the bug, not the bug. Two
      racers can each supersede the incumbent exactly once between them and
      BOTH still end up watching, which is the state that duplicates every
      message -- and this assertion is the only one that can see it.

      Observed on a real machine at 13:50:46 with 0.2.92 installed, which is
      the version that was supposed to have fixed this.
    */
    const alive = [first, second, third].filter(stillWatching);
    expect(
      alive.length,
      `expected one watcher after superseding an incumbent, got ${alive.length}:\n${all}`,
    ).toBe(1);
  }, 60_000);

  /**
   * THE ONE THAT ACTUALLY HAPPENED, on a real machine running the version that
   * was supposed to have fixed this.
   *
   *   13:50:46.446Z superseding pid 17959
   *   13:50:46.453Z superseding pid 17959     <- both decided
   *   13:50:46.458Z started (pid 46835)
   *   13:50:46.553Z started (pid 46828)       <- both started
   *
   * Debris is what makes it possible. A daemon SIGTERMed DURING its own
   * startup -- which is precisely what superseding does to it -- died before it
   * registered a signal handler, so its `exit` handler never ran and
   * starting.lock was left behind naming a pid that no longer exists.
   *
   * Two starters then find a lock whose holder is dead, and the break is
   * read-decide-unlink with nothing tying the delete to what was read:
   *
   *   A: unlink (stale), create   -> A holds
   *   B: unlink  <- deletes A's LIVE lock, create -> B holds
   *
   * Both hold "the lock", both supersede the incumbent, both start. Seeded
   * directly here because waiting for the real sequence takes a kill at exactly
   * the wrong moment, and the debris is the only part that matters.
   */
  it('does not let two starters both break one piece of debris', async () => {
    const { home, data } = machine();
    const lockRoot = join(home, '.agentsignal');
    mkdirSync(lockRoot, { recursive: true });

    // A lock whose holder is gone: what a startup-time kill leaves behind.
    writeFileSync(
      join(lockRoot, 'starting.lock'),
      JSON.stringify({ pid: 999_999, at: Date.now() }),
    );

    const racers = [start(home, data), start(home, data), start(home, data), start(home, data), start(home, data)];
    await settle(9_000);

    const alive = racers.filter(stillWatching);
    expect(
      alive.length,
      `expected one watcher, got ${alive.length}:\n${racers.map((r) => r.said()).join('\n---\n')}`,
    ).toBe(1);
  }, 60_000);

  /**
   * THE BACKSTOP, tested with the lock deliberately removed.
   *
   * On 2026-08-21 at 13:50:46 two daemons got past the startup lock on a real
   * machine and both watched for hours. Five racers against seeded debris,
   * three rounds, would not reproduce it -- so why the lock failed is still
   * unknown, and a fix aimed at a mechanism I cannot demonstrate would be the
   * third guess at this file.
   *
   * What can be fixed without knowing is the damage. Once two processes are
   * both registered, nothing looked again, so the duplicate was permanent.
   * Now they reconcile on a total order: lowest pid keeps watching, and mtime
   * cannot arbitrate because both are running the same file.
   *
   * The lock is switched off here on purpose. With it working this test would
   * only prove the lock works, which is the thing already in doubt.
   */
  it('leaves one watcher even when the startup lock does not serialise them', async () => {
    const { home, data } = machine();

    const racers = [
      start(home, data, { AGENTSIGNAL_NO_STARTUP_LOCK: '1' }),
      start(home, data, { AGENTSIGNAL_NO_STARTUP_LOCK: '1' }),
      start(home, data, { AGENTSIGNAL_NO_STARTUP_LOCK: '1' }),
    ];
    await settle(9_000);

    const alive = racers.filter(stillWatching);
    expect(
      alive.length,
      `expected one watcher with no lock at all, got ${alive.length}:\n${racers
        .map((r) => r.said())
        .join('\n---\n')}`,
    ).toBe(1);
  }, 60_000);

  /**
   * THE INTERLEAVING THE ONE-SHOT CHECK LOST, made deterministic.
   *
   * The backstop above shipped as a single look taken just after registering,
   * and CI caught what three racers eventually produce by chance:
   *
   *   16:18:45.409Z started (pid 8579)   <- registered, looked, saw an empty
   *   16:18:45.410Z started (pid 8578)      registry, stayed
   *                                      <- registered, looked, saw 8579, and
   *                                         8578 < 8579 so it also stayed
   *
   * Neither is wrong on its own reading. Registering and looking are two steps,
   * so the higher pid can look before the lower one has answered, and the lower
   * pid is precisely the one entitled to stay. Both watch forever.
   *
   * Racing three processes to reproduce that is a coin flip -- it passed twice
   * locally against the broken code before CI failed it. So this does not race
   * at all: one watcher is started, and a lower-pid twin is then injected into
   * the registry, which is exactly what the loser of that interleaving sees on
   * its next look. The property under test is that it LOOKS AGAIN.
   *
   * The test process itself is the twin. It is genuinely alive -- the daemon
   * checks with signal 0 and would delete the entry otherwise -- and it is
   * necessarily a lower pid than a child it spawned afterwards.
   */
  it('stands down when a lower-pid twin appears after it started', async () => {
    const { home, data } = machine();
    const watcher = start(home, data);
    await settle(4_000);
    expect(stillWatching(watcher), watcher.said()).toBe(true);

    const watchersDir = join(home, '.agentsignal', 'watchers');
    mkdirSync(watchersDir, { recursive: true });
    writeFileSync(
      join(watchersDir, `${process.pid}.json`),
      JSON.stringify({
        pid: process.pid,
        script: DAEMON,
        // Equal mtime is what makes it a TWIN rather than an older build:
        // the pid tiebreak is only allowed to decide between same-build rivals.
        mtime: statSync(DAEMON).mtimeMs,
      }),
    );

    await settle(6_000);

    expect(
      stillWatching(watcher),
      `expected it to stand down for the lower pid, but it is still watching:\n${watcher.said()}`,
    ).toBe(false);
    expect(watcher.said()).toMatch(
      new RegExp(`pid ${process.pid} is watching the same build; standing down`),
    );
  }, 60_000);

  /**
   * THE BACKSTOP REACTS ON ITS OWN CLOCK, not the poll's.
   *
   * Every other test here asserts that one watcher survives. None of them
   * asserts HOW FAST, and that gap hid a real regression: reconciling used to
   * run at the top of each poll cycle, a cycle was two seconds, and then the
   * poll started holding its request open for twenty-five. The check went with
   * it. A duplicate that appeared just after one check survived until the
   * next -- twelve times longer, delivering every message twice throughout --
   * and both commits were correct on their own, with passing tests.
   *
   * So this measures. The daemon is pointed at a server that holds requests
   * open, exactly as production does, so the poll is parked for the whole
   * test; the twin is injected while it is parked. If reconciliation is riding
   * the poll, nothing happens for twenty-five seconds and this fails.
   */
  it('stands down within seconds even while the poll is parked', async () => {
    const holder = createServer((_req, res) => {
      // Hold it open, like a real ?wait= server. Never answers.
      void res;
    });
    servers.push(holder);
    await new Promise<void>((resolve) => holder.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(holder.address() as { port: number }).port}`;

    const { home, data } = machineAt(base);
    const watcher = start(home, data, { AGENTSIGNAL_BASE_URL: base });
    await settle(4_000);
    expect(stillWatching(watcher), watcher.said()).toBe(true);

    // A lower-pid twin appears while the poll is parked mid-request.
    const watchersDir = join(home, '.agentsignal', 'watchers');
    mkdirSync(watchersDir, { recursive: true });
    writeFileSync(
      join(watchersDir, `${process.pid}.json`),
      JSON.stringify({ pid: process.pid, script: DAEMON, mtime: statSync(DAEMON).mtimeMs }),
    );

    const appeared = Date.now();
    while (Date.now() - appeared < 12_000 && stillWatching(watcher)) {
      await settle(200);
    }
    const took = Date.now() - appeared;

    expect(
      stillWatching(watcher),
      `still watching after ${took}ms:\n${watcher.said()}`,
    ).toBe(false);
    // Generous, and still far under the twenty-five second poll it must not
    // be waiting for.
    expect(took, `took ${took}ms, which is the poll cycle rather than the timer`).toBeLessThan(
      10_000,
    );
  }, 60_000);

  /**
   * A WEDGED HOLDER'S LOCK GETS BROKEN, rather than waited out and ignored.
   *
   * The hole this closes, in the numbers rather than in prose: a waiter sleeps
   * 300 times at 100ms and gives up at thirty seconds. The stale threshold was
   * sixty. So a waiter arriving to find a fresh lock could never watch it reach
   * staleness -- it gave up first and started WITHOUT the lock, which is the
   * shape that ends with two watchers.
   *
   * The holder here is alive and never releasing, which no pid check catches:
   * `process.kill(pid, 0)` succeeds, so the only thing that can free this
   * machine is the age of the lock. It is seeded old enough to be stale but far
   * younger than the sixty seconds that used to be required.
   */
  it('breaks the lock of a holder that is alive but never releasing', async () => {
    const { home, data } = machine();
    const lockRoot = join(home, '.agentsignal');
    mkdirSync(lockRoot, { recursive: true });

    // A real, living process that holds the lock and will never give it up.
    const wedged = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], {
      stdio: 'ignore',
    });
    running.push(wedged);
    await settle(300);

    writeFileSync(
      join(lockRoot, 'starting.lock'),
      // Older than the 20s threshold, younger than the 60s it used to be.
      JSON.stringify({ pid: wedged.pid, at: Date.now() - 25_000 }),
    );

    const only = start(home, data);
    await settle(9_000);

    expect(stillWatching(only), only.said()).toBe(true);
    expect(
      only.said(),
      'it did not break the lock, so it either waited or started unlocked',
    ).toMatch(new RegExp(`breaking the startup lock held by pid ${wedged.pid}`));
    expect(only.said()).toMatch(/longer than any legitimate hold/);

    // And it must NOT have taken the fail-open route, which is the outcome
    // this whole change exists to remove.
    expect(only.said()).not.toMatch(/Starting WITHOUT it/);
  }, 60_000);

  /**
   * THE LOCK SAYS WHAT IT DID, which is the only reason the next occurrence
   * will be diagnosable.
   *
   * On 2026-08-21 two daemons got past this lock seven milliseconds apart and
   * both watched for hours. Two attempts at working out why got nowhere, and
   * the reason is in the function rather than in the incident: claimStartup
   * had SIX decision points -- two that proceed without the lock, three that
   * delete somebody else's -- and not one of them logged. A transcript showing
   * two `started` lines and nothing else was equally consistent with the lock
   * failing open, with a live lock being broken as debris, and with the lock
   * working and something else being wrong.
   *
   * So this asserts the evidence exists, not the mechanism. Breaking a dead
   * holder's lock is the one path a test can trigger deliberately, and it is
   * the one that produces two watchers when the holder turns out not to be
   * dead after all.
   */
  it('says so when it breaks a lock, rather than doing it silently', async () => {
    const { home, data } = machine();
    const lockRoot = join(home, '.agentsignal');
    mkdirSync(lockRoot, { recursive: true });
    // A holder that cannot be alive, which is what a startup-time kill leaves.
    writeFileSync(
      join(lockRoot, 'starting.lock'),
      JSON.stringify({ pid: 999_999, at: Date.now() }),
    );

    const only = start(home, data);
    await settle(9_000);

    expect(stillWatching(only), only.said()).toBe(true);
    expect(
      only.said(),
      'the lock was broken without saying so, which is how this became undiagnosable',
    ).toMatch(/breaking the startup lock held by pid 999999/);
    expect(only.said()).toMatch(/no such process/);
  }, 60_000);

  /**
   * A daemon killed while holding the lock must not stop this machine from ever
   * starting one again. The evidence for breaking it is that its holder is gone.
   */
  it('breaks a startup lock whose holder died, rather than waiting forever', async () => {
    const { home, data } = machine();
    const lockRoot = join(home, '.agentsignal');
    mkdirSync(lockRoot, { recursive: true });
    // A pid high enough to be nobody, so the holder reads as dead.
    writeFileSync(
      join(lockRoot, 'starting.lock'),
      JSON.stringify({ pid: 999_999, at: Date.now() }),
    );

    const only = start(home, data);
    await settle(9_000);

    expect(stillWatching(only), only.said()).toBe(true);
    expect(only.said()).toMatch(/started \(pid \d+\) watching/);
  }, 60_000);
});
