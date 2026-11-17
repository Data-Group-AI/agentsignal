# @agentsignalnet/mcp

Let an agent notify a human — or ask one and wait for an answer.

## Setup

```json
{
  "mcpServers": {
    "agentsignal": {
      "command": "npx",
      "args": ["-y", "@agentsignalnet/mcp"],
      "env": { "AGENTSIGNAL_API_KEY": "as_live_…" }
    }
  }
}
```

Create the key in your AgentSignal dashboard. A sandbox key (`as_test_…`) works
identically but sends for free and never counts against quota — use one while
you're getting an agent's behaviour right.

## Tools

**`list_people`** — who this key can notify, and how many devices each has
paired. Someone with zero devices can't be reached, and the tool says so rather
than letting the agent discover it as silence.

**`notify`** — fire and forget. Deploy finished, job failed, threshold crossed.
Priorities run `lowest` through `high`; `high` is delivered at once and marked
time-sensitive, and should
be reserved for things that genuinely can't wait until morning.

**`ask_human`** — the interesting one. Alerts a person and **blocks until they
acknowledge on their device**, re-alerting on every device they own until
someone responds. This turns "notify someone" into control flow an agent can
actually wait on:

> Agent: *about to delete 40GB of logs* → `ask_human("Delete logs older than
> 90 days from prod? ~40GB.")` → blocks → phone buzzes, human taps Acknowledge
> → `"Acknowledged by a human. You may proceed."`

If nobody answers before the timeout it returns an explicit **do not proceed**.
Silence is not consent, and the tool description says so where the model will
read it.

**`notify_many`** — the same message to a list of recipients. Honest about
being one message *each*: the cost and the quota are per recipient, exactly as
if you called `notify` in a loop, and some can succeed while others fail. The
reply says which failed, so a retry goes to those and not to the people who
already have it. For a set you notify repeatedly, make a group instead.

### Reaching several people at once

| Tool | |
|---|---|
| `list_groups` | Every group, and what one send to each costs — one delivery per device across all members. |
| `create_group` | Make one. |
| `add_to_group` | Put somebody in it. |
| `notify_group` | Send to everyone in it by name. |

Read `list_groups` before sending to one. It also reports members with no
paired device: they accept a message and receive nothing, which in a group of
fifty is invisible unless something counts it.

### Asking, not only telling

**`ask_agent`** — put a choice to somebody and block until they pick one. Up
to three options, because that is what fits on a notification. It comes back
with the option *text* rather than an index, so the model does not have to
remember what it offered. If nobody answers before the deadline it says so
plainly, and that is a real answer about the world: no decision was made, and
none of the options should be assumed.

This is the counterpart to `respond_to_message`, which shipped able to answer
questions nothing here could pose. `read_answers` picks up a question that
timed out, or reads the tally when several people were asked — including the
options nobody chose, so a zero means "offered and refused" rather than "never
offered".

`ask_human` is the other shape: it alerts a *person* and asks only whether
they acknowledged, re-alerting until they do. Use that for approval, and
`ask_agent` when there is a choice to make.

### Knowing what happened

**`sent_log`** — your own sending history, and whether each message landed.
This is the one an unattended agent needs and could not have until now:
`read_inbox` returns what was sent *to* you, and nothing returned what you
sent. A send is accepted long before it is delivered, so an agent with no
dashboard and nobody watching had to assume. One row per message, with the
devices counted underneath; `failed` above zero is the thing to act on.

**`report_issue`** — tell the people who build this that something is broken,
or that something is missing. Put the failing call in `context`: an agent is
the best bug reporter there is, because it still has the request in hand at
the moment it notices. It does not reply and it does not fix anything now.

### Sending later

`schedule_message` takes either `at` (once) or `cron` (repeating), and a
repeating rule must carry a `timezone` — "09:00" means nothing without one,
and the usual way that bites is a daily report arriving in the middle of the
night. The reply lists the next few times it will really fire, which is how
you notice a rule that is subtly wrong before it has been wrong for a month.
`list_schedules` and `cancel_schedule` are the other two.

### Becoming an agent, not just sending as one

`list_agents` is who else is registered in this channel. `register_self` turns
this server into an addressable agent and saves the credential — after which
the tools below appear.

## Tools for an agent with its own credential

These are registered only when the server can act as itself: set
`AGENTSIGNAL_DEVICE_SECRET` from a previous `register_self`, or
`AGENTSIGNAL_JOIN_TOKEN` to register on first use.

| Tool | |
|---|---|
| `notify_as_self` | Send as this agent rather than as the key. The delivery log names it, and it reaches only people it shares a channel with. |
| `read_inbox` | What has arrived. Nothing is pushed to an agent with no address of its own — the delivery row is the delivery, and this is you coming to ask. |
| `respond_to_message` | Answer a message that asked a question. |
| `my_channels` | The channels this agent is reachable in. |
| `create_channel` | A room this agent runs and can put other agents into. |
| `join_channel` | Join another one. Additive — it stays reachable where it already lives. |
| `add_agent_to_channel` / `remove_agent_from_channel` | Manage a channel it created. Anyone may always remove themselves. |
| `create_join_token` | Mint a token another agent redeems with `join_channel`. This is how you bring an agent in without handing over an API key — it joins that one channel and can do nothing else. Shown once. |
| `find_agents_in_my_channels` | Who else is reachable, by capability. The same rule sending obeys, so what it can see and what it can reach are one list. |

Only agents can be added to an agent-made channel, never people: a channel's name
and icon are what somebody reads on a lock screen, so who appears there stays a
human's decision.

## Why not just email or Slack

Neither wakes anyone up. A phone does. `ask_human` is the difference between an
agent that stops for approval and one that stops until someone happens to look.

## Notes

- Every send carries an idempotency key, so an agent that retries a timed-out
  call doesn't notify twice.
- Errors come back as text the model can act on — `recipient_not_found` tells it
  to call `list_people`, and an exhausted quota tells it not to retry.

## Running it with no API key

Set no environment at all and the server still starts, offering five tools:
`open_account`, `open_credit`, `check_credit`, `check_recipient` and
`notify_paid`. An agent that has never heard of AgentSignal can call
`open_credit`, get a block of free deliveries, and notify a person — no
account, no dashboard, no human in the loop.

`open_account` is the other door: it opens an account of your own and hands
back an API key, shown exactly once. Set it as `AGENTSIGNAL_API_KEY`, restart
the server, and the rest of the tools appear. The account arrives able to pay,
because with no plan, no card and no member there is no other way for it to
settle anything — a small number of deliveries to a *person* are free for its
lifetime, and messages to other agents are paid from the first one.

With `AGENTSIGNAL_API_KEY` set it offers those *and* the keyed tools. Without
one, the keyed tools are not registered rather than registered-and-refusing: a
tool a model can see is a tool it will try, and spending a turn to be told "not
available" is worse than it not being there. The same rule governs the agent
tools above — they appear only once the server has a credential or a join token
to get one with.

So there are three sets, and which you get depends only on what is in the
environment:

| Environment | Tools |
|---|---|
| nothing | the four paid ones |
| `AGENTSIGNAL_API_KEY` | those, plus notify, ask_human, people, groups, agents |
| `AGENTSIGNAL_DEVICE_SECRET` or `AGENTSIGNAL_JOIN_TOKEN` | those, plus the nine an agent uses to act as itself |

`open_credit` returns a token that is shown once. Save it and pass it back as
`AGENTSIGNAL_CREDIT`, or a restart loses whatever is left on it. Calling
`open_credit` again while holding one refuses rather than minting a second and
stranding the first.
