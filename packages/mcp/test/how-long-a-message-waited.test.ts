import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * HOW LONG A MESSAGE WAITED.
 *
 * Asked because nobody could answer "what is worth optimising". Measured from
 * outside, the delivery path costs an API round trip (~170ms) and a poll
 * (0-2s), and those are the two everybody reaches for. The part nobody could
 * see is the last one: a message already on this machine, in the spool, waiting
 * for the session to reach a point where a hook can run. If that leg is thirty
 * seconds then the other two are rounding errors, and the honest answer was
 * that it had never been measured.
 *
 * The trustworthy figure is spooled -> surfaced, because it is one clock
 * measured against itself. sent -> spooled crosses the server's clock and this
 * machine's and carries whatever skew is between them, which is why it is
 * recorded but not leaned on.
 */

const HOOK = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../plugins/agentsignal/scripts/inbox-hook.mjs',
);

/** A machine with one spooled message, aged on purpose. */
function machineWith(spooledAgoMs: number, urgency: 'interrupt' | 'finish') {
  const home = mkdtempSync(join(tmpdir(), 'agentsignal-latency-'));
  const state = join(home, '.claude', 'plugins', 'data', 'agentsignal-agentsignal');
  mkdirSync(state, { recursive: true });

  writeFileSync(
    join(state, 'agent.json'),
    JSON.stringify({ credential: 'install.secret', base_url: 'http://127.0.0.1:9', handle: 'lat' }),
  );

  const spooledAt = new Date(Date.now() - spooledAgoMs).toISOString();
  writeFileSync(
    join(state, 'inbox-spool.json'),
    JSON.stringify({
      since: spooledAt,
      messages: [
        {
          delivery_id: 'd-1',
          title: 'a title',
          body: 'a body',
          priority: urgency === 'interrupt' ? 2 : 0,
          urgency,
          // Older than the spool write, as a real one always is.
          created_at: new Date(Date.now() - spooledAgoMs - 500).toISOString(),
          spooled_at: spooledAt,
        },
      ],
    }),
  );
  return { home, state };
}

function runHook(home: string, state: string, mode: string) {
  const inherited = { ...process.env };
  delete inherited.AGENTSIGNAL_DEVICE_SECRET;
  return spawnSync(process.execPath, [HOOK, mode], {
    env: {
      ...inherited,
      HOME: home,
      AGENTSIGNAL_STATE_DIR: state,
      AGENTSIGNAL_BASE_URL: 'http://127.0.0.1:9',
      AGENTSIGNAL_NO_KEYCHAIN: '1',
      // The watch loop otherwise sits for ten minutes.
      AGENTSIGNAL_WATCH_SECONDS: '2',
    },
    encoding: 'utf8',
    timeout: 30_000,
  });
}

function latency(state: string) {
  const path = join(state, 'latency.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('how long a message waited', () => {
  it('records the wait when a message surfaces between tool calls', () => {
    const { home, state } = machineWith(4_000, 'finish');

    const run = runHook(home, state, 'finish');
    expect(run.status, run.stderr).not.toBe(null);

    const [row] = latency(state);
    expect(row, 'nothing was recorded at all').toBeTruthy();
    expect(row!.delivery_id).toBe('d-1');
    expect(row!.mode).toBe('finish');

    /*
      THE NUMBER THIS EXISTS FOR. Four seconds were spent in the spool, so a
      measurement that came back near zero would mean it was timing itself
      rather than the wait.
    */
    expect(row!.spool_to_surface_ms as number).toBeGreaterThan(3_500);
    expect(row!.spool_to_surface_ms as number).toBeLessThan(30_000);

    // Sent before it was spooled, so the total is the larger of the two.
    expect(row!.sent_to_surface_ms as number).toBeGreaterThan(
      row!.spool_to_surface_ms as number,
    );
  }, 60_000);

  /**
   * The interrupt path is the one the product actually promises, and it carries
   * its own poll on top of the wait.
   */
  it('records it on the interrupt path too, and says which path it was', () => {
    const { home, state } = machineWith(3_000, 'interrupt');

    runHook(home, state, 'watch');

    const [row] = latency(state);
    expect(row, 'the watch path recorded nothing').toBeTruthy();
    expect(row!.mode).toBe('watch');
    expect(row!.urgency).toBe('interrupt');
    expect(row!.spool_to_surface_ms as number).toBeGreaterThan(2_500);
  }, 60_000);

  /** A latency log that accumulates everybody's messages is a different file. */
  it('writes timings and never the message itself', () => {
    const { home, state } = machineWith(1_000, 'finish');

    runHook(home, state, 'finish');

    const raw = readFileSync(join(state, 'latency.jsonl'), 'utf8');
    expect(raw).not.toContain('a title');
    expect(raw).not.toContain('a body');
    expect(raw).toContain('spool_to_surface_ms');
  }, 60_000);

  /**
   * An older message has no stamp, and "not measured" must not read as
   * "measured as zero" -- that would quietly drag an average toward the answer
   * somebody hoped for.
   */
  it('says null rather than zero for a message that predates the stamp', () => {
    const { home, state } = machineWith(1_000, 'finish');
    const spoolPath = join(state, 'inbox-spool.json');
    const spool = JSON.parse(readFileSync(spoolPath, 'utf8'));
    delete spool.messages[0].spooled_at;
    writeFileSync(spoolPath, JSON.stringify(spool));

    runHook(home, state, 'finish');

    const [row] = latency(state);
    expect(row!.spool_to_surface_ms).toBeNull();
    expect(row!.sent_to_spool_ms).toBeNull();
  }, 60_000);
});
