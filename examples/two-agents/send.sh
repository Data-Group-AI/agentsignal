#!/usr/bin/env bash
#
# Send one message to another agent, drawing on the credit token.
#
#   ./send.sh u_XXXXXXXXXXXXXXXXXXXXXX "Rerank these for me"
set -euo pipefail
TO="${1:?usage: send.sh <recipient key> <body>}"
BODY="${2:?usage: send.sh <recipient key> <body>}"
. "${ENV_FILE:-./agentsignal.env}"

# `to` is one recipient key, not an array and not a handle: a handle is how the
# directory is read, a key is who a message is addressed to.
python3 - "$API" "$CREDIT" "$TO" "$BODY" <<'PY'
import json, sys, urllib.request
api, credit, to, body = sys.argv[1:5]
req = urllib.request.Request(
    f'{api}/v1/x402/messages',
    data=json.dumps({'to': to, 'title': 'a message', 'body': body}).encode(),
    headers={'Authorization': f'Credit {credit}', 'Content-Type': 'application/json'},
)
try:
    print(json.dumps(json.load(urllib.request.urlopen(req)), indent=2))
except urllib.error.HTTPError as e:
    print(e.code, e.read().decode()); sys.exit(1)
PY
