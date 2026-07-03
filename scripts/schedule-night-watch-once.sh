#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# Avoid duplicate KIS websocket appkey sessions.
pkill -f 'node scripts/kis-ngt-collector.mjs' 2>/dev/null || true
python3 - <<'PY' > /tmp/stock-dashboard-night-delay
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
now=datetime.now(ZoneInfo('Asia/Seoul'))
target=now.replace(hour=18, minute=5, second=0, microsecond=0)
if target <= now:
    target += timedelta(days=1)
print(max(0, int((target-now).total_seconds())))
PY
delay=$(cat /tmp/stock-dashboard-night-delay)
echo "[$(date '+%Y-%m-%d %H:%M:%S %Z')] sleeping ${delay}s until night watch"
sleep "$delay"
./scripts/night-futures-watch-loop.sh
