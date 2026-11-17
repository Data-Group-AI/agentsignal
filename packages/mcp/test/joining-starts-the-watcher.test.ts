import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import {
  rmSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * Joining mid-session has to start the watcher, because nothing else will.
 *
 * THE GAP THIS COMES FROM, found by walking a clean install end to end. A fresh
 * machine signed up, installed the plugin and ran `/agentsignal-join`. It
 * registered, the API accepted it, `find_agents_in_my_channels` listed it as
 * live -- and no process was reading its inbox. The watcher had started at
 * SessionStart, seventy-three seconds BEFORE the credential existed, found
 * nothing to watch and exited, correctly. Nothing would start another until the
 * next session.
 *
 * So the ordinary path into the product ended with an agent that is addressable
 * and unreachable at the same time, and no error anywhere says so. Every
 * symptom points away from the cause: the directory is right, the credential is
 * right, the daemon logged a truthful message about a moment that has passed.
 *
 * IT IS THE SAME SHAPE as the bugs this codebase keeps meeting -- a value that
 * is real and correct everywhere except in the one place that would act on it.
 * A join code is DESIGNED to work mid-session; the daemon's own lock comment
 * says as much. Only the thing that starts the daemon had not been told.
 *
 * WHY THE HOOK AND NOT THE MCP SERVER. The daemon ships in the plugin; the MCP
 * server is a published package that also runs standalone from `claude mcp
 * add`, where there is no daemon to start. PostToolUse already fires
 * constantly, already lives beside the daemon, and already knows where it is.
 */

const SCRIPTS = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../plugins/agentsignal/scripts',
);
const HOOK = join(SCRIPTS, 'inbox-hook.mjs');

// Nothing listens here, so the started daemon stays up long enough to be seen
// rather than dying on a refused connection.
const UNREACHABLE = 'http://127.0.0.1:9';

const started: number[] = [];
const rivals: ChildProcess[] = [];
/**
 * Every lock directory handed out, so cleanup can re-read it.
 *
 * Killing only the pids `settle` managed to see leaks processes: a daemon that
 * registers a moment after the wait gives up is never captured, and then it
 * polls forever on a developer's machine. This file left three of them behind
 * in one afternoon -- a poor thing to do in the tests for a bug about watchers
 * nobody is counting.
 */
const machines: string[] = [];

/**
 * A real, live process that is not this one.
 *
 * It has to be a genuinely foreign pid. Writing this process's own pid into
 * the registry looks like a rival from the outside and is skipped from the
 * inside -- `livingWatchers` ignores its own entry, because a daemon must not
 * stand down in deference to itself. The first draft of this test did exactly
 * that and passed for the wrong reason.
 */
function livePid(): number {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], {
    stdio: 'ignore',
  });
  rivals.push(child);
  return child.pid!;
}

afterEach(() => {
  for (const pid of started.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
  for (const child of rivals.splice(0)) {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
  // Re-read each registry at cleanup time rather than trusting what the wait
  // saw, then take the directory with it.
  for (const home of machines.splice(0)) {
    for (const pid of registryPids(join(home, 'state'))) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
    try {
      rmSync(home, { recursive: true, force: true });
    } catch {
      /* it was a temp directory anyway */
    }
  }
});

/** A throwaway machine whose lock and credential are its own. */
function machine({ withCredential = true } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'agentsignal-start-'));
  machines.push(home);
  const lock = join(home, 'state');
  mkdirSync(lock, { recursive: true });
  if (withCredential) {
    writeFileSync(
      join(lock, 'agent.json'),
      JSON.stringify({
        credential: 'start-test-secret',
        base_url: UNREACHABLE,
        handle: 'start-test',
        key: 'u_startTest',
      }),
    );
  }
  return { home, lock };
}

function env(lock: string) {
  const inherited = { ...process.env };
  delete inherited.AGENTSIGNAL_DEVICE_SECRET;
  return {
    ...inherited,
    // Passed through so a spawned server obeys the same keychain switch as the
    // runner. Empty means "not set", which is what an ordinary run looks like.
    AGENTSIGNAL_NO_KEYCHAIN: process.env.AGENTSIGNAL_NO_KEYCHAIN ?? '',
    AGENTSIGNAL_STATE_DIR: lock,
    AGENTSIGNAL_BASE_URL: UNREACHABLE,
  };
}

function registryPids(lock: string): number[] {
  try {
    return readdirSync(join(lock, 'watchers'))
      .filter((n) => n.endsWith('.json'))
      .map((n) => JSON.parse(readFileSync(join(lock, 'watchers', n), 'utf8')).pid as number);
  } catch {
    return [];
  }
}

/** Give a detached spawn a moment to register itself. */
async function settle(lock: string, ms = 4000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const pids = registryPids(lock);
    if (pids.length) return pids;
    await new Promise((r) => setTimeout(r, 100));
  }
  return registryPids(lock);
}

const load = () => import(pathToFileURL(join(SCRIPTS, 'watchers.mjs')).href);

describe('a credential with nothing watching it', () => {
  it('starts a watcher, through the hook a real session runs', async () => {
    const { lock } = machine();

    // The actual PostToolUse command, not a re-implementation of it.
    const result = spawnSync(process.execPath, [HOOK, 'check'], {
      env: env(lock),
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);

    const pids = await settle(lock);
    started.push(...pids);

    expect(pids).toHaveLength(1);
    // A watcher that registered is a watcher that got past the credential
    // check -- which is the whole thing that was missing.
    expect(existsSync(join(lock, 'inbox-daemon.pid'))).toBe(true);
  });

  it('reports what it did, so the decision is inspectable', async () => {
    const { lock } = machine();
    const { ensureWatcher } = await load();

    const outcome = ensureWatcher({
      lockRoot: lock,
      daemonPath: join(SCRIPTS, 'inbox-daemon.mjs'),
      baseUrl: UNREACHABLE,
      env: env(lock),
    });

    expect(outcome).toEqual({ started: true, reason: 'nothing was watching' });
    started.push(...(await settle(lock)));
  });
});

describe('when it must keep its hands off', () => {
  it('does not start a second watcher beside a living one', async () => {
    const { lock } = machine();
    const { ensureWatcher } = await load();

    const rival = livePid();
    mkdirSync(join(lock, 'watchers'), { recursive: true });
    writeFileSync(
      join(lock, 'watchers', `${rival}.json`),
      JSON.stringify({ pid: rival, script: 'rival', mtime: Date.now() }),
    );

    const outcome = ensureWatcher({
      lockRoot: lock,
      daemonPath: join(SCRIPTS, 'inbox-daemon.mjs'),
      baseUrl: UNREACHABLE,
      env: env(lock),
    });

    expect(outcome.started).toBe(false);
    expect(outcome.reason).toBe('already watching');
    // Two watchers on one inbox fetch every message twice and interrupt twice
    // off a single send, which is why this is the important half.
    expect(registryPids(lock)).toEqual([rival]);
  });

  it('does nothing on a machine that has not registered', async () => {
    const { lock } = machine({ withCredential: false });
    const { ensureWatcher } = await load();

    const outcome = ensureWatcher({
      lockRoot: lock,
      daemonPath: join(SCRIPTS, 'inbox-daemon.mjs'),
      baseUrl: UNREACHABLE,
      env: env(lock),
    });

    expect(outcome).toEqual({ started: false, reason: 'no identity' });
    expect(registryPids(lock)).toEqual([]);
  });

  it('does not retry a failed start after every single tool call', async () => {
    const { lock } = machine();
    const { ensureWatcher } = await load();
    const at = 1_000_000;

    const first = ensureWatcher({
      lockRoot: lock,
      daemonPath: join(SCRIPTS, 'nonexistent-daemon.mjs'),
      baseUrl: UNREACHABLE,
      env: env(lock),
      now: at,
    });
    // Spawning a missing file fails asynchronously, so the call reports a start
    // either way; what matters is that the attempt was recorded.
    expect(existsSync(join(lock, 'watcher-start.json'))).toBe(true);
    expect(first.started).toBe(true);

    // A second later, the same tool-call storm arrives.
    const second = ensureWatcher({
      lockRoot: lock,
      daemonPath: join(SCRIPTS, 'nonexistent-daemon.mjs'),
      baseUrl: UNREACHABLE,
      env: env(lock),
      now: at + 1000,
    });
    expect(second).toEqual({ started: false, reason: 'tried recently' });

    // A minute later it is allowed to try again, because a watcher that died
    // for a transient reason should come back.
    const later = ensureWatcher({
      lockRoot: lock,
      daemonPath: join(SCRIPTS, 'nonexistent-daemon.mjs'),
      baseUrl: UNREACHABLE,
      env: env(lock),
      now: at + 61_000,
    });
    expect(later.started).toBe(true);
  });
});
