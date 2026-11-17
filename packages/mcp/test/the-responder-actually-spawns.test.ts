import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import {
  chmodSync,
  realpathSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * The responder has brakes nobody had ever driven past.
 *
 * `responder.mjs --self-test` proves the refusals: disabled, chain depth,
 * already handled, no spool stamp, within grace, another responder running,
 * hourly cap, daily cap, peer cooldown. Every one fails closed. What none of
 * them proves is that anything ever gets THROUGH -- the happy path had never
 * run, on this machine or any other, and a gate only ever tested shut is not
 * known to open.
 *
 * Running it found three things, none of which a refusal test could see:
 * the same message spawned a session on every cycle, the peer cooldown could
 * never engage because the sender never reached the spool, and the prompt did
 * not name the message the session was told to answer.
 *
 * That is the gap this closes. A message arrives, nothing takes it, the grace
 * period elapses, and a session is spawned with the right prompt and the right
 * tools.
 *
 * WHAT IS DELIBERATELY NOT TESTED HERE: whether the spawned Claude answers
 * well, or at all. That is a property of the session and of the plugin
 * installed where it runs, not of this file, and testing it would mean an LLM
 * call inside a unit test. `claude` is stubbed with a script that records its
 * argv, so what is asserted is exactly what the responder controls -- that it
 * spawns, once, with the mode's tools and a prompt carrying the message.
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
  for (const server of servers.splice(0)) {
    await new Promise((resolve) => server.close(resolve));
  }
});

/** An API that hands over some messages and then holds requests open. */
async function apiWithOneMessage(message: Record<string, unknown> | Record<string, unknown>[]) {
  const batch = Array.isArray(message) ? message : [message];
  let handedOver = false;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (!url.pathname.endsWith('/v1/devices/me/messages')) {
      res.writeHead(404).end('{}');
      return;
    }
    const send = (messages: unknown[], waitedMs?: number) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          messages,
          ...(waitedMs === undefined ? {} : { waited_ms: waitedMs }),
        }),
      );
    };
    if (!handedOver) {
      handedOver = true;
      send(batch);
      return;
    }
    // Afterwards: behave like a real waiting server so the watcher rests
    // instead of spinning while the grace period elapses.
    const timer = setTimeout(() => send([], 5_000), 5_000);
    req.on('close', () => clearTimeout(timer));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

/**
 * A `claude` that records how it was called instead of being one.
 *
 * Placed first on PATH. Without this the test would either need a real session
 * -- an LLM call, money, and a dependency on whatever plugin happens to be
 * installed -- or it would prove nothing about the arguments, which are the
 * part the responder actually decides.
 */
function stubClaude(home: string) {
  const bin = join(home, 'bin');
  mkdirSync(bin, { recursive: true });
  const record = join(home, 'claude-invocations.jsonl');
  const script = join(bin, 'claude');
  writeFileSync(
    script,
    [
      '#!/usr/bin/env bash',
      // Argv AND stdin, one JSON object per invocation. Recording only argv is
      // what let the prompt-eaten-by---allowed-tools bug live: the arguments
      // looked right, and the thing that was missing was not in them.
      `python3 -c 'import json,os,sys; print(json.dumps({"argv": sys.argv[1:], "stdin": sys.stdin.read(), "cwd": os.getcwd()}))' "$@" >> ${JSON.stringify(record)}`,
      // Stands in for a session that fails, or for one that talks too much --
      // both of which the daemon has to survive and explain.
      //
      // STUB_FAIL_WHILE names a file, and the file IS the expired credential:
      // while it exists every session fails, and deleting it is what somebody
      // signing in looks like from here. A plain STUB_FAIL cannot express that,
      // because the daemon reads its environment once at spawn and a test
      // cannot reach in later to change it.
      'if [ -n "$STUB_FAIL_WHILE" ]; then',
      '  if [ -e "$STUB_FAIL_WHILE" ]; then echo "${STUB_FAIL:-Failed to authenticate}" >&2; exit 1; fi',
      'elif [ -n "$STUB_FAIL" ]; then echo "$STUB_FAIL" >&2; exit 1; fi',
      'if [ -n "$STUB_FLOOD" ]; then python3 -c "print(\'x\' * 300000)"; fi',
      'exit 0',
    ].join('\n'),
    { mode: 0o755 },
  );
  chmodSync(script, 0o755);
  return { bin, record };
}

function machine(base: string) {
  const home = mkdtempSync(join(tmpdir(), 'agentsignal-responder-run-'));
  const data = join(home, '.claude', 'plugins', 'data', 'agentsignal-agentsignal');
  mkdirSync(data, { recursive: true });
  // `repo` is what a real agent.json carries: the checkout the identity was
  // created in. The responder has to run THERE, not in the data directory.
  const repo = join(home, 'work');
  mkdirSync(repo, { recursive: true });
  writeFileSync(
    join(data, 'agent.json'),
    JSON.stringify({ credential: 'install.secret', base_url: base, handle: 'answerer', repo }),
  );
  return { home, data: join(home, '.claude', 'plugins', 'data'), repo, agentDir: data };
}

function startDaemon(home: string, data: string, base: string, extra: Record<string, string>) {
  const inherited = { ...process.env };
  delete inherited.AGENTSIGNAL_STATE_DIR;
  delete inherited.AGENTSIGNAL_DEVICE_SECRET;

  const child = spawn(process.execPath, [DAEMON, 'watch'], {
    env: {
      ...inherited,
      HOME: home,
      PATH: `${join(home, 'bin')}:${process.env.PATH ?? ''}`,
      CLAUDE_PLUGIN_DATA: data,
      AGENTSIGNAL_BASE_URL: base,
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

const MESSAGE = {
  delivery_id: 'd-answerable',
  message_id: 'm-answerable',
  title: 'Is the deploy green?',
  body: 'Answer yes or no.',
  urgency: 'normal',
  // `from_key` and `from_handle`, spelled as the SERVER's feed spells them --
  // see device_message_feed. Using the responder's own spelling here is what
  // hid the bug: the brakes' unit tests hand-build a message containing
  // `from_recipient_key`, a field nothing in the real pipeline ever produced.
  from_key: 'u_asker',
  from_handle: 'asker-bot',
  created_at: new Date().toISOString(),
};

type Invocation = { argv: string[]; stdin: string; cwd: string };

/** Invocations recorded by the stub, newest last. */
function invocations(record: string): Invocation[] {
  if (!existsSync(record)) return [];
  return readFileSync(record, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Invocation);
}

describe('the responder actually spawns', () => {
  it('spawns a session for a message nothing else took', async () => {
    const base = await apiWithOneMessage(MESSAGE);
    const { home, data } = machine(base);
    const { record } = stubClaude(home);

    const watcher = startDaemon(home, data, base, {
      AGENTSIGNAL_RESPONDER: 'answer',
      // Seconds rather than the 45 it ships with. The grace period is already
      // tested as a refusal; what is under test here is what happens after it.
      AGENTSIGNAL_RESPONDER_GRACE_MS: '1500',
    });

    await settle(12_000);

    const calls = invocations(record);
    expect(calls.length, `no session was spawned:\n${watcher.said()}`).toBe(1);

    const args = calls[0]?.argv ?? [];
    expect(args).toContain('--print');
    // `answer` mode, so the session may talk and must not touch the machine.
    expect(args).toContain('dontAsk');
    expect(args).toContain('mcp__plugin_agentsignal_agentsignal__respond_to_message');
    expect(args).not.toContain('Bash');
    expect(args).not.toContain('Write');

    /*
      THE PROMPT ARRIVES ON STDIN, and it must NOT be in argv.

      This is the assertion that would have caught the bug that made the
      responder incapable of answering anything: `--allowed-tools` is variadic
      and ate the prompt as a fifth tool name, so claude exited 1 with "Input
      must be provided". The old test checked that argv contained the tools and
      that its last element was the prompt -- both true, and both true of a
      command that could not run.
    */
    const prompt = calls[0]?.stdin ?? '';
    expect(prompt).toContain('Is the deploy green?');
    expect(prompt).toContain('d-answerable');
    expect(
      args.some((a) => a.includes('Is the deploy green?')),
      'the prompt is in argv, where --allowed-tools will swallow it',
    ).toBe(false);

    // And the decision is written down, because a responder that acts without
    // a record is one nobody can audit afterwards.
    const ledger = join(home, '.agentsignal', 'responder-ledger.jsonl');
    const entries = readFileSync(ledger, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { event: string; peer?: string });
    expect(entries.some((e) => e.event === 'spawn' && e.peer === 'u_asker')).toBe(true);
  }, 60_000);

  /**
   * `off` WAS REMOVED, and this is the test that says so rather than a comment
   * claiming it. A machine carrying the old value answers now.
   *
   * This test used to assert the opposite -- that off spawned nothing, and that
   * the default cost nothing for people who never turned it on. That guarantee
   * was given up deliberately on 2026-08-21. Keeping the old assertion passing
   * would have meant keeping a mode that no longer exists; deleting it without
   * replacement would leave the reversal untested. So it asserts the new
   * behaviour, including the part that is a cost.
   */
  it('answers even on a machine that had it switched off', async () => {
    const base = await apiWithOneMessage(MESSAGE);
    const { home, data } = machine(base);
    const { record } = stubClaude(home);

    // What an install that had chosen `off` is carrying on disk.
    mkdirSync(join(home, '.agentsignal'), { recursive: true });
    writeFileSync(
      join(home, '.agentsignal', 'settings.json'),
      JSON.stringify({ responder: 'off' }),
    );

    const watcher = startDaemon(home, data, base, {
      AGENTSIGNAL_RESPONDER_GRACE_MS: '1500',
    });

    await settle(12_000);

    const calls = invocations(record);
    expect(calls.length, `it stayed silent:\n${watcher.said()}`).toBe(1);

    // THE FLOOR. Being flipped on may not also mean being handed the machine:
    // an install that never asked for anything gets a session that can talk
    // and cannot run a command or write a file.
    const args = calls[0]?.argv ?? [];
    expect(args).toContain('dontAsk');
    expect(args).not.toContain('Bash');
    expect(args).not.toContain('Write');
    expect(args).not.toContain('acceptEdits');

    // And it is said out loud, once, to the people whose choice this reversed.
    expect(watcher.said()).toMatch(/used to be off on this machine/);
    expect(watcher.said()).toMatch(/remove the plugin/);
  }, 60_000);

  /**
   * A message spooled before `spooled_at` existed is answerable, eventually.
   *
   * The field was added on 2026-08-20. Anything already in a spool at that
   * point has no stamp, and `mayRespond` refuses an unstamped message because
   * it cannot tell whether the grace period elapsed -- correct, and permanent,
   * because the spool only shrinks when a hook marks something handled. Three
   * such messages were sitting on a real machine, refused 291 times each and
   * unanswerable forever.
   *
   * The repair is a lower bound, not a guess: the daemon stamps what it first
   * sees and starts the grace period from there.
   */
  it('stamps a legacy message that has no spooled_at, instead of refusing it forever', async () => {
    const base = await apiWithOneMessage(MESSAGE);
    const { home, data } = machine(base);
    const { record } = stubClaude(home);

    // A spool as an older version left it: a real message, no stamp.
    const spool = join(data, 'agentsignal-agentsignal', 'inbox-spool.json');
    writeFileSync(
      spool,
      JSON.stringify({
        since: new Date().toISOString(),
        messages: [
          {
            delivery_id: 'd-legacy',
            message_id: 'm-legacy',
            title: 'Spooled before stamps existed',
            body: 'still waiting',
            urgency: 'normal',
            created_at: new Date().toISOString(),
          },
        ],
      }),
    );

    const watcher = startDaemon(home, data, base, {
      AGENTSIGNAL_RESPONDER: 'answer',
      AGENTSIGNAL_RESPONDER_GRACE_MS: '1500',
      AGENTSIGNAL_RESPONDER_PER_HOUR: '10',
      AGENTSIGNAL_RESPONDER_PER_DAY: '10',
      AGENTSIGNAL_RESPONDER_PEER_COOLDOWN_MS: '0',
    });

    await settle(14_000);

    // It says so, because a daemon rewriting somebody's spool should be
    // legible in the log rather than a silent edit.
    expect(watcher.said()).toMatch(/predate spooled_at/);

    // The stamp is persisted, so a restart does not reset the wait.
    const written = JSON.parse(readFileSync(spool, 'utf8')) as {
      messages: { delivery_id: string; spooled_at?: string }[];
    };
    const legacy = written.messages.find((m) => m.delivery_id === 'd-legacy');
    expect(legacy?.spooled_at, 'the legacy message was never stamped').toBeTruthy();

    // And it becomes answerable rather than being declined forever.
    const answered = invocations(record).some((c) => c.stdin.includes('d-legacy'));
    expect(answered, `never answered:\n${watcher.said()}`).toBe(true);
  }, 60_000);

  /**
   * THE SESSION RUNS WHERE THE WORK IS.
   *
   * The cwd was `identity.dir` -- the plugin's data directory, holding
   * agent.json and the spool. In `answer` mode that is invisible, because the
   * session cannot reach a file anyway. In `act` mode it is the whole feature:
   * a session told to read, search and run commands, started in a folder with
   * two JSON files in it and none of the code it was asked about.
   *
   * `agent.json` has recorded `repo` since long before this, and the daemon
   * simply never used it.
   */
  it('runs the session in the repo the agent joined from, not the data directory', async () => {
    const base = await apiWithOneMessage(MESSAGE);
    const { home, data, repo, agentDir } = machine(base);
    stubClaude(home);

    const watcher = startDaemon(home, data, base, {
      AGENTSIGNAL_RESPONDER: 'answer',
      AGENTSIGNAL_RESPONDER_GRACE_MS: '1500',
    });

    await settle(12_000);

    const calls = invocations(join(home, 'claude-invocations.jsonl'));
    expect(calls.length, `no session was spawned:\n${watcher.said()}`).toBe(1);

    // realpath, because /var and /private/var are the same directory on a Mac
    // and comparing the strings would fail on a machine that is behaving.
    expect(realpathSync(calls[0]!.cwd)).toBe(realpathSync(repo));
    expect(realpathSync(calls[0]!.cwd)).not.toBe(realpathSync(agentDir));
  }, 60_000);

  /**
   * A MACHINE THAT CANNOT START A SESSION STOPS TRYING.
   *
   * "Failed to authenticate" is identical for every message and unchanged by
   * the next one. Without this, each arriving message spawns, dies in under a
   * second, and spends one of six hourly slots -- so a machine that cannot
   * start a session burns its whole budget every hour on sessions that never
   * ran, and the ledger fills with identical corpses.
   *
   * Two messages here, both eligible. One spawn is the pass.
   */
  it('stops spawning once a session proves it cannot start', async () => {
    const second = { ...MESSAGE, delivery_id: 'd-second', message_id: 'm-second' };
    const base = await apiWithOneMessage([MESSAGE, second]);
    const { home, data } = machine(base);
    const { record } = stubClaude(home);

    const watcher = startDaemon(home, data, base, {
      AGENTSIGNAL_RESPONDER: 'answer',
      AGENTSIGNAL_RESPONDER_GRACE_MS: '1500',
      AGENTSIGNAL_RESPONDER_PER_HOUR: '10',
      AGENTSIGNAL_RESPONDER_PER_DAY: '10',
      AGENTSIGNAL_RESPONDER_PEER_COOLDOWN_MS: '0',
      STUB_FAIL: 'Failed to authenticate: OAuth session expired and could not be refreshed',
    });

    await settle(20_000);

    expect(
      invocations(record).length,
      `it kept spawning doomed sessions:\n${watcher.said()}`,
    ).toBe(1);

    const ledger = readFileSync(join(home, '.agentsignal', 'responder-ledger.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { event: string; why?: string });

    expect(ledger.some((e) => e.event === 'unavailable')).toBe(true);
    // And it says what to do, not only that something is wrong.
    expect(watcher.said()).toMatch(/cannot start sessions on this machine/);
    expect(watcher.said()).toMatch(/claude auth login/);
    // It must not tell anybody to restart anything. That advice was the bug:
    // the restart it asked for is the one the pidfile guard prevents.
    expect(watcher.said()).toMatch(/no restart needed/);
  }, 60_000);

  /**
   * GIVING UP IS NOT THE SAME AS GIVING UP FOREVER.
   *
   * The test above proves it stops. This proves it starts again, and it exists
   * because for two days and one hour it did not.
   *
   * `unavailable` was a boolean held "until the daemon restarts", on the
   * reasoning that a restart is what happens the next time somebody opens a
   * session. The daemon outlives sessions on purpose and guards itself with a
   * pidfile, so every later SessionStart found it already running and said so.
   * The recovery path depended on exactly the thing the guard exists to stop.
   *
   * What that cost, measured on 2026-08-23: an expiry at 2026-08-21 23:32, a
   * daemon still alive two days later having evaluated nothing since, four
   * messages that reached the spool and appear NOWHERE in the ledger -- not
   * answered, not refused -- and a person signing back in with no effect at
   * all, because nothing re-read the credential.
   *
   * One message per retry, because `already_answered` is permanent by design:
   * a delivery that has been spawned for once can never be spawned for again,
   * so a single message could not show a second attempt even if one happened.
   */
  it('gives up, then finds out on its own that it can start sessions again', async () => {
    const batch = Array.from({ length: 6 }, (_, i) => ({
      ...MESSAGE, delivery_id: `d-retry-${i}`, message_id: `m-retry-${i}`,
    }));
    const base = await apiWithOneMessage(batch);
    const { home, data } = machine(base);
    const { record } = stubClaude(home);

    // The file is the expired credential. While it is here, no session starts.
    const expired = join(home, 'the-credential-is-expired');
    writeFileSync(expired, 'expired');

    const watcher = startDaemon(home, data, base, {
      AGENTSIGNAL_RESPONDER: 'answer',
      AGENTSIGNAL_RESPONDER_GRACE_MS: '1500',
      AGENTSIGNAL_RESPONDER_PER_HOUR: '20',
      AGENTSIGNAL_RESPONDER_PER_DAY: '20',
      AGENTSIGNAL_RESPONDER_PEER_COOLDOWN_MS: '0',
      // Seconds rather than minutes. The doubling is arithmetic and is tested
      // in responder.mjs --self-test; what is under test here is that the
      // daemon consults it at all.
      AGENTSIGNAL_RESPONDER_UNAVAILABLE_RETRY_MS: '2000',
      AGENTSIGNAL_RESPONDER_UNAVAILABLE_RETRY_CAP_MS: '4000',
      STUB_FAIL_WHILE: expired,
      STUB_FAIL: 'Failed to authenticate: OAuth session expired and could not be refreshed',
    });

    await settle(14_000);

    const whileExpired = invocations(record).length;
    expect(
      whileExpired,
      `it never tried again after giving up:\n${watcher.said()}`,
    ).toBeGreaterThan(1);

    // ...but not on every two-second cycle either. Retrying everything is the
    // failure this replaced, and it is the one that empties the hourly budget.
    expect(whileExpired).toBeLessThan(7);

    // Somebody signs in.
    rmSync(expired);
    await settle(12_000);

    const ledger = readFileSync(join(home, '.agentsignal', 'responder-ledger.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { event: string });

    expect(ledger.some((e) => e.event === 'retrying')).toBe(true);
    // THE POINT: nothing restarted, and it is answering again.
    expect(
      ledger.some((e) => e.event === 'available'),
      `it never noticed it had recovered:\n${watcher.said()}`,
    ).toBe(true);
    expect(invocations(record).length).toBeGreaterThan(whileExpired);
  }, 60_000);

  /**
   * AN EXIT CODE IS NOT A REASON.
   *
   * Five spawns on a real machine all recorded `exit_code: 1` and nothing
   * else, so they looked like one fault and were two: the first pair died
   * because --allowed-tools had eaten the prompt, the last three because the
   * session could not authenticate. The second was invisible until the first
   * was fixed, because the ledger could not tell them apart.
   */
  it('records why a session failed, not just that it did', async () => {
    const base = await apiWithOneMessage(MESSAGE);
    const { home, data } = machine(base);
    stubClaude(home);

    const watcher = startDaemon(home, data, base, {
      AGENTSIGNAL_RESPONDER: 'answer',
      AGENTSIGNAL_RESPONDER_GRACE_MS: '1500',
      STUB_FAIL: 'Failed to authenticate: OAuth session expired',
    });

    await settle(12_000);

    const ledger = readFileSync(join(home, '.agentsignal', 'responder-ledger.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { event: string; exit_code?: number; why?: string });

    const finished = ledger.find((e) => e.event === 'finished');
    expect(finished, `nothing finished:\n${watcher.said()}`).toBeTruthy();
    expect(finished?.exit_code).toBe(1);
    expect(finished?.why, 'the ledger recorded a failure with no reason').toContain(
      'Failed to authenticate',
    );
    // And it is on screen too, not only in the file.
    expect(watcher.said()).toMatch(/Failed to authenticate/);
  }, 60_000);

  /**
   * A TALKATIVE SESSION MUST NOT WEDGE THE MACHINE.
   *
   * stdout and stderr were piped and never read. A pipe buffer is finite, so a
   * session printing more than about 64KB blocks on the write and never exits
   * -- while holding the single-flight lock, which means one noisy session
   * stops this machine running a responder ever again.
   *
   * 300KB is comfortably past any buffer. What is asserted is that it finishes
   * at all.
   */
  it('survives a session that prints more than a pipe buffer', async () => {
    const base = await apiWithOneMessage(MESSAGE);
    const { home, data } = machine(base);
    stubClaude(home);

    const watcher = startDaemon(home, data, base, {
      AGENTSIGNAL_RESPONDER: 'answer',
      AGENTSIGNAL_RESPONDER_GRACE_MS: '1500',
      STUB_FLOOD: '1',
    });

    await settle(14_000);

    const ledgerPath = join(home, '.agentsignal', 'responder-ledger.jsonl');
    const ledger = readFileSync(ledgerPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { event: string; exit_code?: number });

    expect(
      ledger.some((e) => e.event === 'finished' && e.exit_code === 0),
      `it never finished, so the pipe filled and the lock is still held:\n${watcher.said()}`,
    ).toBe(true);

    // The ledger must not have swallowed 300KB of it either.
    expect(readFileSync(ledgerPath, 'utf8').length).toBeLessThan(20_000);
  }, 60_000);

  /**
   * A REFUSAL IS RECORDED ONCE, not on every cycle.
   *
   * `already_answered` is permanent by design and `no_spool_stamp` can never
   * become false, so re-recording them each pass turns the ledger into a
   * growing file that says the same thing forever. Measured on a real machine
   * before this was fixed: 1,447 refusals in two hours, one delivery refused
   * 291 times, about a megabyte and a half a day -- and the ledger is re-read
   * on every cycle, so it gets slower as it gets bigger.
   *
   * The first refusal is kept. It is the line somebody needs when they ask why
   * a message was never answered; it is the 291st that is worth nothing.
   */
  it('records a permanent refusal once, not on every cycle', async () => {
    const base = await apiWithOneMessage(MESSAGE);
    const { home, data } = machine(base);
    const { record } = stubClaude(home);

    const watcher = startDaemon(home, data, base, {
      AGENTSIGNAL_RESPONDER: 'answer',
      AGENTSIGNAL_RESPONDER_GRACE_MS: '1500',
      // No cap and no cooldown in the way, so the only thing that can stop a
      // second spawn is `already_answered` -- the permanent refusal under test.
      AGENTSIGNAL_RESPONDER_PER_HOUR: '10',
      AGENTSIGNAL_RESPONDER_PER_DAY: '10',
      AGENTSIGNAL_RESPONDER_PEER_COOLDOWN_MS: '0',
    });

    await settle(20_000);

    expect(invocations(record).length, watcher.said()).toBe(1);

    const ledger = readFileSync(join(home, '.agentsignal', 'responder-ledger.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { event: string; why?: string; delivery_id?: string });

    const refusals = ledger.filter(
      (e) => e.event === 'refused' && e.delivery_id === MESSAGE.delivery_id,
    );
    const answered = refusals.filter((e) => e.why === 'already_answered');

    // Several cycles ran in twenty seconds; without the fix this is one line
    // per cycle rather than one line.
    expect(
      answered.length,
      `already_answered recorded ${answered.length} times:\n${JSON.stringify(refusals)}`,
    ).toBeLessThanOrEqual(1);
  }, 60_000);

  /**
   * One message, one session. The rate caps are tested as pure refusals in
   * --self-test; this is the one that would catch the loop spawning again on
   * every cycle for a message it had already taken, which no unit test of
   * `mayRespond` can see.
   */
  it('does not spawn twice for the same message', async () => {
    const base = await apiWithOneMessage(MESSAGE);
    const { home, data } = machine(base);
    const { record } = stubClaude(home);

    const watcher = startDaemon(home, data, base, {
      AGENTSIGNAL_RESPONDER: 'answer',
      AGENTSIGNAL_RESPONDER_GRACE_MS: '1500',
      // Room for a second spawn if the code wanted one, so a pass here means
      // the responder declined rather than that a cap stopped it.
      AGENTSIGNAL_RESPONDER_PER_HOUR: '10',
      AGENTSIGNAL_RESPONDER_PER_DAY: '10',
      AGENTSIGNAL_RESPONDER_PEER_COOLDOWN_MS: '0',
    });

    await settle(20_000);

    expect(
      invocations(record).length,
      `spawned more than once:\n${watcher.said()}`,
    ).toBe(1);
  }, 60_000);
});
