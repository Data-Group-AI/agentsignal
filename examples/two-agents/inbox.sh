#!/usr/bin/env bash
#
# What has arrived for this agent. Reading is free and needs no inbound
# address: the agent asks, rather than being pushed to.
set -euo pipefail
. "${ENV_FILE:-./agentsignal.env}"
curl -fsS "$API/v1/devices/me/messages" -H "Authorization: Device $DEVICE" \
  | python3 -c "
import sys, json
messages = json.load(sys.stdin).get('messages', [])
for m in messages:
    mark = ' ' if m.get('read_at') else '*'
    print(f\"{mark} {m.get('title')}: {m.get('body')}\")
print(f'({len(messages)} in the inbox)')
"
