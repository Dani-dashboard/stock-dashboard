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

# KRX sometimes opens the latest EOD endpoint later than the cash close.
# At dawn, "today" is usually not the right EOD target yet, so scan recent KST
# dates backwards and only write when a newer official-ok date is found. This
# keeps the dashboard from overwriting or artificially refreshing the last valid
# official cache with empty/no-signal responses.
DATES=(${(@f)$(node --input-type=module - <<'NODE'
const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' });
const now = new Date();
for (let i = 0; i < 7; i += 1) {
  const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
  console.log(fmt.format(d).replace(/-/g, ''));
}
NODE
)})

EXISTING_BAS_DD=$(node --input-type=module - <<'NODE'
import fs from 'node:fs';
try {
  const payload = JSON.parse(fs.readFileSync('data/kospi200-pcr-krx-eod.json', 'utf8'));
  console.log(payload.basDd || '');
} catch { console.log(''); }
NODE
)

for BAS_DD in $DATES; do
  PROBE_OUTPUT=$(node scripts/krx-kospi200-pcr-reconcile.mjs --date "$BAS_DD" --no-write || true)
  echo "$PROBE_OUTPUT"
  STATUS=$(PROBE_JSON="$PROBE_OUTPUT" node -e 'try { console.log(JSON.parse(process.env.PROBE_JSON).status || ""); } catch { console.log(""); }')
  if [[ "$STATUS" == "ok" ]]; then
    if [[ "$BAS_DD" == "$EXISTING_BAS_DD" ]]; then
      echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) KRX PCR EOD already current at $BAS_DD; keep existing cache timestamp"
    else
      node scripts/krx-kospi200-pcr-reconcile.mjs --date "$BAS_DD" --write-ok-only
    fi
    break
  fi
done

npm run fetch
npm run publish:supabase

echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) KRX PCR EOD refresh done"
