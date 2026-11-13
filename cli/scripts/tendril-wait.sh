#!/bin/sh
# tendril-wait.sh - block until a tendril wake event arrives, print it, exit 0.
# POSIX sh + curl only (uses python3 for exact JSON parsing when present).
#
#   TENDRIL_API=https://…/api/t/<id> TENDRIL_TOKEN=tk_… sh tendril-wait.sh [cursor-file]
#
# Run it as a background command; its exit is your wake-up. After handling the
# events, start it again. The cursor (last seen event seq) lives in a file so a
# restart never re-delivers old events; the previous value is kept in <file>.prev.
# Default cursor file: ${XDG_CONFIG_HOME:-$HOME/.config}/tendril/cursors/<id>.cursor
# (the same file the reference CLI uses).
#
# Exit codes: 0 wake events printed (stdout: one summary line, then the JSON
# response), 1 bad config / token rejected / tendril gone,
# 2 TENDRIL_WAIT_MAX seconds passed without a wake (optional).

API=${TENDRIL_API:?set TENDRIL_API}
TOKEN=${TENDRIL_TOKEN:?set TENDRIL_TOKEN}
API=${API%/}
ID=${API##*/}
CURSOR_FILE=${1:-${TENDRIL_CURSOR_FILE:-${XDG_CONFIG_HOME:-$HOME/.config}/tendril/cursors/$ID.cursor}}
MAX=${TENDRIL_WAIT_MAX:-0}

mkdir -p "$(dirname "$CURSOR_FILE")" || exit 1
TMP=$(mktemp "${TMPDIR:-/tmp}/tendril-wait.XXXXXX") || exit 1
trap 'rm -f "$TMP"' EXIT
trap 'exit 130' INT TERM

start=$(date +%s)
backoff=2

have_py=0
[ -z "${TENDRIL_NO_PYTHON:-}" ] && command -v python3 >/dev/null 2>&1 && have_py=1

# Prints: "<timeout 0|1> <cursor> <events> <owner instructions> <withheld>"
parse() {
  if [ "$have_py" = 1 ]; then
    python3 -c '
import json,sys
try:
  r=json.load(open(sys.argv[1]))
except Exception:
  print("x 0 0 0 0"); sys.exit()
ev=r.get("events") or []
own=sum(1 for e in ev if e.get("type")=="instruction" and e.get("role")=="owner")
print(1 if r.get("timeout") else 0, int(r.get("cursor") or 0), len(ev), own, int(r.get("withheld") or 0))
' "$TMP"
  else
    body=$(tr -d '\n\r' < "$TMP")
    case $body in *'"timeout":true'*) t=1 ;; *) t=0 ;; esac
    # Last "cursor": in the body (the server writes it after the events array).
    c=$(printf '%s' "$body" | sed -n 's/.*"cursor":\([0-9][0-9]*\).*/\1/p')
    n=$(printf '%s' "$body" | grep -o '"seq":[0-9]' | wc -l | tr -d ' ')
    o=$(printf '%s' "$body" | grep -o '"type":"instruction"' | wc -l | tr -d ' ')
    w=$(printf '%s' "$body" | sed -n 's/.*"withheld":\([0-9][0-9]*\).*/\1/p')
    echo "$t ${c:-x} ${n:-0} ${o:-0} ${w:-0}"
  fi
}

while :; do
  if [ "$MAX" -gt 0 ] && [ $(( $(date +%s) - start )) -ge "$MAX" ]; then
    echo "tendril: no wake within ${MAX}s"; exit 2
  fi
  after=$(cat "$CURSOR_FILE" 2>/dev/null | tr -dc '0-9')
  [ -n "$after" ] || after=0

  code=$(curl -sS -o "$TMP" -w '%{http_code}' --max-time 45 \
    -H "Authorization: Bearer $TOKEN" "$API/events?after=$after&wait=25" 2>/dev/null)
  [ $? -eq 0 ] || code=000

  case $code in
    200)
      set -- $(parse)
      if [ "$1" = 0 ] && [ "$2" != x ] && [ "$3" -gt 0 ]; then
        echo "$after" > "$CURSOR_FILE.prev"
        echo "$2" > "$CURSOR_FILE"
        echo "tendril: $3 event(s) waiting, $4 owner instruction(s), $5 wake(s) withheld; cursor $after -> $2 (previous kept in $CURSOR_FILE.prev)"
        cat "$TMP"; echo
        exit 0
      fi
      if [ "$1" = x ]; then sleep "$backoff"; backoff=$((backoff * 2)); [ "$backoff" -gt 60 ] && backoff=60; else backoff=2; fi
      ;;
    401|403|404|410)
      echo "tendril: HTTP $code from $API/events (token revoked or tendril deleted)" >&2
      cat "$TMP" >&2 2>/dev/null; echo >&2
      exit 1
      ;;
    *)
      echo "tendril: HTTP $code, retrying in ${backoff}s" >&2
      sleep "$backoff"
      backoff=$((backoff * 2)); [ "$backoff" -gt 60 ] && backoff=60
      ;;
  esac
done
