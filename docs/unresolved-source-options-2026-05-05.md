# Unresolved Source Options — 2026-05-05

> Purpose: 더 이상 한 소스만 기다리지 않고, 미해결 지표마다 최소 2개 대체 루트를 정한다.

## 1. US 2Y yield

### Option A — CNBC / Tradeweb quote API

- Status: **implemented as primary**
- Symbol tested: `US2Y`
- Provider symbol observed: `US2YT=TWEB`
- Smoke result: returns numeric value, timestamp, change, change_pct.
- Dashboard status: green when timestamp is within `staleSeconds`.

### Option B — Daily official/FRED fallback

- Use only as fallback if CNBC fails.
- Likely not 1-minute, but authoritative enough for a rate card fallback.
- Display policy: mark as daily/official fallback, not live.

Decision: Use CNBC first because it fills the live/free gap that Yahoo did not cover.

## 2. Japan 10Y yield

### Option A — CNBC Japan 10 Year Treasury

- Status: **implemented as primary**
- Symbols tested: `JP10Y`, `JP10Y-JP`
- Provider symbol observed: `JP10YT=RR`
- Smoke result: returns numeric value, timestamp, change, change_pct.
- Current issue: timestamp can be stale across Japan holidays/non-trading periods.
- Display policy: show value with warn if stale.

### Option B — Official/daily Japan source fallback

- Use Japan MOF/market statistics source if CNBC becomes unreliable.
- Likely daily, not 1-minute.
- Display policy: daily official fallback, not live.

Decision: Use CNBC first, but keep stale warning strict.

## 3. Korea 10Y yield

### Option A — CNBC South Korea 10-yr

- Status: **implemented as primary**
- Symbols tested: `KR10Y`, `KR10Y-KR`, `KR10YT=RR`
- Provider symbol observed: `KR10YT=RR`
- Exchange observed: `Korean OTC Bonds`
- Smoke result: returns numeric value, timestamp, change.
- Display policy: show value with warn if stale.

### Option B — KIS domestic bond endpoint

- Status: implemented previously but demoted.
- KIS endpoint works technically, but paper response for selected ISIN returned `ernn_rate=0.000` with `acml_vol=0`.
- Current dashboard refuses to show that as real yield.
- Next use: revisit with a better benchmark ISIN or real/official KIS bond docs.

Decision: Use CNBC first; do not display KIS 0.000 as real data.

## 4. KOSPI200 night futures

### Option A — KIS KRX NGT websocket, real/verified key

- Status: subscription succeeds but no tick received in paper mode.
- Tested TR IDs: `H0MFCNT0`, `H0MFASP0`.
- Tested key candidates include `101V06`, `101W9000`, `101W06`, `101T06`, `A01606`, `01606`.
- Problem: subscription acceptance does not prove live tick delivery.
- Next: verify paper-vs-real limitation or exact active realtime key with KIS docs/support/real environment.

### Option B — Display fallback/derived status instead of fake night futures

- Use KIS day futures latest/final value as a clearly labeled fallback only when NGT tick is unavailable.
- Label must be explicit: `야간선물 미수신 · 주간선물 최종값 참고`, not a night futures number.
- This gives Dani some context without pretending to solve realtime NGT.

Decision: Keep NGT card warn for now; consider adding a separate fallback note/card rather than replacing the value.

## 5. US cash index warnings

Current warnings for Nasdaq/S&P/Dow/SOX/EWY/DRAM are mostly stale/free-source timing issues, especially outside regular US trading or when Yahoo 1m rows are old.

Two options:

1. Keep Yahoo with clear stale warnings.
2. Add CNBC quote provider fallback for cash indices if persistent stale warnings become annoying.

Decision: Do not change yet unless Dani wants these to be less strict. They are values with warnings, not missing source blockers.
