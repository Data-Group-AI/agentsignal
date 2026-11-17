> **Public client mirror.** This repository holds the AgentSignal client packages
> (`@agentsignalnet/core`, `sdk`, `cli`, `mcp`), examples and integration docs.
> The hosted service — API, dashboard, dispatch, billing — runs at
> [agentsignal.net](https://agentsignal.net) and is not part of this mirror.
> Issues and PRs welcome here.

<img src="apps/web/public/brand/mark-signal.svg" alt="" width="52" height="52">

# AgentSignal

Push notifications for agents. Deliver a short, high-signal message to a specific human's
devices, right now — from a script, a cron job, or an autonomous agent.

```bash
curl --request POST \
  --url https://api.agentsignal.net/v1/messages \
  --header 'Authorization: Bearer <api key>' \
  --header 'Content-Type: application/json' \
  --data '{
    "to":"<recipient key>",
    "title":"Deploy finished",
    "body":"prod is green",
    "priority":1}'
```

## Why

Pushover solved this for humans in 2011 and has barely moved since. AgentSignal targets the
same job for a world where the sender is usually a machine:

- **Agent-native** — REST that's one `curl` away, plus an MCP server, TypeScript SDK, and CLI.
  Idempotency keys mean a retrying agent can't double-notify.
- **No seat restrictions** — pricing is notification volume only. Invite the whole team,
  register as many devices as you want.
- **Sandboxes** — throwaway projects that are auto-purged, so an agent can be exercised
  and the whole thing deleted with nothing retained. Deliveries count against quota.
- **Easy setup and takedown** — create a channel, a person, and a device enrollment in one call.
  Delete all of it in one call, with no retention.
- **White-labeling** — per-channel name, icon, accent color, and sound on the notification itself.
- **Scheduling** — one-off and recurring sends, described in plain language ("every weekday
  at 09:00") with an explicit timezone, or as cron if you'd rather. Preview the next runs
  before you commit to them.
- **x402** — an agent with a wallet and no account can pay per notification over HTTP 402.

## Pricing

| Plan | Deliveries / month | Price |
|---|---|---|
| Free | 1,000 | $0 |
| Starter | 10,000 | $5/mo |
| Growth | 100,000 | $10/mo |
| Max | 1,000,000 | $50/mo |
| Pay as you go | Per delivery, USDC on Base | x402 |

A delivery is one message reaching one device.

## Architecture

Supabase is the database. Cloudflare Workers is everything else.

| | |
|---|---|
| `apps/api` | Cloudflare Worker (Hono). The API: ingest, dispatch, rate limiting, x402. |
| `apps/web` | Next.js on Workers via OpenNext. Marketing, docs, dashboard. |
| `apps/apple` | SwiftUI multiplatform client for iOS and macOS. |
| `packages/core` | Shared types and Zod schemas. |
| `packages/sdk` | `@agentsignalnet/sdk` — typed client whose retries can't double-notify. |
| `packages/cli` | `agentsignal` — send from a terminal or a shell script. |
| `packages/mcp` | `@agentsignalnet/mcp` — notify a human, or ask one and block until they answer. |
| `services/push` | The doorbell. Holds an SSE socket per agent so a message arrives without being asked for. Carries no message — only "look again". |
| `services/pilot-bridge` | A box with a UDP socket, because a Worker has none. Puts us on the Pilot overlay. Deployed at `pilot.agentsignal.net`. |
| `supabase/` | Schema, RLS policies, and the SQL that carries the ingest hot path. |

Delivery is inline at ingest — APNs is called during the request, so the normal path is
sub-second. Cloudflare Queues handle retries, and a Durable Object alarm drives
emergency-priority re-alerts until a human acknowledges.

An agent receives in one of three ways, and the default is the humblest one.
It **polls** `/v1/devices/me/messages`, which needs no inbound address and
works from behind anything. A **doorbell** makes that prompt rather than
periodic: the agent holds an outbound SSE connection and is told to look, which
is why the poll underneath it is a slow safety net rather than the mechanism.
Or, if the agent is already a service with a hostname of its own, it registers
an **endpoint** and is POSTed at directly — see
[hosting an endpoint](docs/hosting-an-endpoint.md), which is also where the
signature you must verify is specified.

None of the three replaces the delivery row. The message is written to Postgres
first either way; the transport only decides how long it sits there unseen.

Platform support ships Apple first (iPhone, iPad, Mac), then Android, then Linux and Windows.

## Agent orchestration onboarding

Set up human and company orchestration agents with direct recipient-key
communication in one pass with:

- [Agent and human orchestration setup](docs/agent-orchestration-setup.md)

## Development

Requires Node 22+, pnpm, the Supabase CLI, and Xcode 26 for the Apple client.

```bash
pnpm install
supabase start          # local Postgres, Auth, and Realtime
supabase db reset       # apply migrations and seed
pnpm dev:api            # wrangler dev on :8787
pnpm dev:web            # next dev on :3000
```

Copy `apps/api/.dev.vars.example` to `apps/api/.dev.vars` and
`apps/web/.env.example` to `apps/web/.env.local`, then fill them in.

### Using the MCP server

```json
{
  "mcpServers": {
    "agentsignal": {
      "command": "npx",
      "args": ["-y", "@agentsignalnet/mcp"],
      "env": { "AGENTSIGNAL_API_KEY": "as_test_…" }
    }
  }
}
```

Paste that into `.mcp.json`, `~/.claude.json`, or `claude_desktop_config.json`.
A sandbox key (`as_test_…`) is the one to develop against: its history is
disposable and swept on a TTL. It is not a second budget — sandbox deliveries
count against the same monthly ceiling as live ones, and overage never applies
to them, so a sandbox is a hard stop rather than a cheaper way to send. For
Claude Code there is a plugin in `plugins/agentsignal` that asks for the
credentials rather than having them sit in a config file.

Which tools appear depends on what is in that `env` block: the server registers
only the ones the credentials can actually use, so an API key, a join token,
and neither are three different toolsets.

#### Against local changes

`npx` fetches the published server. To run the one in this checkout instead:

```bash
pnpm run mcp:local
```

That builds the packages and prints the same `mcpServers` block, with an
absolute path to the build in place of the `npx` invocation, ready to paste
into any of the same files. `AGENTSIGNAL_API_KEY` from your shell is used if it
is set; otherwise the placeholder is a sandbox key.

Two things worth knowing. It points at the **build**, not the source, so rerun
it after changing anything under `packages/` — nothing is watching. And it talks
to production unless told otherwise: put `AGENTSIGNAL_BASE_URL` in that `env`
block, `http://localhost:8787` while `pnpm dev:api` is running, or the first
thing an agent under development does is page somebody real.

The CLI is `npx -y @agentsignalnet/cli`, or from the checkout without being
installed:

```bash
node packages/cli/dist/index.js send --to u_8fk2… "prod is green"
```

## License

Proprietary. © Data Group AI.
