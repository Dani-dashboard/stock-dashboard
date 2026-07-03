#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
{
  echo "# Night NGT Check $(date '+%Y-%m-%d %H:%M:%S %Z')"
  echo
  echo "## KIS token"
  npm run kis:token
  echo
  echo "## Current dashboard fetch"
  npm run fetch
  echo
  echo "## NGT candidates"
  echo "H0MFCNT0 KRX night futures trade ticks, example tr_key=101W9000"
  echo "H0MFASP0 KRX night futures asking price, example tr_key=101W9000"
  echo "Next implementation: realtime/websocket approval + subscribe test."
} | tee "logs/scheduled/ngt-check-$(date '+%Y%m%d-%H%M%S').log"
