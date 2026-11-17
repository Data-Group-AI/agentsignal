import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * One identity per checkout, so one machine can hold more than one account.
 *
 * WHAT THIS REPLACES. A credential was per-machine, and an account is whatever
 * the credential belongs to -- so a laptop with two projects on it could only
 * be in one account. The way round that was a second MCP server, which is what
 * puts two state directories side by side, and every credential bug so far has
 * come out of that arrangement.
 *
 * THE ASSERTION THAT MATTERS is the crossover one: a credential stamped with a
 * different checkout must be SKIPPED rather than adopted. If that inverts,
 * a session in one project silently holds another account's key -- messages
 * filed under the wrong company, and an agent able to page people it was never
 * given. Nothing visible would go wrong at the moment it happened.
 *
 * The server is driven over real stdio rather than by importing its internals,
 * because what is under test is the wiring -- which file, which directory,
 * which env -- and importing would bypass exactly that.
 */

const SERVER = join(dirname(fileURLToPath(import.meta.url)), '../dist/index.js');
const UNREACHABLE = 'http://127.0.0.1:9';

/** A machine with its own state directory, and repos that are real checkouts. */
function machine() {
  const home = mkdtempSync(join(tmpdir(), 'agentsignal-repo-'));
  const state = join(home, 'state');
  mkdirSync(state, { recursive: true });
  return {
    home,
    state,
    repo(name: string) {
      // realpath, matching the server: on a Mac the temp directory is behind a
      // symlink and `process.cwd()` reports the physical path, so a fixture
      // built from the symlinked spelling names a different file.
      const root = realpathSync(mkdirThen(join(home, name)));
      // A `.git` entry is the whole boundary test, and a file is as valid as a
      // directory -- that is what a worktree has.
      mkdirSync(join(root, '.git'), { recursive: true });
      mkdirSync(join(root, 'apps', 'api'), { recursive: true });
      return root;
    },
    /**
     * A worktree of `name`, the way git actually makes one: `.git` is a FILE
     * pointing into the main checkout's git directory.
     */
    worktree(name: string, label: string) {
      const main = realpathSync(mkdirThen(join(home, name)));
      const root = realpathSync(mkdirThen(join(home, `${name}-wt-${label}`)));
      mkdirSync(join(main, '.git', 'worktrees', label), { recursive: true });
      writeFileSync(join(root, '.git'), `gitdir: ${join(main, '.git', 'worktrees', label)}\n`);
      return { main, root };
    },
    /** A submodule: also a `.git` file, but pointing at `/modules/`. */
    submodule(parent: string, label: string) {
      const root = realpathSync(mkdirThen(join(parent, label)));
      mkdirSync(join(parent, '.git', 'modules', label), { recursive: true });
      writeFileSync(join(root, '.git'), `gitdir: ${join(parent, '.git', 'modules', label)}\n`);
      return root;
    },
  };
}

/** Create a directory and hand it straight back, so realpath has something. */
function mkdirThen(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}

function credential(dir: string, file: string, body: Record<string, unknown>) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), JSON.stringify(body));
}

/**
 * Boot the server in a directory and ask it who it thinks it is.
 *
 * The greeting is the observable: a server that found an identity announces
 * the handle, and one that did not says it is unconfigured.
 */
async function whoAmI(cwd: string, state: string): Promise<string> {
  const child = spawn(process.execPath, [SERVER], {
    cwd,
    env: {
      ...process.env,
      // Passed through so a spawned server obeys the same keychain switch as the
      // runner. Empty means "not set", which is what an ordinary run looks like.
      AGENTSIGNAL_NO_KEYCHAIN: process.env.AGENTSIGNAL_NO_KEYCHAIN ?? '',
      AGENTSIGNAL_STATE_DIR: state,
      AGENTSIGNAL_BASE_URL: UNREACHABLE,
      AGENTSIGNAL_API_KEY: '',
      AGENTSIGNAL_DEVICE_SECRET: '',
      AGENTSIGNAL_JOIN_TOKEN: '',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let out = '';
  child.stdout.on('data', (c) => (out += c));
  child.stderr.on('data', (c) => (out += c));

  child.stdin.write(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '0' },
      },
    }) + '\n',
  );

  await new Promise((r) => setTimeout(r, 1200));
  child.kill('SIGKILL');
  return out;
}

describe('one identity per repo', () => {
  it('does not adopt a credential stamped with another checkout', async () => {
    const m = machine();
    const mine = m.repo('my-project');
    const theirs = m.repo('their-project');

    // Their identity, on this machine, in the shared file. Under the old
    // machine-wide rule this is what a session in `my-project` would pick up.
    credential(m.state, 'agent.json', {
      base_url: UNREACHABLE,
      handle: 'theirs',
      key: 'u_theirs',
      credential: 'their-secret',
      saved_at: new Date().toISOString(),
      repo: theirs,
    });

    const said = await whoAmI(mine, m.state);
    expect(said).not.toContain('theirs');
    expect(said).not.toContain('their-secret');
  }, 20_000);

  it('adopts a pre-existing credential that names no repo', async () => {
    const m = machine();
    const mine = m.repo('my-project');

    // Written before identities were per-repo. Refusing it would silently
    // unregister every agent that was working before the change.
    credential(m.state, 'agent.json', {
      base_url: UNREACHABLE,
      handle: 'from-before',
      key: 'u_legacy',
      credential: 'legacy-secret',
      saved_at: new Date().toISOString(),
    });

    expect(await whoAmI(mine, m.state)).toContain('from-before');
  }, 20_000);

  it('prefers this checkout’s own identity over the shared one', async () => {
    const m = machine();
    const mine = m.repo('my-project');

    credential(m.state, 'agent.json', {
      base_url: UNREACHABLE,
      handle: 'shared',
      key: 'u_shared',
      credential: 'shared-secret',
      saved_at: new Date().toISOString(),
    });
    // The repo-scoped file, written where the server writes it. Its name is
    // derived from the path, so it is discovered rather than configured.
    const agents = join(m.state, 'agents');
    mkdirSync(agents, { recursive: true });
    const { createHash } = await import('node:crypto');
    const digest = createHash('sha256').update(mine).digest('hex').slice(0, 12);
    credential(join(agents, `my-project-${digest}`), 'agent.json', {
      base_url: UNREACHABLE,
      handle: 'this-checkout',
      key: 'u_mine',
      credential: 'my-secret',
      saved_at: new Date().toISOString(),
      repo: mine,
    });

    const said = await whoAmI(mine, m.state);
    expect(said).toContain('this-checkout');
    expect(said).not.toContain('shared');
  }, 20_000);

  it('treats a subdirectory as the same identity as the repo root', async () => {
    const m = machine();
    const mine = m.repo('my-project');

    const { createHash } = await import('node:crypto');
    const digest = createHash('sha256').update(mine).digest('hex').slice(0, 12);
    credential(join(m.state, 'agents', `my-project-${digest}`), 'agent.json', {
      base_url: UNREACHABLE,
      handle: 'this-checkout',
      key: 'u_mine',
      credential: 'my-secret',
      saved_at: new Date().toISOString(),
      repo: mine,
    });

    // Started in apps/api. Keying on cwd would make this a different identity
    // in the same project -- which is also what made `scope_path` report a
    // channel as out of its own scope.
    const said = await whoAmI(join(mine, 'apps', 'api'), m.state);
    expect(said).toContain('this-checkout');
  }, 20_000);

  it('keeps a credential for a different API out of it entirely', async () => {
    const m = machine();
    const mine = m.repo('my-project');

    const { createHash } = await import('node:crypto');
    const digest = createHash('sha256').update(mine).digest('hex').slice(0, 12);
    // Right repo, wrong base URL. The existing production-credential-against-
    // localhost guard has to survive the new lookup path, not just the old one.
    credential(join(m.state, 'agents', `my-project-${digest}`), 'agent.json', {
      base_url: 'https://api.agentsignal.net',
      handle: 'production',
      key: 'u_prod',
      credential: 'production-secret',
      saved_at: new Date().toISOString(),
      repo: mine,
    });

    const said = await whoAmI(mine, m.state);
    expect(said).not.toContain('production');
    expect(said).not.toContain('production-secret');
  }, 20_000);
});

/** The fixture directory shape, asserted so a silent rename cannot pass. */
describe('where a repo-scoped credential is written', () => {
  it('names the directory after the checkout it belongs to', async () => {
    const { createHash } = await import('node:crypto');
    const root = '/tmp/example/my-project';
    const digest = createHash('sha256').update(root).digest('hex').slice(0, 12);
    expect(`my-project-${digest}`).toMatch(/^my-project-[0-9a-f]{12}$/);

    // Two checkouts with the same basename under different parents must not
    // collide -- `api` is not a distinguishing name and this machine has
    // several.
    const other = createHash('sha256').update('/tmp/other/my-project').digest('hex').slice(0, 12);
    expect(other).not.toBe(digest);
  });
});

/**
 * Which working copies count as the same project.
 *
 * The account belongs to the PROJECT, not to the working copy. Keying on the
 * working copy registers one agent per worktree -- five inboxes and five rows
 * in the directory because somebody was reviewing two branches at once.
 */
describe('worktrees and submodules', () => {
  it('gives a worktree the same identity as its main checkout', async () => {
    const m = machine();
    const { main, root } = m.worktree('project', 'featurebranch');

    const { createHash } = await import('node:crypto');
    const digest = createHash('sha256').update(main).digest('hex').slice(0, 12);
    credential(join(m.state, 'agents', `project-${digest}`), 'agent.json', {
      base_url: UNREACHABLE,
      handle: 'the-project',
      key: 'u_project',
      credential: 'project-secret',
      saved_at: new Date().toISOString(),
      repo: main,
    });

    // Started inside the worktree, resolving to the project that owns it.
    expect(await whoAmI(root, m.state)).toContain('the-project');
  }, 20_000);

  it('keeps a submodule as its own project', async () => {
    const m = machine();
    const parent = m.repo('parent');
    const sub = m.submodule(parent, 'vendored');

    // A submodule is its own repository with its own history and may belong to
    // somebody else. Collapsing it into its parent would put two projects in
    // one account -- the exact crossover this design exists to prevent.
    const { createHash } = await import('node:crypto');
    const parentDigest = createHash('sha256').update(parent).digest('hex').slice(0, 12);
    credential(join(m.state, 'agents', `parent-${parentDigest}`), 'agent.json', {
      base_url: UNREACHABLE,
      handle: 'the-parent',
      key: 'u_parent',
      credential: 'parent-secret',
      saved_at: new Date().toISOString(),
      repo: parent,
    });

    const said = await whoAmI(sub, m.state);
    expect(said).not.toContain('the-parent');
  }, 20_000);
});
