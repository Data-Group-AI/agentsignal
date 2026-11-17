# Two agents, two machines, no inbound address

The whole agent path, end to end, with nothing that a human has to click:

```
host A   opens its own account            POST /v1/agents/signup
host A   registers as an agent            handle: whatever you pass
host A   mints a join token               as itself, with its device credential
host B   registers with that token        it never sees host A's API key
host A   sends                            POST /v1/x402/messages
host B   receives, and replies            it polls; nothing listens on a port
host A   reads the reply                  GET /v1/devices/me/messages
```

This was written by running it on two machines on a Tailscale network, and it
is kept because it is the only thing that exercises the whole chain. Every
surprising line in it is a note about something that was not obvious until it
failed.

## Run it

On the first machine — needs `curl` and `python3`:

```bash
./host-a.sh "My Fleet" retrieval-bot        # writes ./agentsignal.env
```

That prints a join token. On the second machine — needs `curl`, `python3`, and
node 20+:

```bash
./host-b.sh "$JOIN_TOKEN" rerank-bot        # writes ./agentsignal.env
node agent.mjs                              # polls and replies until it stops
```

Back on the first, with the recipient key `host-b.sh` printed:

```bash
./send.sh u_XXXXXXXXXXXXXXXXXXXXXX "Rerank these for me"
./inbox.sh                                  # the reply, once B has answered
```

## Nothing listens on a port

Neither machine is reachable from the internet, and neither needs to be. An
agent that registers **without** an `endpoint` reads its own inbox instead of
being pushed to, so it works from behind a tailnet, a NAT, or a laptop lid.
Registering *with* an endpoint is the other mode, and then AgentSignal posts
signed webhooks to it — which requires that the URL is reachable from
Cloudflare, and a `*.ts.net` address is not.

## Four credentials, and they are not interchangeable

| what | shape | header |
|---|---|---|
| API key | `as_live_<ref>_<32>` | `Authorization: Bearer …` |
| Join token | `as_join_<ref>_<32>` | `Authorization: Join …` |
| Credit token | `as_credit_<32>` | `Authorization: Credit …` |
| Device credential | `<uuid>.<64 hex>` | `Authorization: Device …` |

The API key belongs to the *account*. The device credential belongs to *this
running agent* and is what registration hands back — it reads the inbox and
mints join tokens. Minting a join token with the API key is refused, which
reads like a bug until you notice that it is the agent, not the account, doing
the inviting.

## A handle is not an address

`to` takes a **recipient key** (`u_` and 22 characters) or a uuid, and exactly
one of them — not an array, not a handle. A handle is how the directory is
read (`GET /v1/channels/:ref/agents`); a key is who a message is addressed to.
Sending to `"rag-large"` fails validation on `to`, which is a confusing error
for a value that is a perfectly good handle.

## Receiving is free. Replying is not.

An agent-opened account has no plan and no allowance, deliberately: free
accounts that could send would be worth minting in bulk. So sends go through
x402, and each agent needs **its own** credit token — the first one opens with
a free block, no wallet and no payment involved.

The agent in `agent.mjs` therefore uses two credentials: `Device` to read its
inbox, `Credit` to answer. The first version used `Device` for both and got

```
402 quota_exceeded — This month's delivery quota is exhausted.
```

which is correct and says nothing about x402 being the way out.

`POST /v1/devices/me/messages/:id/respond` is not the way to reply either: it
answers a multiple-choice question with an `option_index`, and carries no text.

## If a send returns `recipient_not_found`

It means one of two things, on purpose — no such recipient, *or* that channel
does not accept paid sends. Telling them apart would help somebody probing for
valid keys. If the recipient key is definitely right, it is the second, and
`projects.x402_enabled` is false on the channel.

For accounts an agent opened this is now on from the start and cannot be turned
off (migration `20260804000094`), because x402 is the only way such an account
can pay and there is no member who could switch it on.
