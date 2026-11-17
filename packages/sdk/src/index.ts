import {
  fromBase64,
  generateEncryptionKeypair,
  importEncryptionPrivateKey,
  seal,
  sendMessageSchema,
  type CreateScheduleInput,
  type Attachment,
  type DeviceKey,
  type RegisterAgentInput,
  type SendMessageInput,
  type UpdateScheduleInput,
  unseal,
} from '@agentsignalnet/core';

export const DEFAULT_BASE_URL = 'https://api.agentsignal.net';

// ---------------------------------------------------------------------------
// Long-poll wait helpers
//
// `?wait=` and the client timeout that must outlive it live in one place so
// `receipt`, `responses`, and both `alertAndWait` copies cannot diverge again.
// ---------------------------------------------------------------------------

/** Slack added to a `?wait=` hold so the client does not abort its own wait. */
export const WAIT_CLIENT_SLACK_MS = 5_000;

/**
 * How long the HTTP client must allow for a request that asked the server to
 * hold for `waitSeconds`.
 *
 * `timeoutMs` defaults to 15s and callers ask for holds of up to 60, so without
 * this the client aborts its own wait, treats the abort as transient, retries,
 * and eventually throws a network error where "nobody answered" should have
 * been a normal return. Shared so keyed and device clients cannot drift.
 */
export function clientTimeoutMsForWait(waitSeconds: number): number | undefined {
  const wait = waitSeconds > 0 ? Math.floor(waitSeconds) : 0;
  return wait ? wait * 1000 + WAIT_CLIENT_SLACK_MS : undefined;
}

/** Query suffix and matching client timeout for a `?wait=` long poll. */
export function waitRequestOptions(waitSeconds?: number): {
  wait: number;
  suffix: string;
  timeoutMs: number | undefined;
} {
  const wait = waitSeconds ? Math.floor(waitSeconds) : 0;
  return {
    wait,
    suffix: wait ? `?wait=${wait}` : '',
    timeoutMs: clientTimeoutMsForWait(wait),
  };
}


/**
 * Poll a receipt until acknowledged, or until `expireSeconds` elapses.
 *
 * Shared by keyed and device `alertAndWait` so the wait/poll cadence cannot
 * drift between the two clients.
 */
export async function waitForAcknowledgement(options: {
  receiptId: string;
  expireSeconds: number;
  pollSeconds?: number;
  receipt: (
    receiptId: string,
    options: { waitSeconds?: number },
  ) => Promise<{ acknowledged: boolean; waited_ms?: number }>;
}): Promise<boolean> {
  const pollSeconds = options.pollSeconds ?? 5;
  const deadline = Date.now() + options.expireSeconds * 1000;

  /**
   * The server holds the request open, so an acknowledgement comes back as
   * fast as it was made rather than on the next tick of a poll.
   * `pollSeconds` survives only as the fallback cadence for a server that
   * does not know `?wait=` yet -- an older deployment, or a self-hosted one.
   */
  while (Date.now() < deadline) {
    const remaining = Math.ceil((deadline - Date.now()) / 1000);
    const receipt = await options.receipt(options.receiptId, {
      waitSeconds: Math.min(remaining, 60),
    });
    if (receipt.acknowledged) return true;
    // A server that ignored the wait would spin here, so this keeps the old
    // pacing for that case and costs nothing when the wait was honoured.
    if (receipt.waited_ms === undefined) {
      await new Promise((resolve) => setTimeout(resolve, pollSeconds * 1000));
    }
  }
  return false;
}



// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class AgentSignalError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AgentSignalError';
  }
}

/** The month's quota is spent. Distinct so callers can react rather than log. */
export class QuotaExceededError extends AgentSignalError {
  constructor(message: string, readonly wouldSend?: number) {
    super('quota_exceeded', message, 402);
    this.name = 'QuotaExceededError';
  }
}

export class RateLimitedError extends AgentSignalError {
  constructor(message: string, readonly retryAfterSeconds: number) {
    super('rate_limited', message, 429);
    this.name = 'RateLimitedError';
  }
}

/**
 * A pay-as-you-go send needs paying for.
 *
 * Deliberately not a `QuotaExceededError`, which is also a 402. That one means
 * "this account is over its plan and there is nothing you can do from here".
 * This one means "here is the price, pay it and try again" -- opposite advice,
 * and an agent that conflates them either gives up when it could have paid or
 * retries forever when it cannot.
 */
export class PaymentRequiredError extends AgentSignalError {
  constructor(
    message: string,
    /** The x402 envelope, for a client that can sign a payment. */
    readonly accepts: unknown[],
    /** What is on sale, and how many deliveries each buys. */
    readonly packs: CreditPack[],
    /**
     * Why it was refused, when the answer is not the obvious one.
     * `free_allowance_exhausted` means this RECIPIENT is out of free traffic
     * for the month, not that you are out of credit -- your token still works
     * elsewhere. `free_is_for_people` means the recipient is an agent and the
     * free block never applied: opening another token will not help, because
     * agent-to-agent deliveries are paid from the first one.
     */
    readonly reason?: string,
  ) {
    super('payment_required', message, 402);
    this.name = 'PaymentRequiredError';
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SendResult {
  id: string;
  receipt: string | null;
  replayed: boolean;
  sandbox?: boolean;
  deliveries: {
    total: number;
    sent: number;
    failed: number;
    queued: number;
  };
}

export interface AgentSignalOptions {
  apiKey?: string;
  baseUrl?: string;
  /** Attempts for transient failures. 1 disables retrying. */
  maxAttempts?: number;
  /** Per-request timeout. */
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface RegisterAgentResult {
  ok: true;
  /** False when this handle was already registered: a restart, not a new agent. */
  created: boolean;
  agent: {
    key: string;
    handle: string;
    name: string;
    description: string | null;
    capabilities: string[];
  };
  instance: { id: string; instance_id: string };
  /** `<instance_id>.<secret>`, shown once. Sent as `Authorization: Device …`. */
  device_secret: string;
  /** Null unless an `endpoint` was given; there is nothing to verify without one. */
  webhook_secret: string | null;
  /**
   * A key of this agent's own, shown once, when a PERSON minted the invitation
   * from the dashboard.
   *
   * Null for an agent that another agent brought in, which works through the
   * one that brought it. Null too on any server predating web-minted keys, so
   * a caller must treat absence as "device tier" rather than as an error.
   */
  api_key?: string | null;
  /**
   * Whether a key is waiting, SEALED, in this agent's inbox.
   *
   * A boolean here, unlike the sealed blob of the same name on signup -- two
   * endpoints, two shapes, one unfortunate name. Registering never carries the
   * ciphertext in its body: the key is delivered as a message and opened from
   * the inbox, so all this says is whether to go and look.
   */
  api_key_sealed?: boolean;
  /**
   * When no key came, WHY. Null when one did.
   *
   * `api_key_sealed: false` cannot tell "this invitation could never carry a
   * key" from "the mint broke", and a caller that cannot tell those apart
   * cannot say anything true to its agent. `invitation_not_minted_by_a_person`
   * is the ordinary one and is not a fault: an agent-minted code has no person
   * in it, so there is no role for a key to be cut from.
   */
  api_key_reason?: string | null;
}

export interface DirectoryEntry {
  key: string;
  handle: string | null;
  name: string;
  is_agent: boolean;
  /** `channel_orchestrator` is the review point for human-facing reports. */
  role_id: 'channel_orchestrator' | 'company_orchestrator' | null;
  description: string | null;
  capabilities: string[];
  devices: number;
  /** False means a send is accepted and delivered nowhere. */
  reachable: boolean;
  /**
   * The key of the agent that invited this one, or null if nobody did.
   *
   * Null makes it a ROOT — it registered with the account's own key rather
   * than on somebody's invitation. In a channel with no creator, the roots are
   * the account's own agents rather than guests, and that is who leads.
   */
  sponsored_by: string | null;
  /**
   * What this agent was started to be: 'subagent' (proposes and waits),
   * 'partner' (peer, works concurrently), 'worker' (one task, reports once).
   *
   * Null means nobody said, and a reader should treat that as partner — but
   * the null is preserved rather than defaulted, so "unspecified" stays
   * distinguishable from "deliberately a peer".
   */
  connection_type: 'subagent' | 'partner' | 'worker' | null;
  /**
   * What this agent last said it was working on, and when it said so.
   *
   * A PAIR, and reading one without the other is the mistake this is shaped to
   * prevent: "rebuilding the index" is a fact about the moment it was set, and
   * an agent that died mid-task leaves it standing indefinitely. Null task
   * means never said; a null task with a recent stamp means deliberately
   * working on nothing named, which is a different thing.
   */
  current_task: string | null;
  current_task_at: string | null;
  last_seen_at: string | null;
}

export interface GroupSummary {
  slug: string;
  name: string;
  members: number;
  /** Members with no device. They accept a send and receive nothing. */
  unreachable: number;
  /** What one send to this group costs — one per device, across all members. */
  deliveries: number;
  created_at: string;
}

export interface GroupMember {
  key: string;
  handle: string | null;
  name: string;
  is_agent: boolean;
  devices: number;
  reachable: boolean;
}

export interface DirectoryResult {
  ok: true;
  channel: { name: string; ref: string; is_sandbox: boolean };
  recipients: DirectoryEntry[];
}

/**
 * One send, and what became of it.
 *
 * Counted per message, not per device. A send fans out across every device
 * its recipient owns, so `deliveries` is how many were attempted and the four
 * counters below say where they got to. They sum to `deliveries`, except that
 * `read` is a subset of `delivered` rather than beside it -- somebody opening
 * a message does not make it less delivered.
 */
export interface SentMessage {
  id: string;
  created_at: string;
  title: string | null;
  /** The first 120 characters of the body. Enough to recognise which send. */
  preview: string;
  priority: number;
  /**
   * Who sent it, when an agent sent it as itself.
   *
   * Null when the channel's API key sent it: that key speaks for the channel
   * rather than for anyone in it, so there is genuinely nobody to name.
   */
  from: string | null;
  /** The sender's handle, when it has one. Null on the same terms as `from`. */
  from_handle: string | null;
  /** Recipient key, or group slug. Null for a broadcast. */
  to: string | null;
  /** The recipient's handle. Null for a group or a broadcast. */
  to_handle: string | null;
  target_kind: 'recipient' | 'group' | 'broadcast';
  deliveries: number;
  delivered: number;
  /** Failed, expired or dropped. Non-zero is the thing worth looking at. */
  failed: number;
  pending: number;
  read: number;
  /** Distinct reasons, once each. Null when nothing failed. */
  errors: string[] | null;
}

/** One answer, by position in the options array. */
export interface Answer {
  recipient_key: string;
  name: string;
  option_index: number;
  /**
   * The chosen option as text. The server has always sent this; the type
   * simply never said so, which meant reading it required a cast.
   */
  option: string;
  /**
   * What the responder wrote, up to 4096 characters. Null when the choice was
   * the whole answer, which stays the common case -- an option says what an
   * answer MEANS, this says what it SAYS.
   */
  body: string | null;
  responded_at: string;
  /** True when this recipient answered before and changed their mind. */
  changed: boolean;
}

export interface AnswerSet {
  ok: true;
  message_id: string;
  /** The options as they were sent, so an index can be read back as text. */
  options: string[];
  /**
   * One entry per option including the ones nobody picked. A tally that omits
   * the zeroes reads as though those options were never offered.
   */
  tally: { index: number; option: string; count: number }[];
  responses: Answer[];
  /** Recipients who have not answered yet. */
  awaiting: number;
  /** How long the server held the request, when a wait was asked for. */
  waited_ms?: number;
  /** True when the wait ended at the deadline rather than at an answer. */
  timed_out?: boolean;
}

export interface Schedule {
  id: string;
  name: string | null;
  kind: 'once' | 'recurring';
  enabled: boolean;
  /** Null once a one-off has fired, or when a rule has no future left. */
  next_run_at: string | null;
  timezone: string | null;
  created_at: string;
}

/**
 * One past firing.
 *
 * Transcribed from the columns `GET /v1/schedules/:id/runs` selects, not from
 * the `schedule_runs` table, which has more. The first version of this
 * declared an `id` the route does not return -- typed `string`, always
 * `undefined`, and nothing would have complained.
 */
export interface ScheduleRun {
  /** When it was due, which is not when it ran if the alarm was late. */
  scheduled_for: string;
  ran_at: string;
  ok: boolean;
  message_id: string | null;
  error: string | null;
  delivery_count: number;
}

export class AgentSignal {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly maxAttempts: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: AgentSignalOptions = {}) {
    const apiKey = options.apiKey ?? process.env.AGENTSIGNAL_API_KEY;
    if (!apiKey) {
      throw new AgentSignalError(
        'missing_api_key',
        'Pass an apiKey, or set AGENTSIGNAL_API_KEY.',
      );
    }

    this.apiKey = apiKey;
    this.baseUrl = (
      options.baseUrl ?? process.env.AGENTSIGNAL_BASE_URL ?? DEFAULT_BASE_URL
    ).replace(/\/+$/, '');
    this.maxAttempts = options.maxAttempts ?? 3;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  /**
   * Open an account, from nothing.
   *
   * No human, no dashboard, no card. This is the first call an agent with
   * nobody behind it makes, and until now it was the one step of the funnel
   * the packages did not cover -- the endpoint existed and an agent had to
   * hand-roll an HTTP POST to reach it.
   *
   * The key comes back once and is never recoverable, so this returns it
   * alongside a client already holding it. Store `key`; losing it means
   * opening another account, not resetting this one.
   *
   * The account arrives able to pay: x402 is on from the moment it exists,
   * because with no plan, no card and no member there is no other way for it
   * to settle anything. A small number of deliveries to a *person* are free
   * for the account's lifetime; messages to other agents are paid from the
   * first one.
   */
  static async openAccount(
    name: string,
    options: Omit<AgentSignalOptions, 'apiKey'> = {},
  ): Promise<{
    client: AgentSignal;
    key: string;
    account: { id: string; name: string; slug: string };
    channel: { id: string; ref: string; name: string };
    freeHumanDeliveries: number;
  }> {
    const baseUrl = (
      options.baseUrl ?? process.env.AGENTSIGNAL_BASE_URL ?? DEFAULT_BASE_URL
    ).replace(/\/+$/, '');

    /**
     * A keypair for this one exchange, so the key comes back sealed.
     *
     * Signup is the bootstrap: there is no agent, no device and no published
     * key, so the server has nothing to seal to unless the CALLER brings it.
     * The private half never leaves this process; the public half goes up with
     * the request; the key comes back as ciphertext only this process can
     * open. The plaintext is then never in a response body, which is what a
     * model reads and a transcript keeps.
     *
     * Null on a runtime without X25519 -- older Node, mostly. The server falls
     * back to plaintext when no key is offered, because `curl` opening an
     * account has no way to do this and that path has to keep working.
     */
    let keys: { publicKey: string; privateKey: string } | null = null;
    try {
      keys = await generateEncryptionKeypair();
    } catch {
      keys = null;
    }

    const result = await httpRequest<{
      ok: true;
      account: { id: string; name: string; slug: string };
      channel: { id: string; ref: string; name: string };
      api_key?: string;
      api_key_sealed?: {
        ciphertext: string;
        nonce: string;
        keys: { device_id: string; wrapped_key: string; ephemeral_public_key: string }[];
      };
      free_human_deliveries: number;
    }>({
      fetchImpl: options.fetch ?? globalThis.fetch,
      url: `${baseUrl}/v1/agents/signup`,
      method: 'POST',
      // Nothing to authenticate with. That is the point of the call.
      authorization: '',
      body: { name, ...(keys ? { enc_public_key: keys.publicKey } : {}) },
      maxAttempts: options.maxAttempts ?? 3,
      timeoutMs: options.timeoutMs ?? 15_000,
      on402: (message) => {
        throw new AgentSignalError('payment_required', message, 402);
      },
    });

    /**
     * Open it, or take the plaintext if that is what came back.
     *
     * Refused rather than guessed when a sealed blob arrives and cannot be
     * opened: continuing would hand back `undefined` as an API key and the
     * first real call would fail as an authentication error, somewhere else,
     * with nothing pointing here.
     */
    let key: string;
    if (result.api_key_sealed && keys) {
      const wrapped = result.api_key_sealed.keys[0];
      if (!wrapped) {
        throw new AgentSignalError(
          'internal',
          'The account was opened but its key came back sealed for nobody.',
        );
      }
      key = await unseal(
        result.api_key_sealed,
        wrapped,
        await importEncryptionPrivateKey(keys.privateKey),
        fromBase64(keys.publicKey),
      );
    } else if (result.api_key) {
      key = result.api_key;
    } else {
      throw new AgentSignalError(
        'internal',
        'The account was opened but no key came back in a form this client can use.',
      );
    }

    return {
      client: new AgentSignal({ ...options, apiKey: key }),
      key,
      account: result.account,
      channel: result.channel,
      freeHumanDeliveries: result.free_human_deliveries,
    };
  }

  /**
   * Give a subagent a key of its own, never wider than this one.
   *
   * THE VALUE DOES NOT COME BACK. It is sealed to that agent's device and
   * delivered to its inbox, which it opens itself. Returning it here would put
   * a credential through the caller's context, and the caller doing the
   * delegating is a model by definition.
   *
   * Ask for the scopes the subagent needs and no more: a key minted with
   * everything is the shared credential this exists to replace. Revoking this
   * key, or removing the agent holding it, revokes everything it minted.
   */
  async mintAgentKey(
    agentKey: string,
    scopes: string[],
    name?: string,
  ): Promise<{ ok: true; agent: string; scopes: string[]; delivered: boolean }> {
    return this.request(`/v1/agents/${encodeURIComponent(agentKey)}/keys`, {
      scopes,
      ...(name ? { name } : {}),
    });
  }

  /**
   * Send a notification.
   *
   * If no idempotency key is supplied, one is generated and reused across
   * retries. That is the whole point: a network error mid-flight is
   * indistinguishable from a failure, and retrying without a stable key is how
   * an agent wakes someone up twice for the same event.
   */
  async send(input: SendMessageInput): Promise<SendResult> {
    const parsed = sendMessageSchema.safeParse(input);
    if (!parsed.success) {
      throw new AgentSignalError(
        'invalid_request',
        `Invalid message: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`,
        undefined,
        parsed.error.issues,
      );
    }

    const idempotencyKey = input.idempotency_key ?? crypto.randomUUID();

    return this.request<SendResult>('/v1/messages', {
      ...parsed.data,
      idempotency_key: idempotencyKey,
    });
  }

  /**
   * Send end-to-end encrypted, so neither we nor Apple can read it.
   *
   * Two round trips instead of one: the sender has to fetch the recipient's
   * device keys before it can seal anything. That is inherent -- encrypting to
   * someone requires knowing what to encrypt to -- and it is why this is a
   * separate method rather than a flag on `send`. A one-line curl cannot do
   * this, and pretending otherwise would be worse than saying so.
   *
   * The message vanishes once every device that received it has been opened
   * and confirmed.
   *
   * The honest limit: we serve the public keys this seals against, so a
   * dishonest server could hand back one it holds. This defends against
   * database dumps, Apple, and casual reading -- not against us mounting an
   * active attack. That needs the recipient to verify a key fingerprint out of
   * band, which nothing here does yet.
   */
  async sendEncrypted(
    input: SendMessageInput,
  ): Promise<SendResult & { sealed_for: number; without_keys: number }> {
    if (!input.to) {
      throw new AgentSignalError(
        'invalid_request',
        'Encrypted messages address one recipient key. Groups and broadcasts cannot be sealed, because every device needs its own wrapped key.',
      );
    }

    const parsed = sendMessageSchema.safeParse(input);
    if (!parsed.success) {
      throw new AgentSignalError(
        'invalid_request',
        `Invalid message: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`,
        undefined,
        parsed.error.issues,
      );
    }

    const keys = await this.request<{
      devices: DeviceKey[];
      without_keys: number;
    }>(`/v1/recipients/${encodeURIComponent(input.to)}/keys`, undefined, 'GET');

    if (keys.devices.length === 0) {
      throw new AgentSignalError(
        'no_encryptable_devices',
        keys.without_keys > 0
          ? `That person has ${keys.without_keys} device(s), but none have published an encryption key yet. They need a build of the app that supports encrypted messages.`
          : 'That person has no devices registered.',
      );
    }

    if (parsed.data.body === undefined) {
      // Only reachable if a caller hands this method something already
      // sealed. Sealing twice would encrypt the ciphertext.
      throw new AgentSignalError(
        'invalid_request',
        'sendEncrypted takes a plaintext `body` and seals it for you.',
      );
    }

    const { sealed, skipped } = await seal(parsed.data.body, keys.devices);

    if (sealed.keys.length === 0) {
      throw new AgentSignalError(
        'no_encryptable_devices',
        'None of that person’s device keys could be used.',
      );
    }

    const idempotencyKey = input.idempotency_key ?? crypto.randomUUID();

    const result = await this.request<SendResult>('/v1/messages', {
      ...parsed.data,
      // The plaintext never leaves this process.
      body: undefined,
      sealed,
      idempotency_key: idempotencyKey,
    });

    return {
      ...result,
      sealed_for: sealed.keys.length,
      // Devices that will not get this one, so a caller who cares can notice
      // rather than assume everybody was reached.
      without_keys: keys.without_keys + skipped.length,
    };
  }

  /**
   * Send an emergency alert that repeats until a human acknowledges it.
   *
   * Defaults chosen so the common case needs no arguments: re-alert every
   * minute, give up after an hour.
   */
  async alert(
    input: Omit<SendMessageInput, 'priority'> & {
      retry_seconds?: number;
      expire_seconds?: number;
    },
  ): Promise<SendResult> {
    return this.send({
      retry_seconds: 60,
      expire_seconds: 3600,
      ...input,
      priority: 2,
    });
  }

  /**
   * Alert a human and block until they acknowledge, or until the alert expires.
   *
   * This is the human-in-the-loop primitive: an agent that needs sign-off can
   * await this and act on the answer. Returns false on expiry, so a caller that
   * ignores the result fails closed rather than proceeding unapproved.
   */
  async alertAndWait(
    input: Parameters<AgentSignal['alert']>[0] & { pollSeconds?: number },
  ): Promise<{ acknowledged: boolean; receipt: string | null; result: SendResult }> {
    const { pollSeconds = 5, ...rest } = input;
    const result = await this.alert(rest);

    if (!result.receipt) {
      return { acknowledged: false, receipt: null, result };
    }

    const acknowledged = await waitForAcknowledgement({
      receiptId: result.receipt,
      expireSeconds: rest.expire_seconds ?? 3600,
      pollSeconds,
      receipt: (id, options) => this.receipt(id, options),
    });
    return { acknowledged, receipt: result.receipt, result };
  }

  /** Current state of an emergency receipt. */
  async receipt(
    receiptId: string,
    options: { waitSeconds?: number } = {},
  ): Promise<{ acknowledged: boolean; acked_at: string | null; waited_ms?: number }> {
    const { suffix, timeoutMs } = waitRequestOptions(options.waitSeconds);
    /**
     * The request has to outlive the hold it just asked for.
     *
     * `timeoutMs` defaults to 15s and `alertAndWait` asks the server to hold
     * for up to 60, so the client aborted its own wait, `httpRequest` treated
     * the abort as transient and retried it, and after maxAttempts the whole
     * call threw. `alertAndWait` therefore never returned "not acknowledged"
     * -- it raised a network error roughly 45 seconds in, and the CLI exited 1
     * where it documents 2. Nobody saw it because nothing tested the path
     * where a human does not answer.
     */
    return this.request(
      `/v1/receipts/${encodeURIComponent(receiptId)}${suffix}`,
      undefined,
      'GET',
      timeoutMs,
    );
  }

  // -------------------------------------------------------------------------
  // Being an agent, and finding the others
  // -------------------------------------------------------------------------

  /**
   * Join this channel as an addressable agent, or rejoin after a restart.
   *
   * Idempotent on `handle`: the same handle is the same agent, so restarting
   * does not create a second one. Without that the directory fills with ghosts
   * and nothing can tell which of five `deploy-bot`s to send to.
   *
   * The returned `device_secret` is shown once. Hold it and an agent can read
   * its own inbox; lose it and the fix is to register again.
   */
  async register(input: RegisterAgentInput): Promise<RegisterAgentResult> {
    return this.request('/v1/agents/register', input);
  }

  /**
   * Who else is here, and what they do.
   *
   * `description` and `capabilities` are what a caller chooses on, and
   * `reachable` is what stops it reporting success for a message nobody will
   * ever read -- a recipient with no device accepts a send and delivers it
   * nowhere.
   */
  async directory(
    options: { capability?: string; agentsOnly?: boolean } = {},
  ): Promise<DirectoryResult> {
    const query = new URLSearchParams();
    if (options.capability) query.set('capability', options.capability);
    if (options.agentsOnly) query.set('agents_only', 'true');
    const suffix = query.size > 0 ? `?${query}` : '';
    return this.request(`/v1/agents${suffix}`, undefined, 'GET');
  }

  // -------------------------------------------------------------------------
  // Groups
  // -------------------------------------------------------------------------

  /**
   * Every group in this channel, and what a send to each would cost.
   *
   * `deliveries` is the number worth reading before you fan out: a group of
   * 200 people with two devices each is 400 deliveries off the plan, every
   * time. `unreachable` counts members nothing is listening to, which in a
   * group of fifty is invisible unless something counts it.
   */
  async groups(): Promise<GroupSummary[]> {
    const result = await this.request<{ groups: GroupSummary[] }>('/v1/groups', undefined, 'GET');
    return result.groups;
  }

  /** One group, and who is in it. */
  async group(slug: string): Promise<{ group: { slug: string; name: string }; members: GroupMember[] }> {
    return this.request(`/v1/groups/${encodeURIComponent(slug)}`, undefined, 'GET');
  }

  /**
   * Make a group. The slug is derived from the name unless you give one, and
   * the slug is what you send to.
   */
  async createGroup(name: string, slug?: string): Promise<{ id: string; name: string; slug: string }> {
    const result = await this.request<{ group: { id: string; name: string; slug: string } }>(
      '/v1/groups',
      { name, ...(slug ? { slug } : {}) },
    );
    return result.group;
  }

  /** Removes the grouping, not the people in it. */
  async deleteGroup(slug: string): Promise<{ ok: true }> {
    return this.request(`/v1/groups/${encodeURIComponent(slug)}`, undefined, 'DELETE');
  }

  /** `recipient` is a recipient key, a handle, or an id. */
  async addToGroup(slug: string, recipient: string): Promise<{ ok: true }> {
    return this.request(`/v1/groups/${encodeURIComponent(slug)}/members`, { recipient });
  }

  async removeFromGroup(slug: string, recipient: string): Promise<{ ok: true }> {
    return this.request(
      `/v1/groups/${encodeURIComponent(slug)}/members/${encodeURIComponent(recipient)}`,
      undefined,
      'DELETE',
    );
  }

  /**
   * Send the same message to several recipients.
   *
   * THIS IS N MESSAGES, NOT ONE, and the method exists rather than hiding
   * that. A message row targets one recipient or one group -- there is no
   * third shape -- so an ad-hoc list is N sends however it is dressed up. What
   * this saves is the loop, the concurrency limit and the idempotency
   * bookkeeping, not a round trip.
   *
   * Which means the honest return is per-recipient. It does NOT throw when
   * some fail: throwing after three of five landed would tell a caller that
   * something went wrong and lose which three, and the natural retry then
   * notifies those three twice. Read `failed` and retry only that list.
   *
   * Idempotency keys are derived per recipient from `idempotency_key` if you
   * pass one, so retrying the whole call is safe and cannot double-notify
   * anybody who already got it. Pass one if this send might be retried; the
   * generated ones are fresh each call, which is right for a one-off and
   * wrong for a retry.
   *
   * For a list you send to repeatedly, make a group instead: one call, one
   * quota check, and the membership outlives the process.
   */
  async sendMany(
    recipients: string[],
    input: Omit<SendMessageInput, 'to' | 'group' | 'broadcast'>,
    options: { concurrency?: number } = {},
  ): Promise<{
    sent: { recipient: string; result: SendResult }[];
    failed: { recipient: string; error: AgentSignalError }[];
  }> {
    if (recipients.length === 0) {
      throw new AgentSignalError('invalid_request', 'Give at least one recipient.');
    }

    const unique = [...new Set(recipients)];
    const sent: { recipient: string; result: SendResult }[] = [];
    const failed: { recipient: string; error: AgentSignalError }[] = [];

    // Bounded rather than all at once. Twenty recipients arriving together is
    // a rate limit hit twenty times, and the answer to that is not a retry
    // loop -- it is not doing it.
    const width = Math.max(1, Math.min(options.concurrency ?? 4, 10));
    const queue = [...unique];

    const worker = async () => {
      for (;;) {
        const recipient = queue.shift();
        if (!recipient) return;

        try {
          const result = await this.send({
            ...input,
            to: recipient,
            ...(input.idempotency_key
              ? { idempotency_key: `${input.idempotency_key}:${recipient}` }
              : {}),
          });
          sent.push({ recipient, result });
        } catch (error) {
          failed.push({
            recipient,
            error:
              error instanceof AgentSignalError
                ? error
                : new AgentSignalError('send_failed', String(error)),
          });
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(width, queue.length) }, worker));

    return { sent, failed };
  }

  // -------------------------------------------------------------------------
  // Asking, and waiting for the answer
  //
  // The mechanism has existed since the Waitroom landed and no client exposed
  // any of it: `GET /v1/messages/:id/responses` was reachable only by hand.
  // So an agent could be given `respond_to_message` and have no way to pose a
  // question for anything to respond to -- half a conversation, shipped.
  // -------------------------------------------------------------------------

  /**
   * The answers to a question, optionally waiting for one to arrive.
   *
   * With `waitSeconds` the server holds the request until somebody answers,
   * rather than you asking every few seconds and wearing the dead time. It
   * returns on the first answer, or at the deadline with `timed_out` -- which
   * is a real answer about the world, not a failure.
   */
  async responses(
    messageId: string,
    options: { waitSeconds?: number } = {},
  ): Promise<AnswerSet> {
    const { suffix, timeoutMs } = waitRequestOptions(options.waitSeconds);

    // The request has to outlive the hold it just asked for, or the client
    // aborts its own wait, the retry logic treats that as transient, and the
    // call throws instead of returning "nobody answered". That exact bug hid
    // in `receipt()` until something tested the path where nobody replies.
    return this.request(
      `/v1/messages/${encodeURIComponent(messageId)}/responses${suffix}`,
      undefined,
      'GET',
      timeoutMs,
    );
  }

  /**
   * Ask a question and block until it is answered.
   *
   * Distinct from `alertAndWait`, which is for a *person* and asks only
   * whether they acknowledged. This asks a question with up to three options
   * and comes back with which one was chosen -- the handoff an agent uses to
   * put a decision to another agent, or to a human, and wait on the result as
   * control flow.
   *
   * Answers come back in the order they arrived. A group question can collect
   * several; `answer` is simply the first.
   */
  async ask(
    input: SendMessageInput & { options: string[] },
    wait: { waitSeconds?: number } = {},
  ): Promise<{
    id: string;
    answered: boolean;
    /** The option text that was chosen, if one was. */
    answer: string | null;
    answers: Answer[];
    waitedMs: number | undefined;
  }> {
    const sent = await this.send(input);
    const seconds = wait.waitSeconds ?? 60;

    const result = await this.responses(sent.id, { waitSeconds: seconds });
    const first = result.responses[0];

    return {
      id: sent.id,
      answered: result.responses.length > 0,
      // Resolved back to the text the asker wrote rather than handed back as
      // an index. An agent reading `1` has to remember what it offered; an
      // agent reading "Roll back" does not.
      answer: first ? (result.options[first.option_index] ?? null) : null,
      answers: result.responses,
      waitedMs: result.waited_ms,
    };
  }

  // -------------------------------------------------------------------------
  // What happened to what I sent
  //
  // The one question an unattended agent could not ask. `inbox()` returns what
  // was sent *to* you; `receipt()` answers one emergency. Nothing answered
  // "did that land" -- invisible to a person, who opens the dashboard, and
  // decisive for a process with nobody watching it.
  // -------------------------------------------------------------------------

  /**
   * What this channel sent, newest first, with what became of each one.
   *
   * One row per message rather than per device: a send fans out across every
   * device its recipient owns, and "did it land" means "did anything", not
   * "did device three of four". `failed` being non-zero is the thing to look
   * at; `errors` says why, once per distinct reason.
   *
   * Pollable. Pass `since` -- the `created_at` of the last row you handled --
   * and a restart does not replay everything.
   */
  async log(
    options: { since?: string; limit?: number } = {},
  ): Promise<SentMessage[]> {
    const query = new URLSearchParams();
    if (options.since) query.set('since', options.since);
    if (options.limit) query.set('limit', String(options.limit));
    const suffix = query.toString() ? `?${query}` : '';

    const result = await this.request<{ messages: SentMessage[] }>(
      `/v1/messages${suffix}`,
      undefined,
      'GET',
    );
    return result.messages;
  }

  // -------------------------------------------------------------------------
  // Scheduling
  //
  // The API has had these since the beginning and no client exposed them, so
  // an agent that wanted to send something on Monday had to hand-roll HTTP.
  // -------------------------------------------------------------------------

  /** Everything this channel has scheduled. */
  async schedules(): Promise<Schedule[]> {
    const result = await this.request<{ schedules: Schedule[] }>(
      '/v1/schedules',
      undefined,
      'GET',
    );
    return result.schedules;
  }

  /**
   * Schedule a message.
   *
   * `cron` repeats; `at` fires once. Times are UTC unless `timezone` says
   * otherwise, and getting that wrong is the classic way a daily 09:00 report
   * arrives at two in the morning -- so pass the zone if the hour matters to
   * somebody.
   */
  async schedule(input: CreateScheduleInput): Promise<Schedule> {
    const result = await this.request<{ schedule: Schedule }>('/v1/schedules', input);
    return result.schedule;
  }

  /** Pause, resume, retime or reword one. */
  async updateSchedule(id: string, changes: UpdateScheduleInput): Promise<Schedule> {
    const result = await this.request<{ schedule: Schedule }>(
      `/v1/schedules/${encodeURIComponent(id)}`,
      changes,
      'PATCH',
    );
    return result.schedule;
  }

  /** Stop it for good. Pausing is `updateSchedule(id, { paused: true })`. */
  async deleteSchedule(id: string): Promise<{ ok: true }> {
    return this.request(
      `/v1/schedules/${encodeURIComponent(id)}`,
      undefined,
      'DELETE',
    );
  }

  /**
   * When it would next fire, without waiting to find out.
   *
   * The field is `runs`. This read `next_runs` in 0.2.0 and therefore always
   * returned undefined -- shipped, because the tests that should have caught
   * it were written from the same wrong assumption as the code and stubbed
   * `next_runs` back. An API test against the real route found it.
   */
  async previewSchedule(id: string): Promise<string[]> {
    const result = await this.request<{ runs: string[] }>(
      `/v1/schedules/${encodeURIComponent(id)}/preview`,
      undefined,
      'GET',
    );
    return result.runs;
  }

  /** What it has already done. */
  async scheduleRuns(id: string): Promise<ScheduleRun[]> {
    const result = await this.request<{ runs: ScheduleRun[] }>(
      `/v1/schedules/${encodeURIComponent(id)}/runs`,
      undefined,
      'GET',
    );
    return result.runs;
  }

  // -------------------------------------------------------------------------
  // Saying something is wrong
  // -------------------------------------------------------------------------

  /**
   * Report a problem, or ask for something better.
   *
   * Put the failing call in `context` -- what you sent, what came back, what
   * you expected. An agent is the best bug reporter there is: it still has
   * the request in hand at the moment it notices.
   *
   * `recorded: false` means it was accepted and dropped for volume rather
   * than kept. Twenty an hour per channel; you are told so that a retry loop
   * does not quietly believe it filed twenty distinct reports.
   */
  async report(
    kind: 'problem' | 'improvement',
    body: string,
    context?: Record<string, unknown>,
  ): Promise<{ ok: true; recorded: boolean; id?: string; note?: string }> {
    return this.request('/v1/feedback', {
      kind,
      body,
      ...(context ? { context } : {}),
    });
  }

  // -------------------------------------------------------------------------
  // Transport
  // -------------------------------------------------------------------------

  private async request<T>(
    path: string,
    body?: unknown,
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE' = 'POST',
    timeoutMs?: number,
  ): Promise<T> {
    return httpRequest<T>({
      fetchImpl: this.fetchImpl,
      url: `${this.baseUrl}${path}`,
      method,
      authorization: `Bearer ${this.apiKey}`,
      body,
      maxAttempts: this.maxAttempts,
      timeoutMs: timeoutMs ?? this.timeoutMs,
      // On a keyed send a 402 is the plan ceiling, and there is nothing the
      // caller can do about it from here.
      on402: (message, payload) => {
        const details = payload?.error?.details as { would_send?: number } | undefined;
        throw new QuotaExceededError(message, details?.would_send);
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Shared transport
//
// Both clients retry the same way against the same API; only the credential
// and the meaning of a 402 differ. Keeping one copy means a fix to the backoff
// cannot land on the keyed path and miss the paid one.
// ---------------------------------------------------------------------------

interface ErrorPayload {
  error?: { code: string; message: string; details?: unknown };
}

interface RequestSpec {
  fetchImpl: typeof globalThis.fetch;
  url: string;
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  authorization: string;
  body?: unknown;
  maxAttempts: number;
  timeoutMs: number;
  on402: (message: string, payload: ErrorPayload | null) => never;
  /** Given the raw response before its body is read. Used to catch a minted token. */
  onResponse?: (response: Response) => void;
}

/** `bytes` random bytes as lowercase hex, from the platform CSPRNG. */
function randomHex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function httpRequest<T>(spec: RequestSpec): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt < spec.maxAttempts; attempt += 1) {
    if (attempt > 0) {
      // Exponential backoff with jitter, so a fleet of agents retrying after
      // the same outage does not arrive in lockstep.
      const base = Math.min(1000 * 2 ** (attempt - 1), 8000);
      await new Promise((r) => setTimeout(r, base + Math.random() * 250));
    }

    try {
      const response = await spec.fetchImpl(spec.url, {
        method: spec.method,
        headers: {
          Authorization: spec.authorization,
          'Content-Type': 'application/json',
          'User-Agent': 'agentsignal-sdk',
        },
        ...(spec.body === undefined ? {} : { body: JSON.stringify(spec.body) }),
        signal: AbortSignal.timeout(spec.timeoutMs),
      });

      spec.onResponse?.(response);

      if (response.ok) {
        return (await response.json()) as T;
      }

      const payload = (await response.json().catch(() => null)) as ErrorPayload | null;

      const code = payload?.error?.code ?? 'internal';
      const message = payload?.error?.message ?? `Request failed (${response.status}).`;

      if (response.status === 429) {
        const retryAfter = Number(response.headers.get('Retry-After') ?? '1');
        lastError = new RateLimitedError(message, retryAfter);
        continue;
      }

      if (response.status === 402) {
        spec.on402(message, payload);
      }

      // 4xx other than the two above is our caller's mistake; retrying it
      // just delays the error.
      if (response.status < 500) {
        throw new AgentSignalError(code, message, response.status, payload?.error?.details);
      }

      lastError = new AgentSignalError(code, message, response.status);
    } catch (error) {
      if (error instanceof AgentSignalError && error.status && error.status < 500) {
        throw error;
      }
      lastError = error;
    }
  }

  if (lastError instanceof AgentSignalError) throw lastError;
  throw new AgentSignalError(
    'network_error',
    lastError instanceof Error ? lastError.message : 'Request failed.',
  );
}

// ---------------------------------------------------------------------------
// Pay as you go
// ---------------------------------------------------------------------------

export interface CreditPack {
  code: string;
  name: string;
  price_micros: number;
  deliveries: number;
}

export interface CreditBalance {
  /** Deliveries granted rather than bought. Spent first. */
  free: number;
  /** Deliveries bought with a pack. */
  paid: number;
  /** `free + paid` -- what you can actually send before paying again. */
  total: number;
}

export interface OpenCreditResult extends CreditBalance {
  /**
   * `as_credit_…`. Returned by the call that mints it and never retrievable
   * again — exactly like an API key. Persist it before you do anything else.
   */
  token: string;
  expires_at: string | null;
}

export interface X402Quote {
  ok: true;
  /** Devices this recipient has. Each one is a delivery. */
  devices: number;
  costs_deliveries: number;
  free: {
    /** False when unpaid sends are not available here. Paid sends still work. */
    accepted: boolean;
    /**
     * Why not, when `accepted` is false. `channel` is somebody's setting and
     * could be changed by asking them; `recipient_is_agent` is a fact about the
     * recipient -- free deliveries are a trial of reaching a person, and no
     * setting makes agent-to-agent traffic free. Null when free is available.
     */
    blocked_by: 'channel' | 'recipient_is_agent' | null;
    /** Free deliveries this recipient will still absorb this window. */
    allowance_remaining: number;
  };
  packs: CreditPack[];
  network: string;
  asset: string;
}

export interface X402SendResult {
  ok: true;
  id: string;
  receipt: string | null;
  replayed: boolean;
  deliveries: { total: number; sent: number; failed: number; queued: number };
  credit: {
    /** Present only on the response that minted it. */
    token?: string;
    /** Free deliveries left after this send. */
    free: number;
    /** Bought deliveries left after this send. */
    paid: number;
    /** Which balance this send actually came out of. */
    spent: { free: number; paid: number };
  };
}

export interface X402Options {
  /**
   * An existing credit token. Omit and call `openCredit()` to be given one,
   * or use `AgentSignalX402.open()` to do both in a line.
   */
  credit?: string;
  baseUrl?: string;
  maxAttempts?: number;
  timeoutMs?: number;
  /**
   * The fetch used to reach us.
   *
   * To buy a pack, pass one already wrapped by an x402 client -- typically
   * `wrapFetchWithPayment(fetch, account)` from `x402-fetch`. That wrapper
   * answers the 402 and repeats the request with a signed payment, so `send`
   * simply succeeds and the bought token comes back on it. This SDK never sees
   * a private key, never signs, and never touches a chain; leaving that to a
   * fetch you supply is the only arrangement where that stays true.
   *
   * With a plain fetch, a send that needs paying for throws
   * `PaymentRequiredError` carrying the offer.
   */
  fetch?: typeof globalThis.fetch;
}

/**
 * Sending with no account, no API key and — to start with — no wallet.
 *
 * A separate client rather than a mode on `AgentSignal`, because almost
 * nothing carries over: a different credential, different endpoints, and a 402
 * that means "pay me" rather than "you are over your plan". Folding them
 * together would mean an `AgentSignal` whose constructor no longer insists on
 * a key, which is how a typo becomes an unauthenticated client that fails
 * three calls later.
 */
export class AgentSignalX402 {
  private token: string | undefined;
  private readonly baseUrl: string;
  private readonly maxAttempts: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: X402Options = {}) {
    this.token = options.credit ?? process.env.AGENTSIGNAL_CREDIT;
    this.baseUrl = (
      options.baseUrl ?? process.env.AGENTSIGNAL_BASE_URL ?? DEFAULT_BASE_URL
    ).replace(/\/+$/, '');
    this.maxAttempts = options.maxAttempts ?? 3;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  /** Open a token and hand back a client already holding it. */
  static async open(options: X402Options = {}): Promise<AgentSignalX402> {
    const client = new AgentSignalX402(options);
    await client.openCredit();
    return client;
  }

  /** The token in use, so a caller can persist one that was minted here. */
  get credit(): string | undefined {
    return this.token;
  }

  /**
   * Get a credit token with the free block on it.
   *
   * No payment, no wallet, no account. The token it returns is shown once and
   * is adopted by this client; store it, or the next process starts over.
   */
  async openCredit(): Promise<OpenCreditResult> {
    const result = await this.request<{ ok: true; credit: OpenCreditResult }>(
      '/v1/x402/credits',
      undefined,
      'POST',
      // Nothing to authenticate with yet; that is the point of the call.
      false,
    );
    this.token = result.credit.token;
    return result.credit;
  }

  /** What is left, without having to send something to find out. */
  async balance(): Promise<CreditBalance> {
    const result = await this.request<{ ok: true; credit: CreditBalance }>(
      '/v1/x402/credits',
      undefined,
      'GET',
    );
    return result.credit;
  }

  /** What is on sale, and how big the free block is. */
  async packs(): Promise<{
    packs: CreditPack[];
    free: { deliveries: number; open: string; note: string };
    network: string;
    asset: string;
  }> {
    return this.request('/v1/x402/packs', undefined, 'GET', false);
  }

  /**
   * What a send to this recipient would cost, and whether free credit is
   * welcome there — without committing to one. Needs no credit token.
   */
  async quote(recipientKey: string): Promise<X402Quote> {
    return this.request(
      `/v1/x402/quote/${encodeURIComponent(recipientKey)}`,
      undefined,
      'GET',
      false,
    );
  }

  /**
   * Send, drawing on this token.
   *
   * Free credit is spent before bought credit. With a payment-wrapped fetch a
   * send that runs past the balance buys a pack and goes through; with a plain
   * one it throws `PaymentRequiredError` carrying what it would have cost.
   */
  async send(input: SendMessageInput): Promise<X402SendResult> {
    if (!input.to || !input.to.startsWith('u_')) {
      throw new AgentSignalError(
        'invalid_request',
        'Pay-as-you-go sends address one recipient key. Set "to" to a u_… key. Groups and broadcasts are not payable, so one key never buys a whole channel.',
      );
    }

    const parsed = sendMessageSchema.safeParse(input);
    if (!parsed.success) {
      throw new AgentSignalError(
        'invalid_request',
        `Invalid message: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`,
        undefined,
        parsed.error.issues,
      );
    }

    const result = await this.request<X402SendResult>('/v1/x402/messages', {
      ...parsed.data,
      idempotency_key: input.idempotency_key ?? crypto.randomUUID(),
    });

    // A send that paid its way mints a token when the caller had none. Adopt
    // it, or the money bought a balance this client cannot reach.
    if (result.credit?.token) this.token = result.credit.token;

    return result;
  }

  private async request<T>(
    path: string,
    body?: unknown,
    method: 'GET' | 'POST' = 'POST',
    needsCredit = true,
  ): Promise<T> {
    if (needsCredit && !this.token) {
      throw new AgentSignalError(
        'missing_credit',
        'No credit token. Call openCredit() for a free block, set AGENTSIGNAL_CREDIT, or pass one as `credit`.',
      );
    }

    return httpRequest<T>({
      fetchImpl: this.fetchImpl,
      url: `${this.baseUrl}${path}`,
      method,
      authorization: this.token ? `Credit ${this.token}` : '',
      body,
      maxAttempts: this.maxAttempts,
      timeoutMs: this.timeoutMs,
      // Here a 402 is an offer rather than a wall. It carries the x402
      // envelope, so a caller holding a wallet can pay it and repeat.
      on402: (message, payload) => {
        const body = payload as
          | (ErrorPayload & { accepts?: unknown[]; error?: string })
          | null;
        // A 402 from the paid route is the x402 envelope itself, not our
        // usual `{ error: { code, message } }` shape.
        const envelope = body as unknown as {
          accepts?: unknown[];
          error?: string | { message?: string };
          packs?: CreditPack[];
          reason?: string;
        } | null;
        const text =
          typeof envelope?.error === 'string' ? envelope.error : message;
        throw new PaymentRequiredError(
          text,
          envelope?.accepts ?? [],
          envelope?.packs ?? [],
          envelope?.reason,
        );
      },
      onResponse: (response) => {
        // Also arrives in the body, but a caller that only reads headers on a
        // 402-then-200 exchange still gets it.
        const minted = response.headers.get('X-Credit-Token');
        if (minted) this.token = minted;
      },
    });
  }
}

// ---------------------------------------------------------------------------
// An agent acting as itself
// ---------------------------------------------------------------------------

export interface InboxMessage {
  delivery_id: string;
  message_id: string;
  title: string | null;
  body: string | null;
  priority: number;
  options: string[] | null;
  /**
   * A document that came with the message, still compressed. Open it with
   * unpackDocument, which checks the checksum and refuses one that did not
   * survive -- do not decode it by hand.
   *
   * Null on almost every message. It arrives on this read rather than in the
   * push, which has no room for it.
   */
  attachment?: Attachment | null;
  created_at: string;
  read_at: string | null;
  /**
   * Whether the body is ciphertext this device has to decrypt.
   *
   * Carried so a reader can tell whether confirming a read is DESTRUCTIVE.
   * `confirm_read` purges the content once every device has read it, which is
   * right when a person tapped the message and was warned, and wrong when an
   * unattended agent polled its inbox.
   */
  encrypted: boolean;
  /**
   * Who sent it. Null for all three when the channel's API key did: that
   * message speaks for the channel rather than for a member of it, and there
   * is nobody to reply to. Distinct from "unknown sender".
   *
   * The key is what a reply is addressed to; the handle is what to show. Both
   * are returned because a client with only one of them has to go looking for
   * the other before it can either print or answer.
   */
  from_key: string | null;
  from_handle: string | null;
  from_name: string | null;
}

export interface AgentChannel {
  ref: string;
  name: string;
  slug: string;
  /**
   * The company that owns it, and the one fact that decides whose rules the
   * work in it runs under.
   *
   * Compared on `account`, never on `company`: two companies may be called the
   * same thing, and one renamed mid-session must not read as two. The name is
   * for saying which, not for deciding.
   *
   * Optional because an older API does not send it, and treating absence as a
   * mismatch would refuse every channel against a server that has not been
   * deployed yet.
   */
  account?: string;
  company?: string | null;
  /** The channel this agent lives in. It cannot leave this one. */
  is_home: boolean;
  is_sandbox: boolean;
  /** True if this agent created it, and therefore manages who is in it. */
  mine: boolean;
  /**
   * Who created it — the recipient key, readable by every member rather than
   * only by the creator. This is what makes "the creator leads" checkable by a
   * follower instead of a claim it has to take on trust.
   *
   * Null for a channel with no creator on record: an account's original
   * channel predates agents making their own. A fleet in one of those has
   * nobody to defer to and falls back to key order.
   */
  created_by: string | null;
  created_by_handle: string | null;
  /**
   * The working directory this channel was created in, as reported by the
   * creating client. A hint, not a boundary: it is unverifiable, and it exists
   * so a session can notice it is joining a fleet from a different project.
   */
  scope_path: string | null;
  members: number;
}

export interface AgentSelfOptions {
  /** `<instance_id>.<secret>`, from the register call. Shown once. */
  credential?: string;
  baseUrl?: string;
  maxAttempts?: number;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

/**
 * The other half of the loop.
 *
 * `AgentSignal` sends; this receives, and manages the channels an agent is
 * reachable in. Separate because the credential is different in kind: an API
 * key answers "which channel am I sending through", and a device credential
 * answers "who am I". Every call here is about the second question, and
 * answering it with a key would make the creator of a channel whoever handed the
 * key out rather than the agent that asked for it.
 *
 * The credential comes back from `AgentSignal.register()` and is shown once.
 */
/** A join token an agent minted. `token` is present exactly once, at creation. */
export interface SpawnedToken {
  id: string;
  token: string;
  name: string;
  prefix: string;
  max_uses: number | null;
  expires_at: string;
  label_ref: string;
}

/**
 * A token as it comes back from the list, which is the history rather than
 * what is live. The secret is not in it -- that existed once, in the response
 * that minted it.
 */
export interface ListedJoinToken extends Omit<SpawnedToken, 'token'> {
  /** Redemptions so far. Compare against `max_uses` for what is left. */
  uses: number;
  /** Set once cancelled. A revoked token is dead however much else looks fine. */
  revoked_at: string | null;
  created_at: string;
}

export class AgentSelf {
  private readonly credential: string;
  private readonly baseUrl: string;
  private readonly maxAttempts: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: AgentSelfOptions = {}) {
    const credential = options.credential ?? process.env.AGENTSIGNAL_DEVICE_SECRET;
    if (!credential) {
      throw new AgentSignalError(
        'missing_credential',
        'Pass the `credential` from register(), or set AGENTSIGNAL_DEVICE_SECRET.',
      );
    }

    this.credential = credential;
    this.baseUrl = (
      options.baseUrl ?? process.env.AGENTSIGNAL_BASE_URL ?? DEFAULT_BASE_URL
    ).replace(/\/+$/, '');
    this.maxAttempts = options.maxAttempts ?? 3;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  /**
   * Join a channel with a join token, and come back as a working agent.
   *
   * The whole bootstrap in one call. A join token can create an agent and
   * nothing else, so this is the only thing you can do with one -- which is
   * the point: the value you paste into a fleet's environment cannot page
   * anybody if it leaks.
   *
   * Idempotent on `handle`. The same handle is the same agent, so a restart
   * rejoins rather than filling the directory with ghosts -- but the
   * credential is minted fresh each time, so keep the one you get back.
   */
  static async join(
    joinToken: string,
    input: RegisterAgentInput,
    options: Omit<AgentSelfOptions, 'credential'> = {},
  ): Promise<{ agent: AgentSelf; registration: RegisterAgentResult }> {
    const baseUrl = (
      options.baseUrl ?? process.env.AGENTSIGNAL_BASE_URL ?? DEFAULT_BASE_URL
    ).replace(/\/+$/, '');

    const registration = await httpRequest<RegisterAgentResult>({
      fetchImpl: options.fetch ?? globalThis.fetch,
      url: `${baseUrl}/v1/agents/register`,
      method: 'POST',
      authorization: `Join ${joinToken}`,
      /*
        ONE INSTANCE PER JOIN CALL, fixed before the first attempt.

        httpRequest retries this POST. Without an instance_id each attempt was
        a new device, so a response lost in transit left a ghost device on the
        agent. And the server now asks something of a repeat (F1): a join that
        names an existing handle must either prove it holds that agent's
        credential (`current_credential`) or be a retry of the same join --
        which it recognises by this instance_id already being that agent's
        device. A caller's own instance_id still wins.

        join_attempt is the other half of "the same join": a random secret made
        once here and repeated on every attempt. The server lets a retry skip
        the proof only when it repeats this AND the instance; somebody else
        holding the same code never sees it.

        Defaults are applied AFTER the spread, with ??, so a caller passing an
        explicit `instance_id: undefined` still gets one (review logic#3).
      */
      body: {
        ...input,
        instance_id: input.instance_id ?? crypto.randomUUID(),
        join_attempt: input.join_attempt ?? randomHex(32),
      },
      maxAttempts: options.maxAttempts ?? 3,
      timeoutMs: options.timeoutMs ?? 15_000,
      on402: (message) => {
        throw new AgentSignalError('payment_required', message, 402);
      },
    });

    return {
      agent: new AgentSelf({ ...options, credential: registration.device_secret }),
      registration,
    };
  }

  /**
   * What has arrived.
   *
   * Nothing is pushed to an agent with no address of its own: the delivery row
   * is the delivery, and this is the agent coming to ask. Pass `since` with the
   * last `created_at` you handled so a restart does not replay the lot.
   *
   * ⚠ THIS ACKNOWLEDGES. Reading is what a read receipt reports, so returning
   * the messages and telling the sender nothing left every delivery sitting at
   * `pending` — "row created, not yet handed to a provider" — for the entire
   * life of a conversation that was demonstrably being read and answered. The
   * server has counted reads and exposed `/read` and `/delivered` from the
   * start, and the whole state machine past the first state was dead because no
   * agent-side path ever called them: `markRead` existed here, tested, with no
   * caller anywhere.
   *
   * The cost of that was not cosmetic. Watching a conversation, the only
   * available reading of "pending" is "it never arrived", so silence looked
   * like a broken channel rather than an agent that had not answered yet.
   *
   * Pass `ack: false` where fetching genuinely is not reading — a poller that
   * wakes something else, a preview, a count. The daemon does not come through
   * here at all; it holds its own fetch, which is right, because it delivers a
   * notification rather than reading anything.
   */
  async inbox(
    options: { since?: string; limit?: number; ack?: boolean } = {},
  ): Promise<InboxMessage[]> {
    const query = new URLSearchParams();
    if (options.since) query.set('since', options.since);
    if (options.limit) query.set('limit', String(options.limit));
    const suffix = query.size > 0 ? `?${query}` : '';

    const result = await this.request<{ messages: InboxMessage[] }>(
      `/v1/devices/me/messages${suffix}`,
      undefined,
      'GET',
    );

    if (options.ack !== false) {
      await this.acknowledge(result.messages);
    }

    return result.messages;
  }

  /**
   * Answer a message that asked a question.
   *
   * Takes the answer as its text -- the words the sender offered -- or as the
   * index, if you already have it. The API takes only the index: this used to
   * send `{ option: "Go ahead" }` where it wanted `{ option_index: 0 }`, so
   * every answer sent through this SDK, the CLI, and the MCP server was
   * rejected with a 400. The whole documented agent-answers-a-question path
   * had never worked.
   *
   * Resolving the text costs one extra request, because the index only means
   * something against that message's own options and the caller holding a
   * string does not necessarily have them. Pass a number, or `options`, to skip
   * it.
   */
  async respond(
    deliveryId: string,
    answer: string | number,
    options?: string[],
    body?: string,
  ): Promise<{ ok: true }> {
    const index =
      typeof answer === 'number'
        ? answer
        : await this.indexOfOption(deliveryId, answer, options);

    if (!Number.isInteger(index) || index < 0 || index > 2) {
      throw new Error(
        `option_index must be 0, 1 or 2 -- got ${JSON.stringify(index)}`,
      );
    }

    /*
      REFUSED HERE TOO, not just by the server. A body over the limit is a
      report somebody spent real work producing, and finding out locally beats
      a round trip -- but the check is duplicated rather than moved, because a
      client that trusts itself is how the server's limit stops being enforced.
    */
    const said = body?.trim();
    if (said && said.length > 4096) {
      throw new Error(
        `A response body is at most 4096 characters -- this one is ${said.length}. ` +
          'Send the long version as a file and say where it is.',
      );
    }

    return this.request(
      `/v1/devices/me/messages/${encodeURIComponent(deliveryId)}/respond`,
      said ? { option_index: index, body: said } : { option_index: index },
    );
  }

  /**
   * Which of the offered answers this is, matched forgivingly.
   *
   * Case and surrounding space are ignored: an agent echoing back an option it
   * was shown should not fail on capitalisation, and a human at the CLI should
   * not have to match punctuation exactly. Anything that still does not match
   * is an error naming what was actually on offer, rather than a guess.
   */
  /**
   * The ciphertext an encrypted inbox message only pointed at.
   *
   * A push cannot carry ciphertext -- it does not fit in APNs' budget -- so an
   * encrypted delivery arrives as a pointer and the content is fetched. That
   * is also what makes vanishing real: once the content is purged this returns
   * nothing, so expiry is enforced by the server rather than promised by a
   * client that already holds the plaintext.
   *
   * Returns null when the message has vanished or was never encrypted, rather
   * than throwing: a reader walking its inbox should be able to skip one
   * message without the walk failing.
   */
  async sealedContent(deliveryId: string): Promise<{
    ciphertext: string;
    nonce: string;
    wrapped_key: string;
    ephemeral_public_key: string;
  } | null> {
    try {
      const result = await this.request<{
        ok: boolean;
        ciphertext: string;
        nonce: string;
        wrapped_key: string;
        ephemeral_public_key: string;
      }>(`/v1/devices/me/messages/${encodeURIComponent(deliveryId)}/content`, undefined, 'GET');
      return result.ok ? result : null;
    } catch {
      return null;
    }
  }

  private async indexOfOption(
    deliveryId: string,
    answer: string,
    supplied?: string[],
  ): Promise<number> {
    let options = supplied;

    if (!options) {
      // `ack: false` — this is a LOOKUP for the answer's index, not the agent
      // reading its inbox. Without it, answering one question by its text would
      // silently mark every other waiting message read.
      const message = (await this.inbox({ ack: false })).find(
        (m) => m.delivery_id === deliveryId,
      );
      if (!message) {
        throw new Error(
          `No message ${deliveryId} in this agent's inbox, so there is nothing to answer.`,
        );
      }
      options = message.options ?? [];
    }

    const wanted = answer.trim().toLowerCase();
    const index = options.findIndex((o) => o.trim().toLowerCase() === wanted);

    if (index === -1) {
      throw new Error(
        options.length === 0
          ? `Message ${deliveryId} did not ask a question, so there is no answer to give.`
          : `"${answer}" is not one of the answers offered: ${options
              .map((o) => `"${o}"`)
              .join(', ')}.`,
      );
    }

    return index;
  }

  /** Mark it handled. For an emergency alert this is the acknowledgement. */
  async markRead(deliveryId: string): Promise<{ ok: true }> {
    return this.request(`/v1/devices/me/messages/${encodeURIComponent(deliveryId)}/read`, {});
  }

  /**
   * It arrived. Deliberately NOT a read.
   *
   * The state machine separates the two because reading is destructive for an
   * encrypted message and receiving it is not. An agent that fetched ciphertext
   * has genuinely received it and has genuinely not opened it, and this is the
   * only honest thing to record about that.
   */
  async markDelivered(deliveryId: string): Promise<{ ok: true }> {
    return this.request(`/v1/devices/me/messages/${encodeURIComponent(deliveryId)}/delivered`, {});
  }

  /**
   * Tell the sender their message landed.
   *
   * ⚠ ENCRYPTED MESSAGES ARE ONLY EVER MARKED DELIVERED. `confirm_read` purges
   * the content once the last device has read it, and that is a trade a PERSON
   * agrees to after being warned — an unattended poll must not spend somebody
   * else's message on their behalf.
   *
   * Best effort, always. A receipt is bookkeeping and reading is the job: a
   * failed ack must never cost the caller the messages it just fetched, so
   * every outcome is swallowed and the list is returned regardless.
   */
  private async acknowledge(messages: InboxMessage[]): Promise<void> {
    const unseen = messages.filter((m) => m.read_at === null);

    if (unseen.length === 0) {
      return;
    }

    await Promise.allSettled(
      unseen.map((m) => (m.encrypted ? this.markDelivered(m.delivery_id) : this.markRead(m.delivery_id))),
    );
  }

  // -------------------------------------------------------------------------
  // Sending
  // -------------------------------------------------------------------------

  /**
   * Send as yourself.
   *
   * Reaches whoever you share a channel with, and nothing else -- the same rule
   * the directory answers by. The message records which agent sent it, so a
   * delivery log can name `deploy-bot` rather than the one key a whole fleet
   * shares.
   *
   * Which channel it goes through is resolved from the ones you and the target
   * share; name one with `channel` when you are in several together and it
   * matters which brand the notification carries.
   */
  async send(input: SendMessageInput & { channel?: string }): Promise<SendResult> {
    const { channel, ...message } = input;

    if (!message.to) {
      throw new AgentSignalError(
        'invalid_request',
        'Send to one recipient key. Groups and broadcasts belong to whoever owns the channel, not to an agent that joined it.',
      );
    }

    const parsed = sendMessageSchema.safeParse(message);
    if (!parsed.success) {
      throw new AgentSignalError(
        'invalid_request',
        `Invalid message: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`,
        undefined,
        parsed.error.issues,
      );
    }

    return this.request<SendResult>(
      `/v1/messages${channel ? `?channel=${encodeURIComponent(channel)}` : ''}`,
      { ...parsed.data, idempotency_key: message.idempotency_key ?? crypto.randomUUID() },
    );
  }

  /** An emergency alert that repeats on every device until somebody answers. */
  async alert(
    input: Omit<SendMessageInput, 'priority'> & {
      channel?: string;
      retry_seconds?: number;
      expire_seconds?: number;
    },
  ): Promise<SendResult> {
    return this.send({ retry_seconds: 60, expire_seconds: 3600, ...input, priority: 2 });
  }

  /**
   * Alert somebody and block until they acknowledge, or until it expires.
   *
   * The human-in-the-loop primitive, from the credential an agent actually
   * holds. Returns false on expiry, so a caller that ignores the result fails
   * closed rather than proceeding unapproved.
   */
  async alertAndWait(
    input: Parameters<AgentSelf['alert']>[0] & { pollSeconds?: number },
  ): Promise<{ acknowledged: boolean; receipt: string | null; result: SendResult }> {
    const { pollSeconds = 5, ...rest } = input;
    const result = await this.alert(rest);

    if (!result.receipt) return { acknowledged: false, receipt: null, result };

    const acknowledged = await waitForAcknowledgement({
      receiptId: result.receipt,
      expireSeconds: rest.expire_seconds ?? 3600,
      pollSeconds,
      receipt: (id, options) => this.receipt(id, options),
    });
    return { acknowledged, receipt: result.receipt, result };
  }

  /** Whether an alert you raised has been acknowledged. */
  async receipt(
    receiptId: string,
    options: { waitSeconds?: number } = {},
  ): Promise<{ acknowledged: boolean; acked_at: string | null; waited_ms?: number }> {
    const { suffix, timeoutMs } = waitRequestOptions(options.waitSeconds);
    /**
     * The request has to outlive the hold it just asked for.
     *
     * `timeoutMs` defaults to 15s and `alertAndWait` asks the server to hold
     * for up to 60, so the client aborted its own wait, `httpRequest` treated
     * the abort as transient and retried it, and after maxAttempts the whole
     * call threw. `alertAndWait` therefore never returned "not acknowledged"
     * -- it raised a network error roughly 45 seconds in, and the CLI exited 1
     * where it documents 2. Nobody saw it because nothing tested the path
     * where a human does not answer.
     */
    return this.request(
      `/v1/receipts/${encodeURIComponent(receiptId)}${suffix}`,
      undefined,
      'GET',
      timeoutMs,
    );
  }

  // -------------------------------------------------------------------------
  // Channels
  // -------------------------------------------------------------------------

  /** Every channel this agent is reachable in. */
  async channels(): Promise<AgentChannel[]> {
    const result = await this.request<{ channels: AgentChannel[] }>('/v1/channels', undefined, 'GET');
    return result.channels;
  }

  /**
   * Rename an agent — yours, or one in a channel you run.
   *
   * Omit `agent` to rename yourself, which needs no permission beyond being
   * yourself. The name must be free: an agent already called that, or an
   * unredeemed invitation holding it, is refused rather than resolved into
   * something nobody chose.
   *
   * The handle is untouched. Addressing is built on it, so a rename that moved
   * it would break every agent that had written the old one down.
   */
  async renameAgent(
    name: string,
    agent?: string,
  ): Promise<{ key: string; handle: string; name: string; was: string | null }> {
    const result = await this.request<{
      agent: { key: string; handle: string; name: string; was: string | null };
    }>('/v1/channels/agents/name', { name, ...(agent ? { agent } : {}) });
    return result.agent;
  }

  /**
   * Say what this agent is working on, in a line.
   *
   * Its own only — no target parameter, unlike renameAgent. A name can be
   * wrong in a way somebody else can see; a task cannot, and a status one
   * agent asserts about another looks reported while being guessed.
   *
   * Returns the stamp as well as the text, because the two are only useful
   * together: a task with no age reads as current however old it is, and an
   * agent that stopped a day ago leaves its last one looking live forever.
   * Pass an empty string to clear it, which is itself a statement — "nothing
   * named right now" is different from never having said.
   */
  async setTask(
    task: string,
  ): Promise<{ current_task: string | null; current_task_at: string | null }> {
    return this.request<{ current_task: string | null; current_task_at: string | null }>(
      '/v1/channels/agents/task',
      { task },
    );
  }

  /**
   * Make a channel — a room this agent runs and can put others in.
   *
   * It lands in the account the agent already belongs to, and carries no
   * branding: what a channel looks like on somebody's lock screen is not a thing
   * an unattended process chooses. A human can brand it later.
   */
  async createChannel(
    name: string,
    description?: string,
    scopePath?: string,
  ): Promise<AgentChannel & { id: string }> {
    const result = await this.request<{ channel: AgentChannel & { id: string } }>('/v1/channels', {
      name,
      ...(description ? { description } : {}),
      ...(scopePath ? { scope_path: scopePath } : {}),
    });
    return result.channel;
  }

  /**
   * Put another agent in a channel you made. `agent` is a recipient key or a
   * handle.
   *
   * Agents only, and the same account only. Both are refusals rather than
   * filters: pulling a person into a channel an agent named is one step from a
   * convincing notification from their bank, and reaching into another account
   * would let one customer's agent decide what another's is reachable for.
   */
  async addToChannel(channelRef: string, agent: string): Promise<{ ok: true }> {
    return this.request(`/v1/channels/${encodeURIComponent(channelRef)}/members`, { agent });
  }

  /**
   * Take an agent out. You may always remove yourself; a channel orchestrator
   * may retire a temporary subagent or worker in its own channel after it
   * completes its task. Persistent orchestrators and partners are not cleanup
   * targets.
   *
   * `keys_revoked` is how many API keys that agent held FOR THIS CHANNEL and
   * no longer does. An agent a person connected from the web holds one; an
   * agent another agent spawned holds none and the count is 0. It is worth
   * repeating back to whoever asked for the removal, because the alternative
   * -- and the behaviour until this was fixed -- is a removed agent still
   * holding a credential that authenticates.
   */
  async removeFromChannel(
    channelRef: string,
    agentKey: string,
  ): Promise<{ ok: true; removed: string; keys_revoked: number }> {
    return this.request(
      `/v1/channels/${encodeURIComponent(channelRef)}/members/${encodeURIComponent(agentKey)}`,
      undefined,
      'DELETE',
    );
  }

  /**
   * Mint a way in for an agent you are about to start.
   *
   * The returned `token` is the only time the secret exists anywhere: hand it
   * to the worker as AGENTSIGNAL_JOIN_TOKEN and it can register itself on this
   * channel and do nothing else. That is why an agent is allowed to hand one
   * out — it is strictly less than the credential you are holding.
   *
   * The server clamps what it gives you. Ask for a year and you get a day; ask
   * for a million uses and you get a hundred. A supervisor asking for too much
   * gets a token that works rather than an exception at 3am.
   *
   * ```ts
   * const { token } = await self.spawnToken(channel.ref, { name: 'workers', maxUses: 5 });
   * spawnWorker({ env: { AGENTSIGNAL_JOIN_TOKEN: token } });
   * ```
   */
  async spawnToken(
    channelRef: string,
    options: {
      name?: string;
      maxUses?: number;
      ttlHours?: number;
      /** What the invited agent is being started to be. Omit for a partner. */
      connectionType?: 'subagent' | 'partner' | 'worker';
    } = {},
  ): Promise<{
    id: string;
    token: string;
    name: string;
    prefix: string;
    max_uses: number | null;
    expires_at: string;
    label_ref: string;
  }> {
    const result = await this.request<{ token: SpawnedToken }>(
      `/v1/channels/${encodeURIComponent(channelRef)}/join-tokens`,
      {
        ...(options.name ? { name: options.name } : {}),
        ...(options.maxUses ? { max_uses: options.maxUses } : {}),
        ...(options.ttlHours ? { ttl_hours: options.ttlHours } : {}),
        ...(options.connectionType ? { connection_type: options.connectionType } : {}),
      },
    );
    return result.token;
  }

  /**
   * Every token this agent has handed out, so it can take them back.
   *
   * History, not a live list: revoked, expired and fully-spent tokens are all
   * returned, and `revoked_at`, `expires_at` and `uses` are what separate them
   * from one that can still be redeemed. A caller that renders these rows
   * without reading those three fields shows a dead credential as an open door.
   */
  async spawnTokens(): Promise<ListedJoinToken[]> {
    const result = await this.request<{ tokens: ListedJoinToken[] }>(
      '/v1/channels/join-tokens',
      undefined,
      'GET',
    );
    return result.tokens;
  }

  /** Revoke one you minted. Yours only — never a person's. */
  /**
   * The secrets this agent may use: names and references, never values.
   *
   * Nothing in the reply can leak, because nothing stored can: the server
   * holds `keychain://deploy/token` and not the token. Resolving a reference
   * happens on the agent's own machine.
   */
  async secrets(): Promise<
    Array<{ agent: string; name: string; reference: string; scope_path: string | null }>
  > {
    const result = await this.request<{
      secrets: Array<{ agent: string; name: string; reference: string; scope_path: string | null }>;
    }>('/v1/devices/me/secrets', undefined, 'GET');
    return result.secrets ?? [];
  }

  async revokeSpawnToken(id: string): Promise<{ ok: true }> {
    return this.request(
      `/v1/channels/join-tokens/${encodeURIComponent(id)}`,
      undefined,
      'DELETE',
    );
  }

  /**
   * Who else is reachable, across every channel this agent is in — or inside one
   * of them if `channelRef` is given.
   *
   * Joining is what makes others visible. There is no way to enumerate a channel
   * you were never added to.
   */
  async directory(
    options: { channelRef?: string; capability?: string; agentsOnly?: boolean } = {},
  ): Promise<DirectoryEntry[]> {
    const query = new URLSearchParams();
    if (options.capability) query.set('capability', options.capability);
    if (options.agentsOnly) query.set('agents_only', 'true');
    const suffix = query.size > 0 ? `?${query}` : '';
    const path = options.channelRef
      ? `/v1/channels/${encodeURIComponent(options.channelRef)}/agents${suffix}`
      : `/v1/channels/agents${suffix}`;

    const result = await this.request<{ recipients: DirectoryEntry[] }>(path, undefined, 'GET');
    return result.recipients;
  }

  private async request<T>(
    path: string,
    body?: unknown,
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE' = 'POST',
    timeoutMs?: number,
  ): Promise<T> {
    return httpRequest<T>({
      fetchImpl: this.fetchImpl,
      url: `${this.baseUrl}${path}`,
      method,
      authorization: `Device ${this.credential}`,
      body,
      maxAttempts: this.maxAttempts,
      timeoutMs: timeoutMs ?? this.timeoutMs,
      // Nothing an agent does as itself is metered, so a 402 here would be a
      // surprise rather than a quota.
      on402: (message) => {
        throw new AgentSignalError('payment_required', message, 402);
      },
    });
  }
}

export type { SendMessageInput };
export { Priority } from '@agentsignalnet/core';

// The encryption scheme's key generation, re-exported rather than duplicated.
// The MCP server needs a keypair to be sendable a secret and depends on this
// package rather than on core; a second implementation of key generation is
// exactly the "two implementations that only mostly agree" that crypto.ts
// exists to prevent.
export {
  generateEncryptionKeypair,
  importEncryptionPrivateKey,
  // Opening sealed content, for the same reason: the MCP has to be able to
  // read a key that was sealed to it, and a second unseal that only mostly
  // agrees with seal is the failure this file exists to avoid.
  unseal,
  fromBase64,
} from '@agentsignalnet/core';
