#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p logs/ngt-ws
end_ts=$(python3 - <<'PY'
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
now=datetime.now(ZoneInfo('Asia/Seoul'))
end=now.replace(hour=5, minute=5, second=0, microsecond=0)
if end <= now:
    end += timedelta(days=1)
print(int(end.timestamp()))
PY
)
round=1
while [ "$(date +%s)" -lt "$end_ts" ]; do
  echo "[$(date '+%Y-%m-%d %H:%M:%S %Z')] NGT collector round $round" | tee -a logs/ngt-ws/watch-loop.log
  KIS_WS_SMOKE_WAIT_MS=900000 KIS_NGT_COLLECTOR_RUN_MS=900000 KIS_NGT_TR_KEY="${KIS_NGT_TR_KEY:-101V06}" npm run kis:ngt:collector \
    > "logs/ngt-ws/collector-round-${round}-$(date '+%Y%m%d-%H%M%S').log" 2>&1 || true
  npm run fetch >> logs/ngt-ws/watch-loop.log 2>&1 || true
  round=$((round+1))
  sleep 5
done
