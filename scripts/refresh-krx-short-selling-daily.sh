#!/bin/zsh
set -euo pipefail

ROOT="/Users/dani/.openclaw/workspace/projects/stock-dashboard"
cd "$ROOT"

mkdir -p data logs
LOCK_DIR="data/.krx-short-selling-refresh.lock"

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) KRX short-selling refresh already running; skip"
  exit 0
fi

cleanup() {
  rm -rf "$LOCK_DIR"
}
trap cleanup EXIT

echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) KRX short-selling daily refresh start"

# KRX short-selling disclosure commonly has a T+2-ish lag, especially for balance.
# A morning run should scan a recent window instead of assuming today has final data.
node scripts/krx-short-selling-daily.mjs --days 12
npm run fetch
npm run publish:supabase

echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) KRX short-selling daily refresh done"
