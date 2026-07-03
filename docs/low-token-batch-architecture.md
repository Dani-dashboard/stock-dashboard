# Low-Token 1-Minute Batch Architecture

## Core Rule

The 1-minute market refresh must not call AI and must not send chat messages.

AI should be used only for:

- development iterations
- debugging unusual failures
- summarizing progress
- interpreting market data on explicit request
- higher-level alerts after deterministic filters detect something meaningful

## Current Data Flow

```text
local scheduler / shell loop
  → scripts/fetch-all.mjs
    → Yahoo / Binance / Naver / KIS HTTP requests
    → data/latest.json
  → index.html reads local JSON
```

No LLM is involved in the refresh path.

## Why This Matters

- Lower token use
- More stable refresh timing
- No chat spam
- Easier debugging
- Credentials stay local
- Market data state survives assistant session restarts via files

## Recommended Operating Modes

### Development mode

Use manual command:

```bash
npm run fetch
npm run serve
```

### Local loop mode

```bash
./scripts/run-every-minute.sh
```

Good for active testing. Stop with `Ctrl+C`.

### Future production-ish mode

Use macOS `launchd` to run `npm run fetch` every 60 seconds or keep a persistent local service. This should still write only to `data/latest.json` and local bounded logs.

## Logging Policy

Keep logs useful but bounded.

Recommended:

- Keep latest snapshot: `data/latest.json`
- Keep iteration history: `logs/iteration-log.md`
- Keep issue/solution history: `logs/issue-solution-log.md`
- Future: bounded source health history, e.g. last 500 records only

Avoid:

- Saving every tick forever in large JSON files during MVP
- Sending every status change to Dani
- Invoking assistant/LLM every minute

## Alert Policy Draft

Only alert Dani for meaningful events:

- A previously reliable source is down for >15–30 minutes
- KIS credentials/action needed
- A major metric cannot be sourced after investigation
- Dashboard is ready for visual review
- A policy/legal/credential decision is needed

Do not alert for:

- routine `npm run fetch` success
- expected KIS missing credentials
- source delay already classified as normal free-source delay
- closed-market status

## Next Optimization Ideas

1. Add `data/health-history.jsonl` with bounded rotation.
2. Add source-level retry/backoff for transient HTTP errors.
3. Add batch grouping to avoid unnecessary calls when market is closed.
4. Add per-market calendar/active-hour rules.
5. Add launchd template for stable local scheduling.
