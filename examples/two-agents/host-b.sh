#!/usr/bin/env bash
#
# The second machine: join with the token the first one minted, and open credit
# so this agent can answer. It never sees the account's API key.
#
#   ./host-b.sh "$JOIN_TOKEN" rerank-bot
set -euo pipefail

JOIN="${1:?usage: host-b.sh <join token> <handle>}"
HANDLE="${2:?usage: host-b.sh <join token> <handle>}"
API="${AGENTSIGNAL_API:-https://api.agentsignal.net}"
ENV_FILE="${ENV_FILE:-./agentsignal.env}"

json() { python3 -c "import sys,json;d=json.load(sys.stdin);print(eval('d'+'$1') if d else '')"; }

echo "== joining as $HANDLE =="
reg=$(curl -fsS -X POST "$API/v1/agents/register" \
  -H "Authorization: Join $JOIN" -H 'Content-Type: application/json' \
  -d "{\"handle\":\"$HANDLE\",\"description\":\"Joined with a token\"}")
DEVICE=$(printf '%s' "$reg" | json "['device_secret']")
SELF_KEY=$(printf '%s' "$reg" | json "['agent']['key']")

echo "== opening a credit token =="
# Its own, not the other machine's. Each agent pays for what it sends, and a
# credit token is the only thing an agent-opened account can pay with.
credit=$(curl -fsS -X POST "$API/v1/x402/credits" -H 'Content-Type: application/json' -d '{}')
CREDIT=$(printf '%s' "$credit" | json "['credit']['token']")

umask 077
cat > "$ENV_FILE" <<EOF
API=$API
DEVICE=$DEVICE
CREDIT=$CREDIT
SELF=$HANDLE
SELF_KEY=$SELF_KEY
PEER=
EOF

cat <<EOF

Wrote $ENV_FILE (mode 600).

  this agent's recipient key   $SELF_KEY

Put the FIRST machine's recipient key in PEER= in that file, then:

  node agent.mjs

and send to $SELF_KEY from the other side.
EOF
