#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

mkdir -p logs data
pidfile="logs/market-intelligence-observe.pid"
log_prefix="[market-intelligence-observe]"

if [[ -f "$pidfile" ]]; then
  old_pid="$(cat "$pidfile" 2>/dev/null || true)"
  if [[ -n "${old_pid:-}" ]] && kill -0 "$old_pid" 2>/dev/null; then
    echo "$log_prefix already running pid=$old_pid"
    exit 0
  fi
fi

echo $$ > "$pidfile"
cleanup() { rm -f "$pidfile"; }
trap cleanup EXIT INT TERM

last_bucket=""
echo "$log_prefix start pid=$$ at $(date -u '+%Y-%m-%dT%H:%M:%SZ')"

npm run mi:migrate

while true; do
  started_at="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  echo "$log_prefix tick $started_at"

  npm run mi:ingest || true

  bucket="$(node - <<'NODE'
const d = new Date();
d.setUTCSeconds(0, 0);
d.setUTCMinutes(Math.floor(d.getUTCMinutes() / 10) * 10);
console.log(d.toISOString());
NODE
)"

  if [[ "$bucket" != "$last_bucket" ]]; then
    echo "$log_prefix compute bucket=$bucket"
    npm run mi:features || true
    npm run mi:state || true
    npm run mi:export || true
    last_bucket="$bucket"
  fi

  sleep 60
done
