import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * A RESPONDER MUST NOT RUN THE HOOKS THAT EXIST TO INTERRUPT A PERSON.
 *
 * `spawnResponder` starts `claude --print`, and that session loads this plugin
 * and fires its PostToolUse hooks like any other. `AGENTSIGNAL_FROM_RESPONDER`
 * was set on every spawn from the beginning and read by nothing, so the guard
 * that was meant to stop this did not exist.
 *
 * What that cost, on 2026-08-23: the first responder to spawn in two days ran
 * twenty-one minutes at 0.0% CPU, answered nothing, and held the single-flight
 * lock throughout, so every other message was refused with
 * `another_responder_running`. Two orphaned `inbox-hook.mjs watch` processes
 * (ppid 1) were left behind and named the cause: `watch` polls for ten minutes
 * and only returns early when a message arrives, and `claude --print` cannot
 * exit while its own hook is outstanding. The responder was waiting for a
 * message to arrive before it would finish answering the one it had.
 *
 * The hang is the visible half. `check` is the half that would have survived
 * fixing it: it calls `markHandled` on everything waiting, so a responder sent
 * to answer ONE delivery would claim all the others, and a handled message is
 * refused forever. Messages no model ever saw, permanently marked seen.
 */

const HOOK = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../plugins/agentsignal/scripts/inbox-hook.mjs',
);

/*
  EVERY STATE DIRECTORY THIS FILE MAKES, so the daemons can be found again.

  `check` calls `ensureWatcher`, which spawns a real daemon -- one per test,
  outliving the run because it is a poller and nothing ever tells it to stop.
  Ten were found alive on the author's machine on 2026-08-23, from this file
  and from how-long-a-message-waited.test.ts, the oldest two days old. They are
  harmless in themselves -- a temporary HOME, an API on a closed port -- and
  still wrong: `pgrep inbox-daemon.mjs` is the first thing anybody runs when
  messages arrive twice, and a machine that has run this suite answers that
  question with a screenful of debris.

  The pidfile is the handle. The daemon writes it to AGENTSIGNAL_STATE_DIR,
  which these tests already point at a temp directory, so cleaning up needs no
  process-table search and no platform-specific way to read another process's
  environment.
*/
const stateDirs: string[] = [];

afterEach(async () => {
  for (const dir of stateDirs.splice(0)) {
    const pidFile = join(dir, 'inbox-daemon.pid');

    /*
      WAIT FOR THE PIDFILE, because it is written after the spawn returns.

      `ensureWatcher` starts the daemon detached and the hook exits at once, so
      a cleanup that reads the pidfile the instant the test ends usually finds
      nothing and leaves the daemon running. Written without this first, and it
      still leaked one per run -- the same "checked too early, called it
      absent" mistake the code under test is about.
    */
    for (let waited = 0; waited < 3_000 && !existsSync(pidFile); waited += 100) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!existsSync(pidFile)) continue;
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    if (!Number.isInteger(pid) || pid <= 0) continue;
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone, which is the common case */
    }
  }
});

/**
 * A machine with one message waiting, at the urgency the mode under test reads.
 *
 * `urgency: null` is the QUIET channel, and it is the one that hangs. With a
 * message present `watch` wakes on its first poll and exits in milliseconds --
 * which looks like a pass and proves nothing. The twenty-one minute stall
 * happened because nothing was waiting, so the loop ran to its deadline.
 */
function machineWith(urgency: 'interrupt' | 'finish' | null) {
  const home = mkdtempSync(join(tmpdir(), 'agentsignal-responder-hook-'));
  const state = join(home, '.claude', 'plugins', 'data', 'agentsignal-agentsignal');
  mkdirSync(state, { recursive: true });
  writeFileSync(
    join(state, 'agent.json'),
    JSON.stringify({ credential: 'install.secret', base_url: 'http://127.0.0.1:9', handle: 'r' }),
  );
  const spooledAt = new Date(Date.now() - 5_000).toISOString();
  writeFileSync(
    join(state, 'inbox-spool.json'),
    JSON.stringify({
      since: spooledAt,
      messages: urgency === null ? [] : [
        {
          delivery_id: 'd-not-yours',
          title: 'a message the responder was not sent to answer',
          body: 'somebody else should get this',
          priority: urgency === 'interrupt' ? 2 : 0,
          urgency,
          created_at: new Date(Date.now() - 5_500).toISOString(),
          spooled_at: spooledAt,
        },
      ],
    }),
  );
  stateDirs.push(state);
  return { home, state };
}

function runHook(home: string, state: string, mode: string, asResponder: boolean) {
  const inherited = { ...process.env };
  delete inherited.AGENTSIGNAL_DEVICE_SECRET;
  delete inherited.AGENTSIGNAL_FROM_RESPONDER;
  const began = Date.now();
  const run = spawnSync(process.execPath, [HOOK, mode], {
    env: {
      ...inherited,
      HOME: home,
      AGENTSIGNAL_STATE_DIR: state,
      AGENTSIGNAL_BASE_URL: 'http://127.0.0.1:9',
      AGENTSIGNAL_NO_KEYCHAIN: '1',
      /*
        Thirty seconds, deliberately longer than this test is willing to wait.
        A `watch` that honours the marker returns in the time it takes node to
        boot; one that does not sits here for the full thirty, and the gap
        between those two is the whole assertion. Two seconds would make a
        broken guard and a working one look nearly the same.
      */
      AGENTSIGNAL_WATCH_SECONDS: '30',
      ...(asResponder ? { AGENTSIGNAL_FROM_RESPONDER: '1' } : {}),
    },
    encoding: 'utf8',
    timeout: 45_000,
  });
  return { ...run, tookMs: Date.now() - began };
}

/** Whether anything has been marked as put in front of a model. */
function handled(state: string): string[] {
  const path = join(state, 'inbox-handled.json');
  if (!existsSync(path)) return [];
  return (JSON.parse(readFileSync(path, 'utf8')).delivery_ids ?? []) as string[];
}

describe('a responder does not hook itself', () => {
  /**
   * THE HANG. Ten minutes of polling inside a session that cannot exit until
   * the poll ends.
   */
  it('returns from watch at once instead of waiting for a message to arrive', () => {
    // Nothing waiting: the quiet channel, which is what actually stalled. With
    // a message present watch wakes on the first poll and this would pass
    // whether or not the guard exists.
    const { home, state } = machineWith(null);

    const run = runHook(home, state, 'watch', true);

    expect(run.error, `watch did not return: ${run.error?.message}`).toBeUndefined();
    expect(run.status, run.stderr).toBe(0);
    // Node's own startup is most of this. Thirty seconds is what failing looks
    // like, so the threshold does not need to be tight to be meaningful.
    expect(
      run.tookMs,
      `watch sat for ${run.tookMs}ms; a responder session cannot exit while it does`,
    ).toBeLessThan(5_000);
  }, 60_000);

  /**
   * THE QUIETER HALF. A responder answering one delivery must not mark every
   * other waiting message as seen -- `mayRespond` refuses a handled message
   * forever, so this is not a delay, it is a message nobody will ever answer.
   */
  it('does not claim messages it was not sent to answer', () => {
    const { home, state } = machineWith('interrupt');

    const run = runHook(home, state, 'check', true);

    expect(run.status, run.stderr).toBe(0);
    expect(
      handled(state),
      'the responder marked a message handled that no model ever saw',
    ).toEqual([]);
    expect(run.stdout.trim()).toBe('');
  }, 30_000);

  it('does not hold its own turn open at the end', () => {
    const { home, state } = machineWith('finish');

    const run = runHook(home, state, 'finish', true);

    expect(run.status, run.stderr).toBe(0);
    expect(handled(state)).toEqual([]);
    expect(run.stdout.trim()).toBe('');
  }, 30_000);

  /**
   * THE CONTROL, and the reason the three above are not vacuous.
   *
   * Without the marker the same machine, the same spool and the same mode must
   * still surface the message and mark it handled. A guard that suppressed the
   * hooks for everybody would pass every test above and break the feature.
   */
  it('still interrupts a real session, which is what the hooks are for', () => {
    const { home, state } = machineWith('interrupt');

    const run = runHook(home, state, 'check', false);

    expect(handled(state), 'the hook stopped working for everyone').toEqual(['d-not-yours']);
    expect(run.stdout).toMatch(/a message the responder was not sent to answer/);
  }, 30_000);
});
