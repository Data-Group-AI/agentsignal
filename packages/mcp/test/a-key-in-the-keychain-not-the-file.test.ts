import { describe, expect, it } from 'vitest';
import {
  apiKeyReference,
  readKeychainSync,
  rememberApiKey,
  writeKeychainSync,
  type RunSync,
} from '../src/secrets.js';

/**
 * An agent's own channel key, kept somewhere better than a JSON file.
 *
 * A web join mints the agent a key and it has to survive a restart, so it goes
 * on disk. `0600` stops another USER and stops nothing else: every process
 * running as this one can read it, which on a developer's laptop is a large
 * and unexamined set. So the value goes in the OS keychain and `agent.json`
 * keeps a reference, the same shape a secret grant already uses.
 *
 * WHAT CAN GO WRONG QUIETLY, and is therefore what is asserted here:
 *
 *   • the key reaching `ps` -- `security -w <value>` puts a live credential in
 *     the argument list of a process, readable by everything running as this
 *     user for as long as the call lasts. It goes on stdin instead, and the
 *     only thing that can prove it stayed there is an assertion on the argv.
 *   • a key moved somewhere it cannot be read BACK from. That breaks the agent
 *     rather than merely exposing it, and breaks it at the next start rather
 *     than now -- so the write is proved by a read before the reference is
 *     kept, and a proof that fails must leave the plaintext alone.
 *
 * The runner is injected throughout: these tests must never touch a real
 * keychain, and a suite that prompts for a password is a suite nobody runs.
 */

/** A keychain that works, remembering what it was asked. */
function workingKeychain() {
  const items = new Map<string, string>();
  const calls: { command: string; args: string[]; input?: string }[] = [];
  const run: RunSync = (command, args, input) => {
    calls.push({ command, args, input });
    const service = args[args.indexOf('-s') + 1];
    const account = args[args.indexOf('-a') + 1];
    const at = `${service}/${account}`;
    if (args[0] === 'add-generic-password') {
      // `security` reads the value, then reads it again to confirm. Taking the
      // first line is what the real one does with the pair.
      items.set(at, (input ?? '').split('\n')[0] ?? '');
      return '';
    }
    const held = items.get(at);
    if (held === undefined) throw new Error('The specified item could not be found in the keychain.');
    return `${held}\n`;
  };
  return { run, calls, items };
}

const KEY = 'as_live_abcd1234_secretsecretsecretsecre';

/*
  EVERY CALL BELOW NAMES ITS PLATFORM, and that is the fix for a real failure
  rather than tidiness. storeFor() picks the credential store from
  process.platform, so these fakes -- which speak `security` and nothing else --
  were silently testing whichever machine ran them. On a Mac they passed. On the
  Linux runner storeFor() hands back secret-tool, the fake does not recognise
  `store` as a write, falls through to its lookup branch, and throws "The
  specified item could not be found in the keychain."

  It went unnoticed because nothing blocks a merge here, so it landed green-ish
  and surfaced at publish -- where it stopped a release, about code the release
  had not touched.
*/

describe('where an agent key is kept', () => {
  it('names the item after the agent, so two agents here are two items', () => {
    expect(apiKeyReference('u_planner')).toBe('keychain://agentsignal/u_planner');
  });

  it('escapes an agent key rather than letting it spell a second path segment', () => {
    expect(apiKeyReference('u_a/b')).toBe('keychain://agentsignal/u_a%2Fb');
  });

  it('passes the value on stdin and never in the argument list', () => {
    const keychain = workingKeychain();
    writeKeychainSync('keychain://agentsignal/u_planner', KEY, keychain.run, 'darwin');

    const [call] = keychain.calls;
    expect(call!.command).toBe('/usr/bin/security');
    // The whole point: not as an argument, not anywhere in one.
    expect(call!.args).not.toContain(KEY);
    expect(call!.args.some((argument) => argument.includes(KEY))).toBe(false);
    // Twice, because `security` asks and then asks again to confirm.
    expect(call!.input).toBe(`${KEY}\n${KEY}\n`);
  });

  it('updates an existing item and trusts the reader, so a rejoin and a restart both work', () => {
    const keychain = workingKeychain();
    writeKeychainSync('keychain://agentsignal/u_planner', KEY, keychain.run, 'darwin');

    const [call] = keychain.calls;
    // Without -U a second join fails on the duplicate and falls back to plaintext.
    expect(call!.args).toContain('-U');
    // Without -T every read prompts, and a headless agent cannot answer a prompt.
    expect(call!.args.slice(call!.args.indexOf('-T'), call!.args.indexOf('-T') + 2)).toEqual([
      '-T',
      '/usr/bin/security',
    ]);
  });

  it('trims the newline security prints, which would otherwise 401 an hour later', () => {
    const run: RunSync = () => `${KEY}\n`;
    expect(readKeychainSync('keychain://agentsignal/u_planner', run, 'darwin')).toBe(KEY);
  });

  it('refuses an empty value rather than handing back a credential of nothing', () => {
    const run: RunSync = () => '\n';
    expect(() => readKeychainSync('keychain://agentsignal/u_planner', run, 'darwin')).toThrow(
      /empty value/,
    );
  });
});

describe('proving the key comes back out', () => {
  it('returns the reference when it round-trips', () => {
    const keychain = workingKeychain();
    expect(rememberApiKey('u_planner', KEY, keychain.run, 'darwin')).toBe(
      'keychain://agentsignal/u_planner',
    );
    expect(keychain.items.get('agentsignal/u_planner')).toBe(KEY);
  });

  it('speaks secret-tool on linux, with the value still on stdin', () => {
    const calls: { command: string; args: string[]; input?: string }[] = [];
    const items = new Map<string, string>();
    const run: RunSync = (command, args, input) => {
      calls.push({ command, args, input });
      if (args[0] === 'store') {
        items.set('at', (input ?? '').split('\n')[0] ?? '');
        return '';
      }
      // lookup prints the secret with NO trailing newline, unlike security.
      return items.get('at') ?? '';
    };

    expect(rememberApiKey('u_planner', KEY, run, 'linux')).toBe(
      'keychain://agentsignal/u_planner',
    );

    const [write] = calls;
    expect(write!.command).toBe('secret-tool');
    // The same rule as macOS and for the same reason: an argument would put a
    // live channel key in ps output for every process running as this user.
    expect(write!.args.some((argument) => argument.includes(KEY))).toBe(false);
    // Once, not twice. secret-tool does not ask again to confirm, and sending
    // the second copy is a hang rather than an error.
    expect(write!.input).toBe(`${KEY}\n`);
  });

  it('keeps the plaintext when there is no keychain to write to', () => {
    const run: RunSync = () => {
      throw new Error('security: command not found');
    };
    // Null, not a throw: a machine with no keychain -- Linux, a container, CI
    // -- is a supported place to run an agent rather than a failure.
    expect(rememberApiKey('u_planner', KEY, run, 'darwin')).toBeNull();
  });

  it('keeps the plaintext when the write succeeds and the read disagrees', () => {
    // The failure this exists to catch: a keychain that accepts a write and
    // returns something else, which would otherwise be discovered at the next
    // start, by an agent that no longer has the key it threw away.
    const run: RunSync = (_command, args) =>
      args[0] === 'add-generic-password' ? '' : 'a-different-key\n';

    expect(rememberApiKey('u_planner', KEY, run, 'darwin')).toBeNull();
  });

  it('keeps the plaintext when the write succeeds and the read fails outright', () => {
    const run: RunSync = (_command, args) => {
      if (args[0] === 'add-generic-password') return '';
      throw new Error('User interaction is not allowed.');
    };

    expect(rememberApiKey('u_planner', KEY, run, 'darwin')).toBeNull();
  });
});
