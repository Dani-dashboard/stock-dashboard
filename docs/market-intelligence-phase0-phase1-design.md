# KOSPI Market Intelligence Engine — PHASE 0 Repository Audit + PHASE 1 Architecture Design

Date: 2026-08-23 KST
Status: Design only. No production engine should be considered finalized from this document alone.

## Scope Lock

This document follows Dani's master spec for PHASE 0–1:

- Do not redesign the existing dashboard.
- Do not change the existing `data/latest.json` contract.
- Reuse existing fetchers, auth, stale logic, scheduler, publish path, and dashboard components where possible.
- Keep LLM/GPT out of raw numeric computation and 10-minute market regime decisions.
- Treat the Market Intelligence Engine as a sidecar unless a later migration proves a tighter integration is safer.

## Working Tree Note

An early prototype was created before the full master spec clarified the PHASE 0–1 scope lock. It has been removed from production paths and preserved at:

- `prototype-backups/market-intelligence-prototype-20260823-2054/`

Remaining pre-existing modified files at the time of this audit:

- `config/metrics.json`
- `scripts/refresh-krx-pcr-eod.sh`
- `src/providers/cnbc.mjs`
- `src/providers/naver.mjs`

These should not be overwritten by the Market Intelligence work unless separately reviewed.

---

## CURRENT_ARCHITECTURE

### Existing 1-minute deterministic fetch pipeline — EXISTING

Files:

- `scripts/fetch-all.mjs`
- `config/metrics.json`
- `src/providers/yahoo.mjs`
- `src/providers/binance.mjs`
- `src/providers/naver.mjs`
- `src/providers/cnbc.mjs`
- `src/providers/fred.mjs`
- `src/providers/kis.mjs`
- `src/providers/chartlog.mjs`
- `src/providers/krxOfficial.mjs`
- `src/market-hours.mjs`
- `src/status.mjs`

Main entrypoint:

- `npm run fetch` -> `node scripts/fetch-all.mjs`

Current role:

- Reads `config/metrics.json`.
- Fetches metrics from Yahoo, Binance, Naver, CNBC, FRED, KIS, Chartlog, KRX sources.
- Applies fallback and stale/closed/error status.
- Writes `data/latest.json`.
- Appends compact health log to `data/health-history.jsonl`.

Important reusable functions in `scripts/fetch-all.mjs`:

- `fetchWithFallback(metric)` — EXISTING, reuse as-is for source fallback.
- `fetchMetric(metric)` — EXISTING, provider dispatch.
- `appendHealthLog(root, payload)` — EXISTING, health-only history; not enough for MI history.
- `fetchInvestorFlows()` — EXISTING, KRX investor flow fetch.
- `fetchKoreaSpecialIndicators(results, generatedAt)` — EXISTING, current basis/breadth/program/relative-strength bundle.
- `readOrRefreshTimedCache(filename, ttlSeconds, producer)` — EXISTING, useful pattern for cadence-respecting cache.
- `applyKoreaSpecialHistory(payload, generatedAt)` — EXISTING, limited local history for basis/program/relative strength.
- `buildMarketSignals(...)` — EXISTING, deterministic Today Issue signal generation.

### Existing dashboard frontend — EXISTING

File:

- `index.html`

Current role:

- Loads `latest.json` and `events.json` from Supabase Storage by default.
- Renders summary, Today Issues, quick cards, metric groups, market volume panel, PCR panel, Korea special indicators, short-selling panel.
- Contains display helpers and some fallback issue rendering logic.

Current data URLs:

- `latest.json`
- `events.json`

### Existing publish path — EXISTING

File:

- `scripts/publish-supabase-storage.mjs`

Current role:

- Reads `.env`.
- Publishes required JSON files to Supabase Storage.
- Existing files:
  - `data/latest.json` — required
  - `data/events.json` — required
  - `data/alerts-latest.json` — optional

### Existing scheduler — EXISTING

Files:

- `scripts/run-every-minute.sh`
- `docs/launchd/README.md`
- `docs/launchd/com.dani.stock-dashboard-fetch.plist.template`
- `docs/launchd/com.dani.stock-dashboard-active-pcr.plist.template`
- `docs/launchd/com.dani.stock-dashboard-krx-pcr-eod.plist.template`
- `docs/launchd/com.dani.stock-dashboard-krx-short-selling-daily.plist.template`

Current role:

- `scripts/run-every-minute.sh` loops:
  - `npm run fetch || true`
  - `npm run publish:supabase || true`
  - `npm run alerts || true`
  - sleep 60
- launchd templates exist but are documented as templates, not automatically installed.

### Existing alerts — EXISTING

File:

- `scripts/check-alerts.mjs`

Reusable parts:

- `buildObservation(data, at)` — EXISTING, alert-specific 3-hour observation builder.
- `nearestObservation(observations, nowIso, targetMs, options)` — EXISTING, useful concept but limited to alert state.
- `addFlowCandidates(...)`, `addIndexMoveCandidates(...)` — EXISTING alert candidates, not general MI scoring.

Storage:

- `data/alert-state.json` keeps alert observations and cooldown state.
- Retention is about 3 hours, not suitable for 40–60 trading day normalization.

---

## REUSABLE_COMPONENTS

### Source/auth/client reuse

- `src/providers/kis.mjs` — EXISTING
  - `requestKis()` should be reused for KIS requests.
  - `getKisAccessToken()` and token cache should be reused.
  - Do not implement separate KIS auth.
- Existing KRX Data Marketplace calls in `scripts/fetch-all.mjs` and KRX scripts should be reused before adding new sources.
- `src/status.mjs` status vocabulary should be reused for quality and stale translation.
- `src/market-hours.mjs` should be reused for session relevance and market-close handling.

### Existing local history/caches

- `data/health-history.jsonl` — EXISTING, health summary only.
- `data/korea-special-history.json` — EXISTING, limited 10m/30m feature history for special indicators.
- `data/volume-snapshots.json` — EXISTING, checkpoint volume snapshots.
- `data/put-call-ratio-history.json` — EXISTING, PCR daily-ish history.
- `data/alert-state.json` — EXISTING, short alert history/cooldown.

Conclusion:

- Existing history should be reused where semantically correct.
- None of the existing stores are a complete `market_observations` / `market_features_10m` / `market_state_10m` store.
- A new local DB sidecar is justified.

---

## PROPOSED_ARCHITECTURE

Recommended architecture: sidecar Market Intelligence Engine.

```text
Existing source fetchers
  -> scripts/fetch-all.mjs
  -> data/latest.json

Market Intelligence sidecar
  -> observation ingestor
  -> local SQLite WAL database
  -> 10-minute feature engine
  -> deterministic score engine
  -> regime state machine
  -> hourly context builder
  -> optional GPT hourly insight
  -> sidecar JSON payloads for dashboard/Supabase
```

Classification:

- Existing fetchers/auth/stale/publish/dashboard: **EXISTING — reuse**
- Existing `latest.json`: **EXISTING — keep unchanged**
- Local MI database: **NEW**
- 10-minute feature/score/regime engine: **NEW**
- Hourly context builder: **NEW**
- GPT hourly insight: **NEW**, separate from CPU path
- Dashboard integration: **EXTEND**, display-only

---

## DATA_FLOW

### Observation flow

```text
npm run fetch
  -> data/latest.json
  -> market observation ingestor reads latest.json
  -> normalize observations
  -> persist market_observations
```

The ingestor should not refetch data. It should preserve original source cadence and metadata.

### 10-minute CPU flow

```text
every10Minutes:
  observations = loadRequiredHistory()
  features = featureEngine(observations)
  scores = scoreEngine(features)
  regime = stateMachine(scores, previousState)
  state = buildMarketState(features, scores, regime)
  persist(state)
  publish sidecar JSON
```

### Hourly GPT flow

```text
everyHourBetween09And17KST:
  context = hourlyContextBuilder(...)
  persist(context)
  insight = callConfiguredGPT(context)
  validate(insight)
  persist(insight)
  publish insight JSON
```

---

## LOCAL_STORAGE_DESIGN

Recommended technology: SQLite WAL local sidecar.

Reason:

- Current repo has no full historical database.
- JSON append is less suitable for indexed 40–60 trading day same-time queries.
- SQLite survives restart/crash, supports indexed queries, and keeps operations local.

### `market_observations` — NEW

Purpose: normalized raw observations from `latest.json` and selected existing caches.

Key fields:

- `id`
- `metric_id`
- `source_timestamp`
- `observed_timestamp`
- `fetch_timestamp`
- `latest_generated_at`
- `source`
- `provider`
- `value`
- `unit`
- `stale`
- `stale_seconds`
- `quality_level`
- `market_session`
- `raw_json`

Important rule:

- `source_timestamp`, `observed_timestamp`, and `fetch_timestamp` must not be conflated.

### `market_features_10m` — NEW

Purpose: deterministic 10-minute features.

Key fields:

- `timestamp`
- `metric_id`
- `level`
- `delta10m`, `delta30m`, `delta60m`
- `pctDelta10m`, `pctDelta30m`, `pctDelta60m`
- `slope30m`, `slope60m`
- `acceleration`
- `sameTimeZ`
- `rollingPercentile`
- `sampleCount`
- `quality`

### `market_state_10m` — NEW

Purpose: deterministic CPU market state.

Key fields:

- `timestamp`
- `regime`
- `previousRegime`
- `directionScore`
- `flowScore`
- `stressScore`
- `breadthScore`
- `confidenceScore`
- `riskBudget`
- `positiveDrivers`
- `negativeDrivers`
- `warnings`
- `watchConditions`
- `invalidationConditions`
- `contributionBreakdown`
- `dataQuality`

### `hourly_context` — NEW

Purpose: compact GPT input; no raw 2-week tick dump.

### `hourly_ai_insight` — NEW

Purpose: validated GPT JSON output.

### `hourly_forecast_evaluation` — NEW

Purpose: CPU evaluation of prior GPT scenario conditions.

---

## FEATURE_ENGINE_DESIGN

Feature engine should be config-driven.

Rules:

- Do not compute meaningless features for a metric type.
- Do not zero-fill stale/missing values.
- For cumulative flows, prioritize impulse over level.

Important cumulative features:

- `foreignFuturesImpulse10m`
- `foreignFuturesImpulse30m`
- `foreignSpotImpulse10m`
- `foreignSpotImpulse30m`
- `foreignProgramImpulse10m`
- `foreignArbitrageImpulse10m`
- `foreignNonArbitrageImpulse10m`
- `foreignNonArbitrageImpulse30m`
- `foreignNonArbitrageAcceleration`

Same-time normalization:

- Use 40–60 trading days where possible.
- Return null / low-confidence when sample count is insufficient.
- Consider robust median/MAD later.

---

## SCORE_ENGINE_DESIGN

Scores:

- `DirectionScore`: -100 to +100
- `FlowScore`: -100 to +100
- `StressScore`: 0 to 100
- `BreadthScore`: -100 to +100
- `ConfidenceScore`: 0 to 100

Config requirements:

- Metric clusters and weights in config.
- Freshness/reliability/session relevance multipliers in config.
- Emergency thresholds in config.

Avoid double-counting:

- S&P futures, Nasdaq futures, SOX, EWY should be grouped as a Global Risk Cluster rather than all carrying large independent weights.

---

## REGIME_ENGINE_DESIGN

Regimes:

- `STRONG_RISK_ON`
- `RISK_ON`
- `FRAGILE_RISK_ON`
- `NEUTRAL`
- `FRAGILE_RISK_OFF`
- `RISK_OFF`
- `STRESS`

Required mechanics:

- Hysteresis: generally require 2 consecutive 10-minute states before transition.
- Emergency override: immediate transition only when multiple config-defined extreme risk conditions co-occur.
- Veto/fragility logic: do not allow strong risk-on if price rises while flow, FX, volatility, and breadth deteriorate.
- Watch flags should be separate from regime, e.g. `REVERSAL_WATCH`.

---

## HOURLY_CONTEXT_DESIGN

Context builder should produce compact JSON.

Include:

- `asOf`
- `sessionPhase`
- `current`
- `last60m`
- `sessionToDate`
- `rolling2w`
- `normalization`
- `slowContext`
- `similarHistoricalStates`
- `previousHourlyAssessment`
- `previousForecastEvaluation`
- `dataQuality`

Do not send raw 2-week 1-minute data to GPT.

---

## GPT_INTEGRATION_DESIGN

GPT must not compute raw numbers or override CPU regime.

Schedule:

- 09:00, 10:00, 11:00, 12:00, 13:00, 14:00, 15:00, 16:00, 17:00 KST.

Implementation note:

- Actual OpenClaw model identifier and high reasoning syntax must be checked in the current environment before implementation.

Output schema should be strict JSON with fields such as:

- `timestamp`
- `sessionPhase`
- `cpuRegime`
- `metaAssessment`
- `headline`
- `marketStructure`
- `changeAssessment`
- `keyPositiveDrivers`
- `keyNegativeDrivers`
- `divergences`
- `riskPosture`
- `baseScenario`
- `riskOffScenario`
- `riskOnScenario`
- `watchNextHour`
- `invalidationConditions`
- `dataQualityWarnings`

---

## DASHBOARD_INTEGRATION_DESIGN

Dashboard should be extended, not rewritten.

Recommended display order:

1. Hourly GPT Insight
2. 10-Min CPU Engine
3. Existing Today Issues
4. Existing quick cards / panels

Frontend rule:

- Do not calculate scores in frontend.
- Only render backend/local-engine payloads.

Potential sidecar JSON files:

- `data/market-state-10m.json`
- `data/hourly-ai-insight.json`

---

## FAILURE_HANDLING

- CPU sidecar failure must not break `npm run fetch` or existing dashboard.
- GPT failure must not break CPU sidecar.
- Last successful GPT insight must be marked stale when reused.
- Missing/stale data should reduce effective weight, not become zero.
- No secret values in logs.

---

## TEST_STRATEGY

Add synthetic tests for:

- Healthy Risk-On
- Fragile Rally
- Strong Risk-Off
- Reversal Candidate
- Missing FX
- Stale VKOSPI
- Missing Foreign Futures
- Program Trading unavailable
- Breadth unavailable
- Extreme FX spike
- GPT timeout
- Malformed GPT JSON
- PC restart
- Duplicate scheduler run
- Market closed
- Holiday

---

## PERFORMANCE_CONSIDERATIONS

Indexes:

- `market_observations(metric_id, observed_timestamp)`
- `market_observations(observed_timestamp)`
- `market_features_10m(timestamp)`
- `market_state_10m(timestamp)`

Avoid repeated 60-day full scans in the 10-minute loop. Consider cached aggregates for same-time normalization after initial implementation.

---

## FILES_TO_ADD

Recommended later:

- `config/market-intelligence.json`
- `scripts/market-intelligence-migrate.mjs`
- `scripts/market-observation-ingest.mjs`
- `scripts/market-feature-engine-10m.mjs`
- `scripts/market-state-engine-10m.mjs`
- `scripts/hourly-context-builder.mjs`
- `scripts/hourly-gpt-insight.mjs`
- `scripts/hourly-forecast-evaluation.mjs`
- `scripts/validate-market-intelligence.mjs`
- `tests/market-intelligence/*.mjs`

## FILES_TO_MODIFY

Recommended later and only after design approval:

- `package.json` — add scripts.
- `scripts/run-every-minute.sh` — call CPU sidecar safely.
- `scripts/publish-supabase-storage.mjs` — optional sidecar publish.
- `index.html` — display-only integration.
- `docs/launchd/README.md` and launchd templates — scheduling documentation.

## MIGRATIONS

No existing migration system was found. The MI engine should own an idempotent SQLite migration/init step.

---

## IMPLEMENTATION_PHASES

1. Confirm backup/revert state.
2. Approve this PHASE 0–1 design.
3. Add SQLite schema/migration only.
4. Add observation ingestor.
5. Add 10-minute feature engine.
6. Add score engine.
7. Add regime state machine.
8. Add hourly context builder.
9. Add GPT hourly insight.
10. Add dashboard display integration.
11. Add replay/historical evaluation.
12. Calibrate weights after sufficient data accumulates.

---

## RISKS

- Working tree has non-MI modified files; avoid overwriting them.
- KIS/KT throttling risk: do not add extra source calls in MI sidecar unless absolutely necessary.
- Same-time normalization needs sufficient trading-day history; early values should remain null or low confidence.
- GPT schedule/model integration should not be guessed.
- Regime logic can overfit if calibrated before enough history exists.

---

## OPEN_QUESTIONS

1. Should the preserved prototype backup be kept as reference or deleted after final design approval?
2. Which OpenClaw scheduler should run hourly GPT: OpenClaw cron or local launchd?
3. What is the exact available model identifier for GPT-5.6/high reasoning in the installed environment?
