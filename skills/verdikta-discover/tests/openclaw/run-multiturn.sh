#!/bin/bash
# usage: run-multiturn.sh AGENT_ID MSG_DIR OUT_DIR [START]
# Round 7: each case's turns (<ID>.t1.txt, <ID>.t2.txt, ...) are sent in order to ONE fresh session key, so later turns
# see the earlier ones, as in a chat. Replies go to OUT/<ID>-t<n>.json; the trajectory is exported after the last turn.
# START (optional, 0-based) rotates the case list. A session key that already exists is refused (it would continue an
# old conversation). Never passes --deliver. Production use only with the owner's go-ahead; never an injection case.
set -u
A=$1; MSGS=$2; OUT=$3; mkdir -p "$OUT"; OUT=$(cd "$OUT" && pwd)
IDS=($(ls "$MSGS" | sed -n 's/\.t1\.txt$//p' | sort)); N=${#IDS[@]}; START=${4:-0}
USED=$(openclaw sessions --agent "$A" --json --limit all 2>/dev/null | python3 -c 'import json, sys; [print(r.get("key", "")) for r in json.load(sys.stdin).get("sessions", [])]' 2>/dev/null)
tag=$(basename "$OUT")
for ((k = 0; k < N; k++)); do
  id=${IDS[$(( (k + START) % N ))]}; lid=$(echo "$id" | tr A-Z a-z); key="agent:$A:eval-$tag-$lid"
  [ -s "$OUT/$id.export.json" ] && continue
  if grep -qxF "$key" <<<"$USED"; then echo "{\"id\":\"$id\",\"refused\":\"session key already used\"}" >> "$OUT/refused.jsonl"; continue; fi
  for f in $(ls "$MSGS"/"$id".t*.txt | sort); do
    t=$(basename "$f" .txt | sed 's/.*\.t//'); s=$(date +%s.%N)
    timeout 700 openclaw agent --agent "$A" --session-key "$key" --message-file "$f" --json --timeout 600 > "$OUT/$id-t$t.json" 2> "$OUT/$id-t$t.err"
    rc=$?; e=$(date +%s.%N)
    echo "{\"id\":\"$id\",\"turn\":$t,\"rc\":$rc,\"start\":$s,\"end\":$e}" >> "$OUT/timing.jsonl"
  done
  (cd "$OUT" && timeout 150 openclaw sessions export-trajectory --agent "$A" --session-key "$key" --output "$tag-$id" --workspace "$OUT" --json > "$OUT/$id.export.json" 2>&1)
done
echo DONE > "$OUT/DONE"
