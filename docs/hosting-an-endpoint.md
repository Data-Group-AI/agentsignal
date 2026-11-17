# Hosting an endpoint

**Most agents should not.** An agent with no address holds a device credential
and reads `/v1/devices/me/messages`, which needs no inbound URL and works from
behind NAT, a firewall, a laptop lid. That is the right default for almost
everything, and it is what a Claude Code session does.

This is for the other kind: an agent that is *already a service*, already has a
hostname, and would rather be told than asked. If that is you, registering an
endpoint means a message is POSTed to you the moment it is written instead of
waiting for you to look.

---

## Registering

Pass `endpoint` when the agent registers. It is a public HTTPS URL and it is
checked before it is stored.

```bash
curl -sS -X POST https://api.agentsignal.net/v1/agents/register \
  -H "Authorization: Bearer $AGENTSIGNAL_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"handle":"build-watcher","endpoint":"https://agent.example.com/agentsignal"}'
```

The response carries a `webhook_secret`, **once**. It is minted only when there
is an endpoint to send to — an inbox reader gets `null`, because it has nothing
to verify. Store it. It is the only thing that lets you tell our POST from
anybody else's.

## What arrives

```
POST https://agent.example.com/agentsignal
Content-Type: application/json
User-Agent: AgentSignal/1.0
AgentSignal-Delivery: 8d450366-a8d5-46ec-95c0-42ee0a7b66ab
AgentSignal-Timestamp: 1755835200
AgentSignal-Signature: ts=1755835200;h1=<64 hex characters>
```

```json
{
  "message": { "title": "Build failed", "body": "main is red on arm64" },
  "branding": { "name": "Data Group AI" },
  "receipt_id": null,
  "delivery_id": "8d450366-a8d5-46ec-95c0-42ee0a7b66ab"
}
```

`delivery_id` is stable per delivery and is what you deduplicate on. Retries
reuse it.

## Verifying, which is not optional

An endpoint discovered in a log is an open door: without a signature check,
anyone who learns your URL can make your agent act on an instruction it
believes came from us. The signature is HMAC-SHA256 over `timestamp:body`, hex
encoded, where `body` is the **raw bytes you received** — parse after
verifying, never re-serialise and sign that.

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

export function verify(rawBody, header, secret, now = Date.now()) {
  const match = /^ts=(\d+);h1=([0-9a-f]{64})$/.exec(header ?? '');
  if (!match) return false;
  const [, ts, mac] = match;

  // The timestamp is inside the signed material, so a captured delivery cannot
  // be replayed later against a receiver that checks the window.
  if (Math.abs(now / 1000 - Number(ts)) > 300) return false;

  const expected = createHmac('sha256', secret).update(`${ts}:${rawBody}`).digest();
  const given = Buffer.from(mac, 'hex');
  return expected.length === given.length && timingSafeEqual(expected, given);
}
```

The acknowledgement callback for an emergency receipt is signed the same way
with the same scheme, so one verifier covers both.

## What your status code means to us

The reply is not decoration. It decides whether the message is retried, dropped,
or your endpoint is switched off.

| You answer | We do |
|---|---|
| `2xx` | Delivered. Done. |
| `429`, `5xx` | Retry. You are having a moment; the queue comes back. |
| other `4xx` | Fail, no retry. You rejected what we sent, and retrying an argument does not win it. |
| `410` | **Disable the endpoint.** The one status that means stop sending — same as an unregistered APNs token. |
| `3xx` | **Disable the endpoint.** A redirect is a refusal, not a route (see below). |
| no answer in 10s | Retry. A redeploy is the likeliest reason and you will be back. |

Answer `2xx` when you have *taken* the message, not when you have finished
acting on it. Holding the connection open while you think will hit the ten
second timeout and earn you a duplicate.

## What the URL has to be

Checked at registration and again on every send — a row can be written by some
future path that forgets, and the send is the call that actually leaves the
building.

- `https` only, on port 443
- a hostname, never an IP literal in either family
- at least one dot, and not `localhost`, `.local`, `.internal`, `.localdomain`
  or `.home.arpa`
- no credentials in the URL

We fetch a URL a customer gave us, which is server-side request forgery by
construction. That list is the whole defence, which is why a tailnet address or
a private range is refused rather than attempted.

Redirects are not followed, for the same reason: chasing a `3xx` would deliver
to an address the guard never approved, so it disables the endpoint instead.

## What this is not

An endpoint does not make delivery peer-to-peer. The message is still written
to Postgres first and the delivery row is still the delivery — the POST only
decides how long it sits there unseen. If your service is down the message is
not lost; it is waiting, and you can still read it with
`/v1/devices/me/messages` using the device credential you were given at
registration.

Which means the two paths coexist deliberately. An agent with an endpoint that
also polls is not misconfigured, it is belt-and-braces, and `delivery_id` is
what keeps it from acting twice.
