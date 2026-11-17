import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentSelf, AgentSignal, AgentSignalError, AgentSignalX402, WAIT_CLIENT_SLACK_MS, clientTimeoutMsForWait, waitRequestOptions } from '../src/index.js';

/**
 * The rest of the client, which `send.test.ts` does not reach.
 *
 * That file covers the four behaviours with a direct human cost -- waking
 * somebody twice, hammering an API that asked for a pause, mistaking an invoice
 * for a quota wall. This one covers the other thirty-odd methods, where the
 * failures are quieter and just as total: a DELETE sent as a POST, a slug that
 * escapes its path segment, a credential presented under the wrong scheme. None
 * of those throw in development. They 404, or they do the wrong thing to the
 * wrong record, against a live account.
 *
 * Almost everything here asserts the request rather than the response, because
 * the request is the part this package is responsible for. The API's own suite
 * owns what happens after.
 */

const RECIPIENT = 'u_8fk2AbCdEfGhIjKlMnOpQr';

/** A fetch that answers every call from `body` and records what it was asked. */
function recorder(body: unknown = { ok: true }, status = 200) {
  const calls: Array<{
    url: string;
    method: string;
    headers: Record<string, string>;
    body: any;
  }> = [];

  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  });

  return { impl: impl as unknown as typeof globalThis.fetch, calls };
}

const keyed = (fetchImpl: typeof globalThis.fetch) =>
  new AgentSignal({ apiKey: 'as_test_key', baseUrl: 'https://api.example.test', fetch: fetchImpl });

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------

describe('alerting a human', () => {
  const sent = { ok: true, id: 'm_1', receipt: 'r_1', deliveries: { total: 1, sent: 1, failed: 0, queued: 0 } };

  /**
   * An alert that is not priority 2 is an ordinary notification wearing the
   * word "alert": it arrives once, respects quiet hours, and waits politely to
   * be noticed. The whole point of the method is the opposite of that.
   */
  it('is priority 2, and repeats for an hour by default', async () => {
    const { impl, calls } = recorder(sent);

    await keyed(impl).alert({ to: RECIPIENT, body: 'production is down' });

    expect(calls[0]!.body).toMatchObject({
      priority: 2,
      retry_seconds: 60,
      expire_seconds: 3600,
    });
  });

  it('lets the caller choose a different cadence', async () => {
    const { impl, calls } = recorder(sent);

    await keyed(impl).alert({
      to: RECIPIENT,
      body: 'slower',
      retry_seconds: 300,
      expire_seconds: 1800,
    });

    expect(calls[0]!.body).toMatchObject({ priority: 2, retry_seconds: 300, expire_seconds: 1800 });
  });

  /**
   * Fails closed. `alertAndWait` is sold as `alert && deploy`, so the answer
   * when nothing can be waited on has to be "not acknowledged" -- and it has to
   * come back immediately rather than after polling a receipt that does not
   * exist.
   */
  it('reports not-acknowledged at once when no receipt was issued', async () => {
    const { impl, calls } = recorder({ ...sent, receipt: null });

    const outcome = await keyed(impl).alertAndWait({ to: RECIPIENT, body: 'unanswerable' });

    expect(outcome.acknowledged).toBe(false);
    expect(outcome.receipt).toBeNull();
    // The send, and nothing else. A poll here would be a request against a null id.
    expect(calls).toHaveLength(1);
  });
});

describe('waiting on a receipt', () => {
  /**
   * The regression this file exists to keep fixed.
   *
   * `alertAndWait` asks the server to hold the request for up to 60 seconds,
   * and the client's default timeout is 15. The client therefore aborted its
   * own wait, the abort looked transient, it retried, and the call finally
   * threw a network error about 45 seconds in -- so "nobody answered" surfaced
   * as a crash, and the CLI exited 1 where it documents 2.
   *
   * Asserted by watching what timeout the request actually asks for, which is
   * the only honest way to see it without waiting a real minute.
   */
  it('gives the request longer than the hold it just asked for', async () => {
    const timeouts: number[] = [];
    const real = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
      timeouts.push(ms);
      return real(ms);
    });

    const { impl, calls } = recorder({ ok: true, acknowledged: false, acked_at: null, waited_ms: 60_000 });

    await keyed(impl).receipt('r_1', { waitSeconds: 60 });

    expect(calls[0]!.url).toContain('?wait=60');
    expect(timeouts[0]!).toBeGreaterThan(60_000);
  });

  it('does not ask for a hold when it was not told to', async () => {
    const { impl, calls } = recorder({ ok: true, acknowledged: true, acked_at: '2026-08-09T00:00:00Z' });

    await keyed(impl).receipt('r_1');

    expect(calls[0]!.url).toBe('https://api.example.test/v1/receipts/r_1');
    expect(calls[0]!.url).not.toContain('wait');
  });
});

describe('groups', () => {
  /**
   * Verbs, because the path alone does not say what happens. `removeFromGroup`
   * and `addToGroup` differ by method on nearly the same URL, and getting that
   * backwards adds a member where it meant to drop one -- which on a group used
   * for on-call means paging somebody who took themselves off it.
   */
  it('uses the method that matches the intent', async () => {
    const { impl, calls } = recorder({ ok: true, groups: [], group: { id: 'g_1', name: 'On call', slug: 'on-call' } });
    const client = keyed(impl);

    await client.groups();
    await client.group('on-call');
    await client.createGroup('On call');
    await client.addToGroup('on-call', RECIPIENT);
    await client.removeFromGroup('on-call', RECIPIENT);
    await client.deleteGroup('on-call');

    expect(calls.map((c) => `${c.method} ${c.url.replace('https://api.example.test', '')}`)).toEqual([
      'GET /v1/groups',
      'GET /v1/groups/on-call',
      'POST /v1/groups',
      'POST /v1/groups/on-call/members',
      `DELETE /v1/groups/on-call/members/${RECIPIENT}`,
      'DELETE /v1/groups/on-call',
    ]);
  });

  /**
   * A slug is caller-supplied and goes straight into a path. Unencoded, a `/`
   * in it addresses a different endpoint than the one the caller named.
   */
  it('encodes a slug rather than letting it change the path', async () => {
    const { impl, calls } = recorder({ ok: true, group: { id: 'g_1', name: 'x', slug: 'x' } });

    await keyed(impl).deleteGroup('a/b c');

    expect(calls[0]!.url).toBe('https://api.example.test/v1/groups/a%2Fb%20c');
  });
});

describe('the keyed client elsewhere', () => {
  it('registers and reads the directory on the paths the API serves', async () => {
    const { impl, calls } = recorder({ ok: true, recipients: [] });
    const client = keyed(impl);

    await client.register({ handle: 'deploy-bot' });
    await client.directory();

    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url).toBe('https://api.example.test/v1/agents/register');
    expect(calls[1]!.method).toBe('GET');
    expect(calls[1]!.url).toBe('https://api.example.test/v1/agents');
  });

  it('refuses an invalid message locally, without spending a request', async () => {
    const { impl, calls } = recorder();

    await expect(keyed(impl).send({ to: 'not-a-key', body: 'x' } as any)).rejects.toBeInstanceOf(
      AgentSignalError,
    );
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------

describe('the paid client', () => {
  const paid = (fetchImpl: typeof globalThis.fetch, credit?: string) =>
    new AgentSignalX402({ credit, baseUrl: 'https://api.example.test', fetch: fetchImpl });

  /**
   * Opening credit is the one call that cannot present a credential, because
   * the credential is what it returns. Sending an empty or stale Authorization
   * here is how an agent with no account gets 401 on the only route designed
   * for it.
   */
  it('opens credit with no credential, then presents what it was given', async () => {
    const { impl, calls } = recorder({
      ok: true,
      credit: { token: 'as_credit_minted', free: 10, paid: 0, total: 10, expires_at: null },
    });

    const client = paid(impl);
    await client.openCredit();
    await client.balance();

    expect(calls[0]!.headers.Authorization).toBe('');
    expect(calls[1]!.headers.Authorization).toBe('Credit as_credit_minted');
  });

  /**
   * The two questions an agent asks *before* it has anything to spend: what
   * things cost, and whether this person can be reached at all. Both have to
   * work with no token, or deciding whether to open credit would itself
   * require credit.
   */
  it('prices packs and quotes a recipient with no credit token at all', async () => {
    const { impl, calls } = recorder({ ok: true, packs: [], free: { deliveries: 10 }, devices: 1 });
    const client = paid(impl);

    await client.packs();
    await client.quote(RECIPIENT);

    expect(calls.map((c) => c.url.replace('https://api.example.test', ''))).toEqual([
      '/v1/x402/packs',
      `/v1/x402/quote/${RECIPIENT}`,
    ]);
    // Nothing to present, so nothing is presented.
    expect(calls.every((c) => c.headers.Authorization === '')).toBe(true);
  });

  /**
   * Everything that spends refuses locally instead. A request that cannot
   * succeed is worth failing before it is sent, and the message names the three
   * ways to fix it rather than returning the API's 401.
   */
  it('refuses to spend without a token, without spending a request', async () => {
    const { impl, calls } = recorder({ ok: true });

    await expect(paid(impl).balance()).rejects.toMatchObject({ code: 'missing_credit' });
    await expect(paid(impl).send({ to: RECIPIENT, body: 'x' })).rejects.toMatchObject({
      code: 'missing_credit',
    });
    expect(calls).toHaveLength(0);
  });

  /**
   * free / paid / total, the three the API reports. `paid` was called
   * `remaining` until it collided with the free block on the opening call and
   * an agent reading its own balance saw zero it had not spent.
   */
  it('reports a balance as free, paid and total', async () => {
    const { impl } = recorder({ ok: true, credit: { free: 248, paid: 500, total: 748 } });

    const balance = await paid(impl, 'as_credit_held').balance();

    expect(balance).toEqual({ free: 248, paid: 500, total: 748 });
  });

  it('encodes a recipient key into the quote path', async () => {
    const { impl, calls } = recorder({ ok: true, devices: 1, costs_deliveries: 1 });

    await paid(impl, 'as_credit_held').quote('u_../../etc');

    expect(calls[0]!.url).toBe('https://api.example.test/v1/x402/quote/u_..%2F..%2Fetc');
  });
});

// ---------------------------------------------------------------------------

describe('an agent acting as itself', () => {
  const self = (fetchImpl: typeof globalThis.fetch) =>
    new AgentSelf({
      credential: 'dev_1.secret',
      baseUrl: 'https://api.example.test',
      fetch: fetchImpl,
    });

  it('will not be constructed without a credential', () => {
    const had = process.env.AGENTSIGNAL_DEVICE_SECRET;
    delete process.env.AGENTSIGNAL_DEVICE_SECRET;
    try {
      expect(() => new AgentSelf({ baseUrl: 'https://api.example.test' })).toThrow(AgentSignalError);
    } finally {
      if (had !== undefined) process.env.AGENTSIGNAL_DEVICE_SECRET = had;
    }
  });

  /**
   * `Device`, not `Bearer`. An agent credential presented as an API key is
   * refused, and the error says "invalid key" -- which sends whoever is
   * debugging it looking for a key that was never the problem.
   */
  it('authenticates as a device rather than as an API key', async () => {
    const { impl, calls } = recorder({ ok: true, messages: [] });

    await self(impl).inbox();

    expect(calls[0]!.headers.Authorization).toBe('Device dev_1.secret');
    expect(calls[0]!.url).toBe('https://api.example.test/v1/devices/me/messages');
  });

  it('answers and marks read on the delivery it was handed', async () => {
    const { impl, calls } = recorder({ ok: true });
    const agent = self(impl);

    await agent.respond('d_1', 0);
    await agent.markRead('d_1');

    expect(calls.map((c) => `${c.method} ${c.url.replace('https://api.example.test', '')}`)).toEqual([
      'POST /v1/devices/me/messages/d_1/respond',
      'POST /v1/devices/me/messages/d_1/read',
    ]);
  });

  /**
   * Three options is the ceiling everywhere else -- the schema, the push
   * payload, the buttons on the notification. Answering "4" is not a thing a
   * human could have chosen, so it is refused here rather than posted.
   */
  it('refuses an answer that was never on offer', async () => {
    const { impl, calls } = recorder({ ok: true });

    await expect(self(impl).respond('d_1', 7)).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  /**
   * Spawning is credential minting: the token this returns lets a new agent
   * become a member of a channel. Revoking it has to be a DELETE, because a POST
   * to the same path is how you would create another one.
   */
  it('mints a join token and revokes it with a DELETE', async () => {
    const { impl, calls } = recorder({
      ok: true,
      token: { id: 'jt_1', token: 'as_join_secret', name: 'worker', prefix: 'as_join_1', max_uses: 1, expires_at: '2026-09-01T00:00:00Z', label_ref: 'ops' },
      tokens: [],
    });
    const agent = self(impl);

    const minted = await agent.spawnToken('ops', { name: 'worker', maxUses: 1 });
    await agent.spawnTokens();
    await agent.revokeSpawnToken('jt_1');

    expect(minted.token).toBe('as_join_secret');
    expect(calls.map((c) => `${c.method} ${c.url.replace('https://api.example.test', '')}`)).toEqual([
      'POST /v1/channels/ops/join-tokens',
      'GET /v1/channels/join-tokens',
      'DELETE /v1/channels/join-tokens/jt_1',
    ]);
  });

  it('manages channels on the paths the API serves', async () => {
    const { impl, calls } = recorder({
      ok: true,
      channels: [],
      channel: { id: 'l_1', ref: 'ops', name: 'Ops' },
    });
    const agent = self(impl);

    await agent.channels();
    await agent.createChannel('Ops');
    await agent.addToChannel('ops', 'deploy-bot');
    await agent.removeFromChannel('ops', 'deploy-bot');

    expect(calls.map((c) => `${c.method} ${c.url.replace('https://api.example.test', '')}`)).toEqual([
      'GET /v1/channels',
      'POST /v1/channels',
      'POST /v1/channels/ops/members',
      'DELETE /v1/channels/ops/members/deploy-bot',
    ]);
  });
});

// ---------------------------------------------------------------------------
// The methods added for an agent working alone
//
// Every one of these was shipped in 0.2.0 with no test. They are thin, which
// is the danger rather than the reassurance: a wrong verb, an unescaped path
// segment or a query built by hand does not throw here. It 404s, or it acts
// on the wrong record, against a live account.
//
// So these assert the REQUEST -- what this package is actually responsible
// for. The API's own suite owns what happens after it arrives.
// ---------------------------------------------------------------------------

describe('reading the delivery log', () => {
  it('is a GET, with no body', async () => {
    const { impl, calls } = recorder({ ok: true, messages: [] });

    await keyed(impl).log();

    expect(calls[0]!.method).toBe('GET');
    expect(calls[0]!.url).toBe('https://api.example.test/v1/messages');
    expect(calls[0]!.body).toBeUndefined();
  });

  it('passes `since` and `limit` as query, url-encoded', async () => {
    const { impl, calls } = recorder({ ok: true, messages: [] });

    await keyed(impl).log({ since: '2026-08-14T12:00:00+01:00', limit: 5 });

    // The `+` in an offset is a space once it is in a query string. Encoded
    // wrong, the server reads 11:00 and the poller silently replays an hour
    // of its own history on every call.
    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get('since')).toBe('2026-08-14T12:00:00+01:00');
    expect(url.searchParams.get('limit')).toBe('5');
  });

  it('returns the array rather than the envelope', async () => {
    const { impl } = recorder({ ok: true, messages: [{ id: 'm_1' }] });

    const rows = await keyed(impl).log();

    expect(rows).toEqual([{ id: 'm_1' }]);
  });
});

describe('schedules', () => {
  const schedule = { id: 'sch_1', name: null, kind: 'once', enabled: true, next_run_at: null };

  it('lists with a GET', async () => {
    const { impl, calls } = recorder({ ok: true, schedules: [schedule] });

    const list = await keyed(impl).schedules();

    expect(calls[0]!.method).toBe('GET');
    expect(calls[0]!.url).toBe('https://api.example.test/v1/schedules');
    expect(list).toEqual([schedule]);
  });

  it('creates with a POST carrying the payload', async () => {
    const { impl, calls } = recorder({ ok: true, schedule });

    await keyed(impl).schedule({
      kind: 'once',
      timezone: 'America/New_York',
      run_at: '2026-09-01T09:00:00Z',
      payload: { to: RECIPIENT, body: 'standup' },
    });

    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.body).toMatchObject({
      kind: 'once',
      timezone: 'America/New_York',
      payload: { to: RECIPIENT, body: 'standup' },
    });
  });

  it('updates with PATCH, not POST', async () => {
    const { impl, calls } = recorder({ ok: true, schedule });

    await keyed(impl).updateSchedule('sch_1', { enabled: false });

    // A POST here would create a second schedule rather than pause the first,
    // and both answer 2xx.
    expect(calls[0]!.method).toBe('PATCH');
    expect(calls[0]!.url).toBe('https://api.example.test/v1/schedules/sch_1');
    expect(calls[0]!.body).toEqual({ enabled: false });
  });

  it('deletes with DELETE', async () => {
    const { impl, calls } = recorder({ ok: true });

    await keyed(impl).deleteSchedule('sch_1');

    expect(calls[0]!.method).toBe('DELETE');
    expect(calls[0]!.url).toBe('https://api.example.test/v1/schedules/sch_1');
  });

  it('escapes an id into its path segment', async () => {
    const { impl, calls } = recorder({ ok: true });

    await keyed(impl).deleteSchedule('sch/../../v1/channels');

    // Unescaped, that id walks out of its segment and deletes something else
    // entirely -- with a 200 to say it worked.
    expect(calls[0]!.url).toBe(
      'https://api.example.test/v1/schedules/sch%2F..%2F..%2Fv1%2Fchannels',
    );
  });

  it('previews and reads runs with GETs on the right sub-paths', async () => {
    // `runs` only. The earlier version of this test answered with BOTH keys,
    // so it passed whichever one the client read -- and the client read the
    // wrong one. A mock that agrees with the code's assumption tests the
    // assumption, not the code.
    const { impl, calls } = recorder({ ok: true, runs: ['2026-09-01T09:00:00Z'] });
    const client = keyed(impl);

    const upcoming = await client.previewSchedule('sch_1');
    expect(upcoming).toEqual(['2026-09-01T09:00:00Z']);

    await client.scheduleRuns('sch_1');

    expect(calls[0]!.method).toBe('GET');
    expect(calls[0]!.url).toBe('https://api.example.test/v1/schedules/sch_1/preview');
    expect(calls[1]!.url).toBe('https://api.example.test/v1/schedules/sch_1/runs');
  });
});

describe('reporting a problem', () => {
  it('POSTs the kind and body, and omits context when there is none', async () => {
    const { impl, calls } = recorder({ ok: true, recorded: true, id: 'f_1' });

    await keyed(impl).report('problem', 'notify_group 500s on an empty group');

    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url).toBe('https://api.example.test/v1/feedback');
    expect(calls[0]!.body).toEqual({
      kind: 'problem',
      body: 'notify_group 500s on an empty group',
    });
  });

  it('carries context when given', async () => {
    const { impl, calls } = recorder({ ok: true, recorded: true });

    await keyed(impl).report('improvement', 'let me send to several at once', {
      call: 'POST /v1/messages',
    });

    expect(calls[0]!.body.context).toEqual({ call: 'POST /v1/messages' });
  });

  it('passes `recorded: false` through rather than treating it as failure', async () => {
    const { impl } = recorder({ ok: true, recorded: false, note: 'not kept' }, 202);

    const result = await keyed(impl).report('problem', 'again');

    // A dropped report is an outcome the caller must be able to see. Throwing
    // or coercing this to true would leave a retry loop believing it filed
    // twenty distinct reports when it filed one.
    expect(result.recorded).toBe(false);
    expect(result.note).toBe('not kept');
  });
});

describe('asking a question', () => {
  it('reads answers with a GET, and no wait by default', async () => {
    const { impl, calls } = recorder({ ok: true, responses: [], options: [], tally: [] });

    await keyed(impl).responses('m_1');

    expect(calls[0]!.method).toBe('GET');
    // No `?wait=` at all rather than `?wait=0`: the route branches on the
    // query being present.
    expect(calls[0]!.url).toBe('https://api.example.test/v1/messages/m_1/responses');
  });

  it('asks the server to hold when waitSeconds is given', async () => {
    const { impl, calls } = recorder({ ok: true, responses: [], options: [], tally: [] });

    await keyed(impl).responses('m_1', { waitSeconds: 30 });

    expect(calls[0]!.url).toBe('https://api.example.test/v1/messages/m_1/responses?wait=30');
  });

  it('sends then waits, and resolves the answer to its text', async () => {
    let call = 0;
    const impl = (async () => {
      call += 1;
      return call === 1
        ? Response.json({ ok: true, id: 'm_9', receipt: null, replayed: false, deliveries: { total: 1, sent: 1, failed: 0, queued: 0 } })
        : Response.json({
            ok: true,
            message_id: 'm_9',
            options: ['Roll back', 'Hold'],
            tally: [],
            responses: [{ recipient_key: RECIPIENT, name: 'A', option_index: 1, responded_at: 'now', changed: false }],
            awaiting: 0,
          });
    }) as unknown as typeof globalThis.fetch;

    const result = await keyed(impl).ask(
      { to: RECIPIENT, body: 'Roll back, or hold?', options: ['Roll back', 'Hold'] },
      { waitSeconds: 10 },
    );

    // Index 1 read back as the word the asker wrote. An agent handed `1` has
    // to remember what it offered; this one does not.
    expect(result.answered).toBe(true);
    expect(result.answer).toBe('Hold');
    expect(result.id).toBe('m_9');
  });

  it('says nobody answered rather than inventing one', async () => {
    let call = 0;
    const impl = (async () => {
      call += 1;
      return call === 1
        ? Response.json({ ok: true, id: 'm_9', receipt: null, replayed: false, deliveries: { total: 1, sent: 1, failed: 0, queued: 0 } })
        : Response.json({ ok: true, message_id: 'm_9', options: ['a', 'b'], tally: [], responses: [], awaiting: 1, timed_out: true });
    }) as unknown as typeof globalThis.fetch;

    const result = await keyed(impl).ask(
      { to: RECIPIENT, body: 'well?', options: ['a', 'b'] },
      { waitSeconds: 5 },
    );

    expect(result.answered).toBe(false);
    expect(result.answer).toBeNull();
  });
});

describe('opening an account', () => {
  it('POSTs to signup with no credential, and hands back a client holding the key', async () => {
    const { impl, calls } = recorder({
      ok: true,
      account: { id: 'a_1', name: 'Fleet', slug: 'fleet' },
      channel: { id: 'p_1', ref: 'abcd1234', name: 'Default' },
      api_key: 'as_live_abcd1234_secretsecretsecretsecre',
      free_human_deliveries: 10,
    });

    const result = await AgentSignal.openAccount('Fleet', {
      baseUrl: 'https://api.example.test',
      fetch: impl,
    });

    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url).toBe('https://api.example.test/v1/agents/signup');
    // AND A PLACE TO SEND THE KEY. Signup is the bootstrap -- no agent, no
    // device, nothing published -- so the server can only seal the key if this
    // client brings a public half. Sending it is what keeps the value out of a
    // response body, which is what a model reads and a transcript keeps.
    expect(calls[0]!.body).toMatchObject({ name: 'Fleet' });
    expect((calls[0]!.body as { enc_public_key?: string }).enc_public_key).toMatch(
      /^[A-Za-z0-9+/]+=*$/,
    );
    // Nothing to authenticate with. That is the point of the call.
    expect(calls[0]!.headers.Authorization).toBe('');

    expect(result.key).toBe('as_live_abcd1234_secretsecretsecretsecre');
    expect(result.freeHumanDeliveries).toBe(10);
    expect(result.client).toBeInstanceOf(AgentSignal);
  });
});

/**
 * Telling the sender their message landed.
 *
 * The server has counted reads and exposed `/read` and `/delivered` since the
 * first migration, and every delivery still sat at `pending` -- "row created,
 * not yet handed to a provider" -- for the whole life of a conversation that
 * was demonstrably being read and answered. `markRead` existed in this file,
 * with a test, and no caller anywhere. Nothing was configurable; the state
 * machine past its first state was simply never driven.
 *
 * What that cost was not cosmetic. To somebody watching a channel, "pending" is
 * indistinguishable from "it never arrived", so an agent that had read four
 * messages and was working on them looked like a broken link.
 */
describe('read receipts', () => {
  const self = (fetchImpl: typeof globalThis.fetch) =>
    new AgentSelf({
      credential: 'dev_1.secret',
      baseUrl: 'https://api.example.test',
      fetch: fetchImpl,
    });

  const message = (over: Partial<Record<string, unknown>> = {}) => ({
    delivery_id: 'd_1',
    message_id: 'm_1',
    title: null,
    body: 'hello',
    priority: 0,
    options: null,
    created_at: '2026-08-17T00:00:00Z',
    read_at: null,
    encrypted: false,
    from_key: 'u_other',
    from_handle: 'other',
    from_name: null,
    ...over,
  });

  /** Just the receipts, in order, so an assertion reads like the intent. */
  const receipts = (calls: Array<{ url: string; method: string }>) =>
    calls
      .filter((c) => c.method === 'POST')
      .map((c) => c.url.replace('https://api.example.test/v1/devices/me/messages/', ''));

  it('marks what it just read as read', async () => {
    const { impl, calls } = recorder({ ok: true, messages: [message()] });

    const got = await self(impl).inbox();

    expect(got).toHaveLength(1);
    expect(receipts(calls)).toEqual(['d_1/read']);
  });

  /**
   * ⚠ The one that must never regress. `confirm_read` PURGES the content once
   * every device has read it. That is a trade a person agrees to after being
   * warned; an unattended poll must not spend somebody else's message for them.
   */
  it('never destroys an encrypted message by reading it', async () => {
    const { impl, calls } = recorder({
      ok: true,
      messages: [message({ delivery_id: 'd_enc', encrypted: true })],
    });

    await self(impl).inbox();

    expect(receipts(calls)).toEqual(['d_enc/delivered']);
    expect(receipts(calls)).not.toContain('d_enc/read');
  });

  it('leaves a message it has already read alone', async () => {
    const { impl, calls } = recorder({
      ok: true,
      messages: [message({ read_at: '2026-08-16T00:00:00Z' })],
    });

    await self(impl).inbox();

    expect(receipts(calls)).toEqual([]);
  });

  /** Fetching is not always reading: a poller that wakes something else. */
  it('sends nothing when the caller says this is not a read', async () => {
    const { impl, calls } = recorder({ ok: true, messages: [message()] });

    await self(impl).inbox({ ack: false });

    expect(receipts(calls)).toEqual([]);
  });

  /**
   * Bookkeeping must never cost the caller the job. A receipt that fails is a
   * receipt that fails; the messages were still fetched and still have to be
   * returned, or an outage in the ack path silently empties every inbox.
   */
  it('still returns the messages when the receipt fails', async () => {
    let first = true;
    const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (first) {
        first = false;
        return new Response(JSON.stringify({ ok: true, messages: [message()] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ ok: false, error: 'internal' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const got = await self(impl as unknown as typeof globalThis.fetch).inbox();

    expect(got).toHaveLength(1);
    expect(got[0]!.body).toBe('hello');
  });

  /** Answering by text looks the inbox up. That is not the agent reading it. */
  it('does not mark an inbox read as a side effect of answering', async () => {
    const { impl, calls } = recorder({
      ok: true,
      messages: [message({ delivery_id: 'd_q', options: ['yes', 'no'] })],
    });

    await self(impl).respond('d_q', 'yes');

    expect(receipts(calls)).toEqual(['d_q/respond']);
  });
});

describe('wait helpers stay in lockstep with ?wait=', () => {
  it('gives the client longer than the hold, or no timeout when there is no hold', () => {
    expect(clientTimeoutMsForWait(0)).toBeUndefined();
    expect(clientTimeoutMsForWait(60)).toBe(60_000 + WAIT_CLIENT_SLACK_MS);
    expect(waitRequestOptions(30)).toEqual({
      wait: 30,
      suffix: '?wait=30',
      timeoutMs: 30_000 + WAIT_CLIENT_SLACK_MS,
    });
    expect(waitRequestOptions()).toEqual({ wait: 0, suffix: '', timeoutMs: undefined });
  });
});
