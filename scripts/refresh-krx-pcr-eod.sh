#!/bin/zsh
set -euo pipefail

ROOT="/Users/dani/.openclaw/workspace/projects/stock-dashboard"
cd "$ROOT"

mkdir -p data logs
LOCK_DIR="data/.krx-pcr-eod-refresh.lock"

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) KRX PCR EOD refresh already running; skip"
  exit 0
fi

cleanup() {
  rm -rf "$LOCK_DIR"
}
trap cleanup EXIT

echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) KRX PCR EOD refresh start"

# KRX sometimes opens the current-day EOD endpoint later than the cash close.
# Do not overwrite the last valid official cache with an empty/no-signal response.
node scripts/krx-kospi200-pcr-reconcile.mjs --write-ok-only || true

npm run fetch
npm run publish:supabase

echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) KRX PCR EOD refresh done"
