import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `AGENTSIGNAL_NO_KEYCHAIN` covers the dashboard too.
 *
 * The switch exists because somebody asked to stop being prompted for keychain
 * access on every start, and it was implemented in the MCP server only. The
 * DASHBOARD -- the process restarted after every plugin update, and several
 * times an hour while anybody is working on it -- went to the keychain
 * regardless. So the setting was on, the prompts kept coming, and it read as
 * broken rather than as half-done.
 *
 * Asserted at the level that matters: what `security` is asked, not what a
 * wrapper returns. A test that mocked the lookup would pass against a version
 * that still shelled out.
 */

const STATE = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../plugins/agentsignal/scripts/state.mjs',
);

/**
 * Run one expression against the real module in a child process.
 *
 * A child rather than an import, because the switch is read from the
 * environment at call time and the point is to vary it between cases without
 * the module cache carrying an answer across.
 */
function run(expression: string, env: Record<string, string> = {}) {
  const script = mkdtempSync(join(tmpdir(), 'agentsignal-switch-'));
  const file = join(script, 'probe.mjs');
  writeFileSync(
    file,
    `import { readKeychain } from ${JSON.stringify(STATE)};\n` +
      `try { console.log(JSON.stringify({ ok: true, value: ${expression} })); }\n` +
      `catch (error) { console.log(JSON.stringify({ ok: false, error: error.message })); }\n`,
  );
  const out = execFileSync(process.execPath, [file], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env },
  });
  return JSON.parse(out.trim().split('\n').pop()!) as { ok: boolean; value?: string; error?: string };
}

describe('the keychain switch covers the dashboard', () => {
  it('refuses to look anything up when the switch is set', () => {
    const result = run(`readKeychain('keychain://agentsignal/whatever')`, {
      AGENTSIGNAL_NO_KEYCHAIN: '1',
    });

    expect(result.ok).toBe(false);
    // Names the variable, because the person reading this set it and needs to
    // know it was obeyed rather than that a lookup failed.
    expect(result.error).toMatch(/AGENTSIGNAL_NO_KEYCHAIN/);
    // And says what to do instead, since refusing without an alternative is
    // how a switch becomes something people work around.
    expect(result.error).toMatch(/AGENTSIGNAL_API_KEY/);
  });

  /**
   * Without the switch it must still go to the keychain -- an item that does
   * not exist fails with the keychain's own diagnostic, not with the refusal
   * above. Otherwise "the switch works" would also be true of a version that
   * never looked anything up at all.
   */
  it('still looks up when the switch is not set', () => {
    const result = run(`readKeychain('keychain://agentsignal/definitely-not-a-real-account')`);

    expect(result.ok).toBe(false);
    expect(result.error).not.toMatch(/AGENTSIGNAL_NO_KEYCHAIN/);
    expect(result.error).toMatch(/definitely-not-a-real-account/);
  });
});
