/**
 * What a key is allowed to do, as opposed to the fact that it exists.
 *
 * Until this, `messages:send` was the only scope ever stored and the only one
 * any route named, while nineteen doors were gated on HOLDING a key. So a
 * subagent minted to post build results could read every message in its
 * channel and spend the account's credit, because those were the same key.
 *
 * The list is short deliberately. A vocabulary nobody can hold in their head
 * gets one bundle used for everything, which is exactly the state it replaces.
 *
 * See docs/design/scopes.md for how it was derived and what it does not do.
 */
export const SCOPES = {
  /**
   * Send to people and agents in the channel. Agent-to-person requests are
   * reviewed by the channel agent; only that agent can page a real device.
   */
  MESSAGES_SEND: 'messages:send',
  /**
   * Read the channel's log: what everyone sent, and the answers to questions.
   *
   * Its own scope because reading is not sending, and the interesting subagent
   * is the one that should report progress without being able to read what
   * everybody else said.
   */
  MESSAGES_READ: 'messages:read',
  /** Who exists and how to reach them. Needed to send; harmless on its own. */
  DIRECTORY_READ: 'directory:read',
  /**
   * Create, change and cancel schedules.
   *
   * Separate because a schedule acts in the future, when nobody is watching,
   * and outlives the agent that set it.
   */
  SCHEDULES_WRITE: 'schedules:write',
  /** Create groups and change who is in them, which changes who a later broadcast reaches. */
  GROUPS_WRITE: 'groups:write',
  /**
   * Register agents and mint the invitations that create them.
   *
   * The power to grow the fleet: a leaked key holding this can make more of
   * itself.
   */
  AGENTS_REGISTER: 'agents:register',
  /** Hand third-party credentials to other agents. */
  SECRETS_GRANT: 'secrets:grant',
  /** Spend money. Never implied by anything else. */
  BILLING_SPEND: 'billing:spend',
} as const;

export type Scope = (typeof SCOPES)[keyof typeof SCOPES];

/**
 * Every scope, in a stable order.
 *
 * This is what an existing key is widened to by the migration that introduced
 * enforcement -- not `*`. A wildcard would also grant whatever gets invented
 * next year, and a key minted in 2026 should not silently acquire a capability
 * designed after it. Writing the list down means later additions are opt-in
 * for everybody, including the keys that predate the idea of a scope.
 */
export const ALL_SCOPES: Scope[] = Object.values(SCOPES);

/** What a key gets when nobody says otherwise: enough to be useful, nothing that spends or grants. */
export const DEFAULT_AGENT_SCOPES: Scope[] = [
  SCOPES.MESSAGES_SEND,
  SCOPES.DIRECTORY_READ,
];

export function isScope(value: string): value is Scope {
  return (ALL_SCOPES as string[]).includes(value);
}
