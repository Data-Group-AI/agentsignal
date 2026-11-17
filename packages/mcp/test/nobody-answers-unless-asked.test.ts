import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * EVERYBODY ANSWERS. THE FLOOR IS WHAT IS DEFENDED.
 *
 * This file used to be called nobody-answers-unless-asked, and the property it
 * defended was that a responder never spawned by default -- that consenting to
 * an autonomous agent could not arrive in a patch release. That property was
 * given up deliberately on 2026-08-21: `off` was removed, so a fresh install
 * answers, and so does one that had explicitly turned answering off.
 *
 * What is left to defend is the FLOOR, and it is worth more than it sounds. A
 * session that arrives uninvited may TALK -- read the inbox, reply, notify --
 * and may not run a command or write a file. Everything below is about the
 * difference between those two, because that is the line an update is still
 * not allowed to cross.
 *
 * The brakes themselves are covered by `responder.mjs --self-test`, which is
 * pure and can prove each fails closed. What that cannot show is the DAEMON
 * honouring them, which is what this is for: a real daemon, a real spool
 * holding a real unhandled message.
 */

const DAEMON = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../plugins/agentsignal/scripts/inbox-daemon.mjs',
);

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

/** A machine holding one message that no session ever took, aged past any grace. */
function machineWithAnUnansweredMessage() {
  const home = mkdtempSync(join(tmpdir(), 'agentsignal-quiet-'));
  const data = join(home, '.claude', 'plugins', 'data', 'agentsignal-agentsignal');
  mkdirSync(data, { recursive: true });
  mkdirSync(join(home, '.agentsignal'), { recursive: true });

  writeFileSync(
    join(data, 'agent.json'),
    JSON.stringify({ credential: 'install.secret', base_url: UNREACHABLE, handle: 'resp' }),
  );

  const old = new Date(Date.now() - 10 * 60_000).toISOString();
  writeFileSync(
    join(data, 'inbox-spool.json'),
    JSON.stringify({
      since: old,
      messages: [
        {
          delivery_id: 'd-unanswered',
          title: 'Are you there?',
          body: 'Nobody took this one.',
          priority: 2,
          urgency: 'interrupt',
          created_at: old,
          spooled_at: old,
          from_recipient_key: 'u_someone',
          options: ['yes', 'no'],
        },
      ],
    }),
  );

  return { home, data: join(home, '.claude', 'plugins', 'data') };
}

function start(home: string, data: string, env: Record<string, string> = {}) {
  const inherited = { ...process.env };
  delete inherited.AGENTSIGNAL_STATE_DIR;
  delete inherited.AGENTSIGNAL_DEVICE_SECRET;
  delete inherited.AGENTSIGNAL_RESPONDER;

  const child = spawn(process.execPath, [DAEMON, 'watch'], {
    env: {
      ...inherited,
      HOME: home,
      CLAUDE_PLUGIN_DATA: data,
      AGENTSIGNAL_BASE_URL: UNREACHABLE,
      AGENTSIGNAL_NO_KEYCHAIN: '1',
      ...env,
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

describe('what an uninvited responder may do', () => {
  /**
   * A machine that never asked for anything answers -- and that is the whole
   * change, stated as a test rather than left to a comment.
   *
   * The assertion that matters is the second one. Being switched on by an
   * update may not also mean being handed the machine: no Bash, no Write, no
   * acceptEdits. If that ever passes, an update has taken something nobody
   * offered it.
   */
  it('answers on a machine that never turned it on, and may not touch it', async () => {
    const { home, data } = machineWithAnUnansweredMessage();

    const daemon = start(home, data);
    await settle(10_000);

    /*
      The ledger is the tell. It is written on every decision INCLUDING every
      refusal, so its presence means the responder ran and decided rather than
      never looking.
    */
    expect(
      existsSync(join(home, '.agentsignal', 'responder-ledger.jsonl')),
      `no ledger, so the responder never ran at all:\n${daemon.said()}`,
    ).toBe(true);

    /*
      Matched on what the responder SAYS, not on the word. A first draft
      asserted /responder/i and failed against a temp directory the test itself
      had named `agentsignal-responder-...`, which the daemon prints as part of
      the spool path -- a test failing on its own fixture.
    */
    expect(daemon.said()).toMatch(/responder (answering|declined|finished)/);

    // THE FLOOR. An uninvited session talks; it does not act.
    expect(daemon.said()).not.toMatch(/\(act\)/);
  }, 60_000);

  /**
   * Turned on, and still refusing -- because this message names a peer it has
   * already answered inside the cooldown. Two responders answering each other
   * forever is the failure that has no natural end, so the brake is checked
   * against a real daemon rather than only in the pure self-test.
   */
  it('honours the peer cooldown even once enabled', async () => {
    const { home, data } = machineWithAnUnansweredMessage();

    writeFileSync(
      join(home, '.agentsignal', 'responder-ledger.jsonl'),
      `${JSON.stringify({ event: 'spawn', at: Date.now(), peer: 'u_someone' })}\n`,
    );

    const daemon = start(home, data, { AGENTSIGNAL_RESPONDER: 'answer' });
    await settle(8_000);

    expect(daemon.said(), 'it spawned despite having just answered this peer')
      .not.toMatch(/responder answering/);
    expect(daemon.said()).toMatch(/responder declined .*peer_cooldown/);
  }, 60_000);
});
