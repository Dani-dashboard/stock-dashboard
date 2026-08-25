# Hourly AI Insight Layer

Status: OpenClaw-managed insight path implemented  
Date: 2026-08-25 KST

## Goal

Add a low-frequency interpretation layer above the 10-minute CPU Market Intelligence panel.

It should answer:

- 지금 시장 상태를 한 문장으로 보면 무엇인가?
- 어떤 요인이 우호/부담으로 작동 중인가?
- 다음 1시간 동안 무엇을 확인해야 하나?
- 현재 판단이 틀렸다고 볼 조건은 무엇인가?

## Guardrails

- The 1-minute fetch/publish path remains deterministic and AI-free.
- The 10-minute regime/score engine remains deterministic CPU logic.
- AI may summarize only the prepared hourly context.
- AI must not recalculate scores, override source quality, or create unseen data.
- Default production direction is **OpenClaw-managed**: 또또봇 reads `data/hourly-context.json`, writes `data/hourly-ai-insight.json`, and persists it.
- External OpenAI API remains optional only. It is not required for the default workflow.
- If no OpenClaw/AI summary is available, `scripts/hourly-ai-insight.mjs` can still write a deterministic fallback so the UI contract remains stable.

## Default OpenClaw-managed flow

```text
npm run mi:ingest
  -> npm run mi:features
  -> npm run mi:state
  -> npm run mi:export
  -> npm run mi:hourly-context
  -> 또또봇/OpenClaw writes data/hourly-ai-insight.json
  -> npm run mi:persist-hourly-insight
  -> npm run publish:supabase
```

Recommended cadence:

- observation ingest: after each successful 1-minute `fetch`, or at least during active market windows.
- feature/state/export: every 10 minutes.
- hourly context/insight: at most once per hour during relevant market windows, or on user request/heartbeat.

## Files

- `scripts/hourly-context-builder.mjs`
  - Reads SQLite `market_state_10m`, `market_features_10m`, recent observations, `latest.json`, and `events.json`.
  - Writes `data/hourly-context.json`.
  - Persists the same context into `hourly_context`.

- `scripts/persist-hourly-insight.mjs`
  - Validates `data/hourly-ai-insight.json`.
  - Persists the OpenClaw-written insight into `hourly_ai_insight`.

- `scripts/hourly-ai-insight.mjs`
  - Optional external-API/fallback script.
  - If `MARKET_AI_ENABLED=1` and `OPENAI_API_KEY` exist, can call OpenAI Chat Completions for strict JSON.
  - Otherwise writes a deterministic fallback summary.
  - This is no longer the preferred default path unless Dani explicitly wants external API automation.

- `index.html`
  - Loads optional `hourly-ai-insight.json`.
  - Shows `시간별 시장 인사이트` above the 10-minute CPU panel during the Korea MI window.

- `scripts/publish-supabase-storage.mjs`
  - Publishes optional `hourly-context.json` and `hourly-ai-insight.json`.
  - Masks hourly insight outside the Korea MI display window, same as `market-state-10m.json`.

## Insight JSON contract

```json
{
  "title": "상승 반등은 있지만 수급 확인이 약한 구간",
  "stance": "선별적 관찰",
  "sessionPhase": "kr_morning",
  "summaryBullets": ["..."],
  "baseCase": "...",
  "watchTriggers": ["..."],
  "invalidation": ["..."],
  "dataQualityNote": "...",
  "confidenceLabel": "높음 | 보통 | 낮음"
}
```

## OpenClaw writing rules

When 또또봇 writes the insight:

1. Treat `context.marketState.regime`, scores, drivers, warnings, and data quality as authoritative.
2. Do not invent data not present in `hourly-context.json`.
3. Use Korean, short decision-support language.
4. Prefer tension-aware wording: e.g. “지수 반등은 강하지만 외국인/프로그램 수급이 확인하지 못한다.”
5. Include base case, watch triggers, and invalidation conditions.
6. Keep the output JSON valid; then run `npm run mi:persist-hourly-insight`.

## Next improvements

1. Add a heartbeat/cron routine that runs context build and asks 또또봇 to write/persist/publish the hourly insight.
2. Add forecast evaluation using later `market_state_10m` rows.
3. Tune style after Dani reviews the mobile card wording.
4. Add source-linked explanations for the top 2 drivers without expanding the card too much.
