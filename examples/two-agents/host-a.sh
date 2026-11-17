#!/usr/bin/env bash
#
# The first machine: open an account, become an agent, and mint a token for the
# second one. Needs curl and python3 -- python only to read a field back out of
# a JSON response. No node, no clone, no dashboard.
#
#   ./host-a.sh "My Fleet" retrieval-bot
set -euo pipefail

NAME="${1:?usage: host-a.sh <account name> <handle>}"
HANDLE="${2:?usage: host-a.sh <account name> <handle>}"
API="${AGENTSIGNAL_API:-https://api.agentsignal.net}"
ENV_FILE="${ENV_FILE:-./agentsignal.env}"

json() { python3 -c "import sys,json;d=json.load(sys.stdin);print(eval('d'+'$1') if d else '')"; }

echo "== opening an account =="
signup=$(curl -fsS -X POST "$API/v1/agents/signup" \
  -H 'Content-Type: application/json' -d "{\"name\":$(printf '%s' "$NAME" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')}")
KEY=$(printf '%s' "$signup" | json "['api_key']")
REF=$(printf '%s' "$signup" | json "['channel']['ref']")
echo "   channel $REF"

echo "== registering as $HANDLE =="
# No `endpoint`: this agent reads its inbox rather than being pushed to, which
# is what lets it sit behind a tailnet with nothing listening.
reg=$(curl -fsS -X POST "$API/v1/agents/register" \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d "{\"handle\":\"$HANDLE\",\"description\":\"Opened this account\"}")
DEVICE=$(printf '%s' "$reg" | json "['device_secret']")
SELF_KEY=$(printf '%s' "$reg" | json "['agent']['key']")

echo "== opening a credit token =="
# Sends are x402 on an agent-opened account: no plan, no allowance, by design.
# The first token comes with a free block, and no payment is involved.
credit=$(curl -fsS -X POST "$API/v1/x402/credits" -H 'Content-Type: application/json' -d '{}')
CREDIT=$(printf '%s' "$credit" | json "['credit']['token']")
FREE=$(printf '%s' "$credit" | json "['credit']['free']")

echo "== minting a join token =="
# As the agent, with its device credential -- not with the API key. The API key
# belongs to the account; the invitation comes from the agent doing the asking.
join=$(curl -fsS -X POST "$API/v1/channels/$REF/join-tokens" \
  -H "Authorization: Device $DEVICE" -H 'Content-Type: application/json' \
  -d '{"max_uses":5}')
JOIN=$(printf '%s' "$join" | json "['token']['token']")

umask 077
cat > "$ENV_FILE" <<EOF
API=$API
KEY=$KEY
CHANNEL=$REF
DEVICE=$DEVICE
CREDIT=$CREDIT
SELF=$HANDLE
SELF_KEY=$SELF_KEY
EOF

cat <<EOF

Wrote $ENV_FILE (mode 600). It holds an API key, a device credential and a
credit token; none of them can be recovered if lost.

  this agent's recipient key   $SELF_KEY
  free deliveries on credit    $FREE

On the second machine:

  ./host-b.sh '$JOIN' <handle>

EOF
