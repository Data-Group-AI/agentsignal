import { afterEach, describe, expect, it } from 'vitest';
import {
  SHORTEST_REDACTABLE,
  forgetAll,
  guard,
  baoResolver,
  storeFor,
  rememberApiKey,
  type RunSync,
  keychainResolver,
  parseKeychain,
  redact,
  redactResult,
  redactingRegistrar,
  resolveReference,
  scopeAllows,
  type Run,
} from '../src/secrets.js';

/**
 * Resolving a reference on this machine, and never letting the value out.
 *
 * The design is in docs/design/secrets-by-reference.md. What is tested here is
 * the half that can actually go wrong quietly: a secret reaching a tool result,
 * and therefore the model's context, and therefore a transcript -- which cannot
 * be taken back once it has happened. That failure produces no error, no red
 * test and no log line, so it only exists as a defect if something asserts
 * against it.
 */

afterEach(() => forgetAll());

/**
 * A vault reference is the one that crosses machines.
 *
 * A keychain item is made by hand on each machine, so a grant naming one only
 * pays off once somebody has created it everywhere -- which is not sharing a
 * secret, it is telling several people to store the same one. This is the
 * scheme that answers "how does the other side get this without it passing
 * through a message body", which came up the day somebody was asked to send
 * their .env over the channel.
 */
describe('vault references', () => {
  const withToken = { BAO_TOKEN: 'tok', BAO_ADDR: 'https://bao.example' } as NodeJS.ProcessEnv;

  it('reads one field of one secret, by argv rather than a shell string', async () => {
    let seen: { command: string; args: string[] } | null = null;
    const run: Run = async (command, args) => {
      seen = { command, args };
      return 'the-value\n';
    };

    const value = await baoResolver(run, withToken).read('bao://kv/floatplan/supabase#SERVICE_ROLE_KEY');
    expect(value).toBe('the-value');
    expect(seen!.command).toBe('bao');
    expect(seen!.args).toEqual(['kv', 'get', '-field', 'SERVICE_ROLE_KEY', 'kv/floatplan/supabase']);
  });

  /**
   * REFUSES TO LOG IN, and says why. A resolver that could authenticate would
   * need a credential of its own, stored somewhere -- the problem a vault is
   * here to solve, arriving one layer down. Failing without naming the variable
   * would present as a permissions problem inside the vault instead.
   */
  it('refuses when there is no token, and names what is missing', async () => {
    const run: Run = async () => 'never';
    await expect(baoResolver(run, {}).read('bao://kv/a/b#c')).rejects.toThrow(/BAO_TOKEN/);
    await expect(baoResolver(run, {}).read('bao://kv/a/b#c')).rejects.toThrow(/does not log in/);
  });

  it('accepts a Vault token and calls the vault binary', async () => {
    let seen = '';
    const run: Run = async (command) => {
      seen = command;
      return 'v';
    };
    await baoResolver(run, { VAULT_TOKEN: 't', VAULT_ADDR: 'https://vault.example' }).read(
      'bao://kv/a/b#c',
    );
    expect(seen).toBe('vault');
  });

  /**
   * The field is a fragment because a KV secret holds several, and
   * `bao://kv/a/b/FIELD` cannot say whether the last part is a field or a
   * deeper path. Ambiguity in a secret reference resolves to the wrong secret.
   */
  it('refuses a reference with no field, and shows the shape', async () => {
    const run: Run = async () => 'x';
    await expect(baoResolver(run, withToken).read('bao://kv/floatplan/supabase')).rejects.toThrow(
      /bao:\/\/<mount>\/<path>#<field>/,
    );
  });

  it('keeps a path with slashes intact, and passes it as one argument', async () => {
    let seen: string[] = [];
    const run: Run = async (_c, args) => {
      seen = args;
      return 'x'.repeat(20);
    };
    await baoResolver(run, withToken).read('bao://kv/team/floatplan/prod#URL');
    expect(seen[seen.length - 1]).toBe('kv/team/floatplan/prod');
    // Same reason execFile is used everywhere here: a reference arrives from a
    // server, and a metacharacter in it must be a lookup that fails rather than
    // a command that runs.
    expect(seen.some((a) => a.includes('&&'))).toBe(false);
  });

  it('says which reference was empty rather than returning nothing', async () => {
    const run: Run = async () => '\n';
    await expect(baoResolver(run, withToken).read('bao://kv/a/b#c')).rejects.toThrow(/empty value/);
  });

  it('says to install the client when the binary is missing', async () => {
    const run: Run = async () => {
      throw new Error('spawn bao ENOENT');
    };
    await expect(baoResolver(run, withToken).read('bao://kv/a/b#c')).rejects.toThrow(/Install the OpenBao/);
  });
});

/**
 * A key at rest, on a machine that is not a Mac.
 *
 * `rememberApiKey` moves an agent's own channel key into the OS store and
 * keeps the plaintext only when that fails. On Linux it always failed --
 * /usr/bin/security does not exist -- so every Linux agent, every container
 * and every CI run kept its key in a JSON file defended by nothing but 0600.
 * Readable by every process running as that user, which on a build machine is
 * a large and unexamined set.
 *
 * The reference shape does NOT change per platform: agent.json and grants both
 * carry keychain://service/account, and making that mean different things on
 * different machines would make an identity file unportable for no gain. Only
 * the program behind it varies.
 */
describe('a credential store per platform', () => {
  it('uses secret-tool on linux, with the value on stdin', () => {
    const store = storeFor('linux')!;
    expect(store.binary).toBe('secret-tool');
    expect(store.read('agentsignal', 'u_abc')).toEqual([
      'lookup',
      'service',
      'agentsignal',
      'account',
      'u_abc',
    ]);
    // The label is what somebody sees in Seahorse or KWallet while auditing
    // their keyring, so it names the product rather than the account.
    expect(store.write('agentsignal', 'u_abc')!.args).toContain('--label=AgentSignal');
  });

  it('still uses security on macOS', () => {
    const store = storeFor('darwin')!;
    expect(store.binary).toBe('/usr/bin/security');
    expect(store.read('s', 'a')).toContain('find-generic-password');
  });

  /**
   * Windows has DPAPI and no built-in CLI that reads a secret back out --
   * cmdkey stores and will not retrieve. Saying "nothing here yet" is honest;
   * a PowerShell one-liner written by somebody with no Windows machine to test
   * it on would be a store that silently keeps the wrong thing.
   */
  it('admits it has nothing for windows rather than guessing', () => {
    expect(storeFor('win32')).toBeNull();
  });

  it('keeps the plaintext when there is no store, rather than losing the key', () => {
    // The contract rememberApiKey already had for a machine with no keychain:
    // null back, caller keeps the value in the identity file, agent still runs.
    const run: RunSync = () => {
      throw new Error('spawn secret-tool ENOENT');
    };
    expect(rememberApiKey('u_abc', 'as_live_chan_secret', run)).toBeNull();
  });
});

describe('keychain references', () => {
  it('calls security with arguments rather than a shell string', async () => {
    let seen: { command: string; args: string[] } | null = null;
    const run: Run = async (command, args) => {
      seen = { command, args };
      return 'the-value\n';
    };

    const value = await keychainResolver(run).read('keychain://deploy/token');
    expect(value).toBe('the-value');
    expect(seen!.command).toBe('/usr/bin/security');
    expect(seen!.args).toEqual([
      'find-generic-password',
      '-s',
      'deploy',
      '-a',
      'token',
      '-w',
    ]);
  });

  it('passes a reference containing shell metacharacters as one argument', async () => {
    // A reference arrives from a server. If it were ever interpolated into a
    // shell string this would run; as an argv element it is a lookup that
    // fails, which is the whole reason execFile is used instead of exec.
    let seen: string[] = [];
    const run: Run = async (_c, args) => {
      seen = args;
      return 'x'.repeat(20);
    };
    await keychainResolver(run).read('keychain://deploy/$(touch %2F&&echo)');

    const account = seen[seen.indexOf('-a') + 1]!;
    expect(account).toContain('$(touch');
    expect(seen).toHaveLength(6);
  });

  it('refuses a reference that is not one', () => {
    expect(() => parseKeychain('op://vault/item/field')).toThrow(/Not a keychain reference/);
    expect(() => parseKeychain('keychain://only-a-service')).toThrow(/Expected keychain/);
  });

  it('treats an empty result as a failure rather than an empty secret', async () => {
    const run: Run = async () => '\n';
    await expect(keychainResolver(run).read('keychain://a/b')).rejects.toThrow(/empty value/);
  });

  it('does not put the value in the error when a lookup fails', async () => {
    const run: Run = async () => {
      throw new Error('SecKeychainSearchCopyNext: The specified item could not be found.');
    };
    await expect(keychainResolver(run).read('keychain://a/b')).rejects.toThrow(/could not be found/);
  });
});

describe('a resolved value cannot reach a tool result', () => {
  it('scrubs it from text, nested content, and error messages alike', () => {
    const secret = 'as_live_notarealkey_000111222333';
    guard(secret);

    // The three shapes a value has escaped in before: a body, something nested
    // the walker has to reach, and a message built by interpolation on a path
    // nobody tests.
    const result = redactResult({
      content: [
        { type: 'text', text: `Deployed with ${secret}` },
        { type: 'resource', resource: { uri: 'x', text: `Authorization: Bearer ${secret}` } },
      ],
      structuredContent: { echoed: [secret, { deep: secret }] },
      isError: false,
    });

    const flat = JSON.stringify(result);
    expect(flat).not.toContain(secret);
    expect(flat.match(/\[secret redacted\]/g) ?? []).toHaveLength(4);
    // Everything around it survives, or the guard would be unusable.
    expect(flat).toContain('Deployed with');
    expect(flat).toContain('Authorization: Bearer');
  });

  it('leaves results alone entirely when nothing has been resolved', () => {
    const untouched = { content: [{ type: 'text', text: 'no secrets here' }] };
    expect(redactResult(untouched)).toEqual(untouched);
  });

  it('says when a value is too short to scrub instead of pretending', () => {
    // Scrubbing every occurrence of a four-character value would eat unrelated
    // words. Refusing quietly would be worse: the caller would believe the
    // result was safe.
    expect(guard('abc').redactable).toBe(false);
    expect(guard('x'.repeat(SHORTEST_REDACTABLE)).redactable).toBe(true);
    expect(redact('abc appears here')).toBe('abc appears here');
  });

  it('scrubs every occurrence, not just the first', () => {
    const secret = 'supersecretvalue';
    guard(secret);
    expect(redact(`${secret} and again ${secret}`)).toBe(
      '[secret redacted] and again [secret redacted]',
    );
  });
});

describe('resolving through the registry', () => {
  it('remembers the value so it is scrubbed from then on', async () => {
    const run: Run = async () => 'a-long-enough-secret\n';
    const { value, redactable } = await resolveReference('keychain://svc/acct', [
      keychainResolver(run),
    ]);

    // Returned to the caller -- the server needs it to use it -- and scrubbed
    // from anything that comes back out.
    expect(value).toBe('a-long-enough-secret');
    expect(redactable).toBe(true);
    expect(redactResult({ text: `token=${value}` })).toEqual({ text: 'token=[secret redacted]' });
  });

  it('names the schemes it knows when handed one it does not', async () => {
    await expect(resolveReference('op://vault/item/field', [keychainResolver()])).rejects.toThrow(
      /keychain:\/\//,
    );
  });
});

describe('scope', () => {
  it('refuses a grant from another checkout and names both sides', () => {
    const verdict = scopeAllows('/Users/x/AgentSignal', '/Users/x/Kanposer');
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      // A silent refusal is indistinguishable from a missing grant, which is
      // an afternoon of somebody's time.
      expect(verdict.reason).toContain('/Users/x/AgentSignal');
      expect(verdict.reason).toContain('/Users/x/Kanposer');
    }
  });

  it('allows a matching one, and an ungranted scope means unrestricted', () => {
    expect(scopeAllows('/repo', '/repo').ok).toBe(true);
    expect(scopeAllows(null, '/anywhere').ok).toBe(true);
  });

  it('refuses a scoped grant outside a repository rather than defaulting open', () => {
    const verdict = scopeAllows('/repo', null);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toContain('not in a repository');
  });
});

/**
 * The choke point itself.
 *
 * Every other test here proves `redactResult` works. This proves it is
 * actually CALLED -- which is the part that fails silently, because a handler
 * that was never wrapped behaves identically until the day it returns a
 * credential.
 */
describe('the registration wrapper', () => {
  it('scrubs what a registered handler returns', async () => {
    const registered: Array<(...a: unknown[]) => unknown> = [];
    const fakeRegister = ((_name: string, _config: unknown, handler: (...a: unknown[]) => unknown) => {
      registered.push(handler);
      return { name: _name };
    }) as unknown as (...args: never[]) => unknown;

    const register = redactingRegistrar(fakeRegister);
    guard('a-very-secret-token');

    (register as unknown as (...a: unknown[]) => unknown)('notify', {}, async () => ({
      content: [{ type: 'text', text: 'sent with a-very-secret-token' }],
    }));

    const result = (await registered[0]!()) as { content: { text: string }[] };
    expect(result.content[0]!.text).toBe('sent with [secret redacted]');
  });

  it('hands back a registration whose last argument is not a handler', () => {
    let called = 0;
    const fakeRegister = ((...args: unknown[]) => {
      called += 1;
      return args.length;
    }) as unknown as (...args: never[]) => unknown;

    const register = redactingRegistrar(fakeRegister);
    const returned = (register as unknown as (...a: unknown[]) => unknown)('name', { a: 1 });
    expect(called).toBe(1);
    expect(returned).toBe(2);
  });

  it('lets an error out of a handler rather than swallowing it', async () => {
    const registered: Array<(...a: unknown[]) => unknown> = [];
    const fakeRegister = ((_n: string, h: (...a: unknown[]) => unknown) => {
      registered.push(h);
    }) as unknown as (...args: never[]) => unknown;

    const register = redactingRegistrar(fakeRegister);
    (register as unknown as (...a: unknown[]) => unknown)('boom', async () => {
      throw new Error('the tool failed');
    });

    await expect(registered[0]!()).rejects.toThrow('the tool failed');
  });
});
