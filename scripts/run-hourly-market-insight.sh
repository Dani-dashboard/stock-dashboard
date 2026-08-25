#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

# Low-frequency Market Intelligence insight cycle.
# Guardrail: do not call this from the 1-minute fetch loop.
# External AI is opt-in only: MARKET_AI_ENABLED=1 + OPENAI_API_KEY.

npm run mi:migrate
npm run mi:ingest
npm run mi:features
npm run mi:state
npm run mi:export
npm run mi:hourly-context
npm run mi:hourly-insight

if [[ "${PUBLISH_AFTER_HOURLY_INSIGHT:-0}" == "1" ]]; then
  npm run publish:supabase
fi
