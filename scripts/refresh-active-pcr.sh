#!/bin/zsh
set -euo pipefail

ROOT="/Users/dani/.openclaw/workspace/projects/stock-dashboard"
cd "$ROOT"

mkdir -p data logs
LOCK_DIR="data/.pcr-active-refresh.lock"

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) active PCR refresh already running; skip"
  exit 0
fi

cleanup() {
  rm -rf "$LOCK_DIR"
}
trap cleanup EXIT

export KIS_MODE="${KIS_MODE:-prod}"

echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) active PCR refresh start"
npm run kis:pcr:probe -- --active --expiry-count 1 --strikes-around 5 --delay-ms 1600
npm run fetch
npm run publish:supabase
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) active PCR refresh done"
