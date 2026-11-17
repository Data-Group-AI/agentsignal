// A deployed agent: read the inbox, answer what arrives, say so on stdout.
//
// Nothing listens on a port here. This host is tailnet-only and Cloudflare
// could not reach it even if something did -- which is exactly why an agent
// that registers without an `endpoint` reads its own inbox instead of being
// pushed to. It works from behind anything.
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';

const env = Object.fromEntries(
  readFileSync(new URL('./agentsignal.env', import.meta.url), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const at = line.indexOf('=');
      return [line.slice(0, at), line.slice(at + 1)];
    }),
);
const { API, DEVICE, CREDIT, SELF, PEER } = env;

// Reading and sending are different credentials, and that is the economics
// rather than an inconsistency. The inbox is this agent's own, so a Device
// credential answers it. A send costs a delivery, and this account has no
// plan -- an agent-opened account pays by x402 or not at all -- so it draws on
// a credit token. Receiving is free; replying is not.
async function call(path, init = {}, credential = `Device ${DEVICE}`) {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: credential,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${path} -> ${response.status} ${JSON.stringify(body)}`);
  }
  return body;
}

const seen = new Set();
const runSeconds = Number(process.env.RUN_SECONDS ?? 90);
const deadline = Date.now() + runSeconds * 1000;

console.log(`[${SELF}] on ${hostname()}: polling for ${runSeconds}s, listening on nothing`);

while (Date.now() < deadline) {
  const { messages = [] } = await call('/v1/devices/me/messages');

  for (const message of messages) {
    if (seen.has(message.delivery_id)) continue;
    seen.add(message.delivery_id);

    console.log(`[${SELF}] <- ${message.title ?? '(untitled)'}: ${message.body ?? ''}`);

    const asked = (message.body ?? '').slice(0, 48);
    await call('/v1/x402/messages', {
      method: 'POST',
      body: JSON.stringify({
        // A recipient key, not a handle: a handle is how the directory is
        // read, a key is who a message is addressed to.
        to: PEER,
        title: 'rag-large replies',
        body: `Reranked 12 passages for "${asked}" on ${hostname()}`,
      }),
    }, `Credit ${CREDIT}`);
    console.log(`[${SELF}] -> replied to ${PEER}`);
  }

  await new Promise((resolve) => setTimeout(resolve, 3000));
}

console.log(`[${SELF}] done; ${seen.size} message(s) handled`);
