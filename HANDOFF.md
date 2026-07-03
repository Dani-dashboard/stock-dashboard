# HANDOFF — Stock / Index Dashboard

## 1. Current Goal

Build a mobile-first local stock/index/macro dashboard that refreshes market data every minute using free/local sources first, clearly shows source quality/status, and evolves into a market situation board with event context and issue summaries.

## 2. Dani Direction

- Proceed proactively with repeated cycles: build → test → find problems → research/confirm solution → improve.
- Message Dani only when action/decision is needed, a real blocker appears, a source/policy risk matters, or meaningful progress/regression occurs on unresolved indicators.
- Preserve context with strong handoff/history logs.
- Optimize the 1-minute batch path to be stable and low-token/low-AI-cost.
- **Never put AI/Codex in the 1-minute refresh loop.** AI is only for development, diagnostics, lower-frequency summaries, and user-requested interpretation.
- If a free source fails or is stale, show the failure transparently instead of hiding it.
- Dani usually checks on phone; prioritize compact mobile readability and at-a-glance scanning.
- FX is important to Dani. USD/KRW, EUR/KRW, and JPY/KRW x100 should surface support/resistance breaks in `오늘의 이슈`.
- Event layer direction:
  - Top: `오늘의 이슈` — major index sharp moves, specific/anomalous moves, FX support/resistance breaks, and today’s volatility-driving events.
  - Below mobile quick cards: `이번주 일정` — calendar-style weekly schedule.
  - Add structural market-flow events such as Korea/US futures/options expiry, OpEx, holidays, rebalancing.
  - Weekly update: after **Sunday 20:00 KST**, check `오선의 미국 증시 라이브` YouTube community board for the new weekly calendar post.

## 3. Current Architecture

Project path: `projects/stock-dashboard/`

Core files:

- `index.html` — local dashboard UI; renders metrics, `오늘의 이슈`, `이번주 일정`, structural event cards.
- `config/metrics.json` — metric/source configuration.
- `scripts/fetch-all.mjs` — one-shot deterministic fetch batch; writes `data/latest.json`; also computes `fxLevels`.
- `scripts/run-every-minute.sh` — local 1-minute loop wrapper; must stay AI-free.
- `scripts/validate-events.mjs` — validates event schedule schema.
- `src/providers/yahoo.mjs` — Yahoo chart endpoint provider.
- `src/providers/binance.mjs` — Binance BTC/ETH provider.
- `src/providers/naver.mjs` — Naver providers: index, FX, market-index/bond.
- `src/providers/cnbc.mjs` — CNBC quote provider; improved close/post-market classification.
- `src/providers/kis.mjs` — KIS auth/request shell, futures board, bond shell.
- `src/market-hours.mjs` — conservative market-hours guard for KIS/night calls.
- `data/latest.json` — latest generated market snapshot.
- `data/events.json` — event layer data: `todayIssues`, `weeklyEvents`, `structuralEvents`.
- `docs/event-layer-product-brief.md` — product direction for event and 30-minute summary layers.
- `docs/event-layer-ux-spec.md` — UX/source/schema spec for Today Issues + Weekly Calendar.
- `docs/web-publishing-plan.md` — mobile/web publishing and future summary notes.
- `logs/iteration-log.md` — full iteration history.
- `logs/issue-solution-log.md` — issue/fix history.

## 4. Latest Verified Status

Latest inspected snapshot: `data/latest.json` generated at `2026-05-06T05:11:38.654Z` / 14:11 KST.

Summary:

- 29 total metrics
- 14 normal
- 6 warn
- 9 closed
- 0 error

Recent gates:

- `npm run check` passed after event/schema updates.
- `npm run fetch` passed after FX level and event-layer updates.
- Inline `index.html` script syntax was checked with `node --check` during event-layer work.

## 5. Data Source Changes Completed on 2026-05-06

### FX

- USD/KRW, EUR/KRW, JPY/KRW x100 moved from Yahoo primary to **Naver/Hana Bank FX** primary.
- Yahoo remains fallback/reference.
- Rationale: Yahoo `KRW=X` could be >30 minutes stale even though local 1-minute fetch worked.
- `scripts/fetch-all.mjs` now computes `fxLevels` from Yahoo 5d/1h reference data:
  - support
  - resistance
  - 5-day average
  - sample count
  - status: `below_support`, `above_resistance`, `near_support`, `near_resistance`, `inside_range`
- `오늘의 이슈` surfaces FX breaks as `High`; near-line events as `Watch`.
- Current FX level state:
  - USD/KRW: near 5-day support (`current ~1455.7`, support `~1455.43`, resistance `~1486.38`)
  - EUR/KRW: inside range
  - JPY/KRW x100: inside range

### Commodities / Rates / US cash

- Gold moved to CNBC COMEX `@GC.1` primary; Yahoo fallback retained.
- WTI moved to CNBC NYMEX `@CL.1` primary; Yahoo fallback retained.
- US 10Y/30Y moved to CNBC/Tradeweb `US10Y` / `US30Y` primary; Yahoo fallback retained.
- US 2Y uses CNBC/Tradeweb `US2Y`.
- CNBC provider now treats `mainmktstatus=CLOSE` and `POST_MKT` as closed before stale-warning classification.
- CNBC provider also infers Tradeweb Treasury post-close, CNBC weekend close, CME commodity maintenance close, and CME commodity weekend close; it falls back to `cachedTime` when CNBC emits future-dated commodity `last_time` values.
- SOX moved to Naver world-index primary because CNBC `.SOX` did not expose a clean closed-state field after market close; CNBC fallback retained.

### KR10Y / JP10Y

- Added `naverMarketIndex` provider.
- KR10Y primary: Naver market-index `bond&reutersCode=KR10YT=RR`; CNBC fallback retained.
- JP10Y primary: Naver market-index `bond&reutersCode=JP10YT=RR`; CNBC fallback retained.
- This improved source trace/transparency but **did not solve freshness**.
- Latest known:
  - KR10Y: `3.933`, timestamp `2026-05-04 16:16:18 KST`, still warn.
  - JP10Y: `2.509`, timestamp `2026-05-02 02:25:57 KST`, still warn.

## 6. Event Layer Current State

### UI

`index.html` now has:

1. `오늘의 이슈` at the top.
   - Manual scheduled issues from `data/events.json`.
   - Automatic market-move issue detection for selected key metrics.
   - Automatic FX 5-day support/resistance issue detection.
2. Mobile quick cards / priority metrics.
3. `이번주 일정` calendar-style section below quick cards.
4. `구조적 변동성 이벤트` cards below weekly schedule.

### Current `data/events.json`

Source:

- `오선의 미국 증시 라이브 — 2026년 5월 4주 차 주요 일정`
- Source path: `https://www.youtube.com/@futuresnow/posts`
- `r.jina.ai` public text extraction successfully returned the latest community post text on 2026-05-18 KST.
- Extracted only factual metadata: date, time, event name, impact stars, related groups.

Current Today Issues:

- `data/events.json` keeps `todayIssues` intentionally empty by default.
- Weekly scheduled events should remain in `이번주 일정`; live/recent market signals are generated separately.

Weekly calendar currently covers:

- 2026-05-18 Mon
- 2026-05-19 Tue
- 2026-05-20 Wed
- 2026-05-21 Thu
- 2026-05-22 Fri

Structural events currently added:

- 2026-05-14 — Korea KOSPI200 options expiry
- 2026-05-15 — US monthly options expiration / OpEx
- 2026-06-11 — Korea quarterly futures/options expiry candidate; official cross-check pending
- 2026-06-19 — US quarterly futures/options expiry week candidate; official holiday/session cross-check pending

## 7. Current Known Issues / Watch Items

1. **KOSPI200 night futures**
   - KIS websocket subscriptions succeed for multiple TR/key candidates, but no live tick has been received.
   - Do not fake night futures value.
   - Dashboard may show closed outside night session; during night session continue validation.
   - Need confirm whether KIS paper environment emits NGT ticks, exact active `tr_key`, or real environment/docs/support.

2. **KR10Y / JP10Y freshness**
   - Naver source trace is now visible and better than ambiguous CNBC-only, but timestamps remain stale.
   - Next: find official/daily or fresher source; otherwise label as stale/daily bond reference.

3. **Event source operations**
   - Weekly Osun calendar should be refreshed after Sunday 20:00 KST.
   - Run `npm run calendar:freshness` to detect stale/missing weekly dates; `npm run check` syntax-checks the freshness script too.
   - Direct YouTube extraction may be unreliable; use `r.jina.ai` fallback as needed.
   - If extraction fails, message Dani instead of silently passing: ask for the latest post text/image or URL.
   - OpenClaw cron registration was attempted on 2026-05-18 but blocked by Gateway scope approval (`scope upgrade pending approval`); once approved, register the weekly cron job for Sunday 20:10 KST.
   - Keep source attribution and avoid copying full post beyond factual event metadata.

4. **Structural event official confirmation**
   - Need official/credible source cross-check for Korea futures/options expiry and US OpEx/quarterly expiry/holiday handling.
   - Current `verify` items are intentionally marked as candidates.

5. **Cloudflare Quick Tunnel**
   - Temporary public URL in `.public-tunnel-status.md` if running.
   - Anyone with URL can view snapshot; no secrets are served directly.
   - iMac must stay awake/online.

## 8. Low-Token / Low-AI Operating Principle

Current data flow:

```text
local shell loop / scheduler
  → npm run fetch
  → scripts/fetch-all.mjs
  → Yahoo / Binance / Naver / CNBC / KIS deterministic requests
  → data/latest.json + data/health-history.jsonl
  → index.html reads JSON through local server / Cloudflare tunnel
```

No Codex/LLM is used in the 1-minute refresh path.

Future 30-minute summary layer should also start with deterministic thresholds. AI summaries should run only at lower frequency or on meaningful triggers/user request.

## 9. Next Work Steps

High priority:

1. Visual QA the event-layer UI on mobile width; adjust density/placement if needed.
2. Continue KR10Y/JP10Y freshness source search.
3. Continue KOSPI200 NGT/night futures validation during night session.
4. Cross-check and improve structural event calendar with official/credible sources.
5. Complete OpenClaw cron registration for Sunday 20:10 KST after Gateway cron scope approval.
6. Consider separating `data/events.json` authoring into a small script/parser once source format stabilizes.

Next product layer:

- 30-minute market summary concept:
  - deterministic scanner checks sharp index moves, FX/rates breaks, semis divergence, risk-on/off patterns.
  - show concise summary card in `오늘의 이슈` or a future `오늘의 시장 요약` section.
  - keep AI out of the 1-minute loop.

## 10. When to Message Dani

Message Dani for:

- External account/API/credential/action needed.
- Source legally/technically risky or requires policy choice.
- Dashboard ready for visual preference review.
- Real blocker that cannot be solved locally.
- Concrete progress/regression on unresolved indicators or event layer.
- FX support/resistance break if meaningful and user-visible alerting is later enabled.

Do not message for:

- routine successful 1-minute fetches.
- unchanged expected closed-market statuses.
- repetitive unchanged warnings.

## 11. Market Knowledge / Language Layer

Added after Dani emphasized professional market language:

- `docs/market-language-style-guide.md` — wording rules for FX/rates/equities/commodities/event summaries.
- `docs/market-monitoring-knowledge-base.md` — reusable market interpretation library.

Use these files when improving `오늘의 이슈`, 30-minute summaries, or any market commentary. The goal is to distinguish important vs noisy moves and use market-native language such as `원화 강세`, `장기금리 상승으로 할인율 부담`, `반도체 리스크오프`, `OpEx 수급성 변동성`.

## 12. Latest Additions After Handoff — Korea Signals / Investor Flow

- Added Korea index signals to `marketSignals` because Dani noticed KOSPI surged but was not in `오늘의 이슈`.
- `marketSignals` now covers KOSPI, KOSPI200, KOSPI200 day futures, and KOSDAQ.
- Added KRX investor-flow fetch in `scripts/fetch-all.mjs`:
  - Source endpoint: KRX Data Marketplace main investor trend `dbms/MDC/MAIN/MDCMAIN00103`.
  - KOSPI200 futures key: `KR___FUK2I`.
  - KOSPI200 options key: `KR___OPK2I`.
  - KOSPI cash key: `STK`.
- `data/latest.json` now includes `investorFlows`.
- Current observed KOSPI200 futures foreign flow on 2026-05-06:
  - foreign buy `46,494` 십억원
  - foreign sell `48,819` 십억원
  - foreign net buy `-2,326` 십억원 → net selling / 선물 수급 부담
- `오늘의 이슈` cap increased from 5 to 8 cards so Korea index and investor-flow signals are not crowded out.

## 13. Gmail API Email Alert Status — 2026-05-06 Night

- Local unauthenticated `sendmail` was tested but Gmail rejected delivery with SMTP `550-5.7.25` due missing/mismatched PTR / forward DNS. Do not rely on direct local Postfix/sendmail for production alerts.
- Gmail API OAuth flow was added and completed:
  - `scripts/setup-gmail-api.mjs`
  - `scripts/gmail-api-authorize.mjs`
  - `scripts/send-gmail-api-alert.mjs`
  - `scripts/check-alerts.mjs` supports `ALERT_EMAIL_PROVIDER=gmail-api`.
- `.env.alerts` stores Gmail API credentials/refresh token locally with chmod 600 and is gitignored.
- Gmail API test send succeeded with message id `19dfd5fe8d862148`.
- Actual alert checker send test succeeded via Gmail API for:
  - USD/KRW intraday 급락 alert.
  - foreign KOSPI200 futures 순매도 alert.
- Current important nuance:
  - `npm run alerts` sends email only when `ALERT_EMAIL_ENABLED=1` is present in the environment.
  - `.env.alerts` currently selects provider/destination/credentials, but recurring 1-minute loop should not be made permanently outbound unless Dani explicitly approves always-on email alerts.
- Security note:
  - OAuth Client Secret was briefly pasted in Telegram chat during setup.
  - Recommended next maintenance: regenerate OAuth client secret in Google Cloud and update `.env.alerts`/refresh token when convenient.

## 14. Today Issues Rates Scope — 2026-05-06 Night

- Dani requested that `오늘의 이슈` monitor only the US 10Y Treasury among US rates.
- Implemented in `scripts/fetch-all.mjs`: `marketSignals` now generates `rates_move` only for `us10y`.
- US 2Y and US 30Y cards remain in the dashboard data/metric layer, but they no longer appear as Today Issues signals.

## 15. Latest Alert / Night Futures Policy Updates — 2026-05-07 Morning

- Dani asked why KOSPI200 night futures sometimes appears and then disappears.
- Policy changed so `kospi200_night_futures_kis` no longer goes null after night session close:
  - During night session: KIS NGT websocket tick first; if absent, Chartlog fallback is shown as warn / `대체소스`.
  - Outside night session: Chartlog value is shown as closed / `전일 야간선물 최종` reference, not live data.
  - Display remains transparent with `kr_derivatives_night_CLOSED_REFERENCE`.
- Dani then requested night futures be excluded from email alerts:
  - Dashboard display remains enabled.
  - Email alert generation for night futures is fully excluded.
- Added KOSPI200 day futures price-move email alert:
  - `kospi200_futures_kis` absolute intraday move >= `2.00%` creates High alert.
  - Verified Gmail API send succeeded for `[시장알림] KOSPI200 주간선물 +2.01% 급등 — 위험선호/상방 압력`.
- Fixed `scripts/check-alerts.mjs` cooldown behavior:
  - Dry-run or window-inactive checks no longer write cooldown.
  - Cooldown is recorded only after actual successful email send.
- Verification commands passed:
  - `npm run check`
  - `npm run fetch`
  - dry-run `ALERT_EMAIL_ENABLED=0 npm run alerts`
  - actual `ALERT_EMAIL_ENABLED=1 ALERT_EMAIL_WINDOW=major-market-hours npm run alerts` for the day-futures alert.

## 16. Assistant Continuity Note — 2026-05-07

- Dani noticed a tone shift and asked if handoff was done properly.
- Important tone/persona reminder from workspace context:
  - Assistant name: 또또봇 🧭.
  - Talk to Dani in comfortable Korean.
  - Preferred vibe: calm, clear, consultant-like, not stiff.
  - Be concise but do not become flat or generic.
- For future sessions, read this HANDOFF first for stock-dashboard work, then check `logs/iteration-log.md` for the newest fine-grained changes.

## 17. Today Issues Freshness Rule — SOX / EWY — 2026-05-07 Night

- Dani requested that SOX/EWY US-market lead signals should not stay in `오늘의 이슈` too long after Korea starts trading.
- Implemented in `scripts/fetch-all.mjs`:
  - `equity-sox` and `equity-ewy` generated Today Issues are included only from 21:00 KST onward and before 10:00 KST.
  - After 10:00 KST, they remain as dashboard cards but are excluded from `marketSignals` / Today Issues.
  - Purpose: US close/US-session info is useful for the overnight-to-Korea-open handoff, but after Korea's first hour live domestic price action is more relevant.
- Verification: `npm run check` and `npm run fetch` passed; at 21:57 KST SOX/EWY were included as `fresh_us_lead` signals, as intended.

## 18. Today Issues Occurrence-Time Window — 2026-05-12 Night

- Dani requested `오늘의 이슈` to behave like a short-lived issue board, not a duplicated weekly calendar.
- Implemented:
  - Generated `marketSignals` now include `occurredAt` from the snapshot generation time.
  - `index.html` normalizes issue occurrence time and shows `HH:mm 발생` on every Today Issue card.
  - Today Issues filters out items older than 3 hours from `occurredAt`.
  - Manual scheduled weekly-calendar items are excluded from Today Issues by default; `이번주 일정` remains the separate calendar section.
- Verification passed:
  - `npm run check`
  - `npm run fetch` → 29 total / 16 ok / 1 warn / 12 closed / 0 error
  - extracted inline `index.html` script `node --check`

## 19. Osun Weekly Calendar Refresh + Newest-First Issues — 2026-05-12 Night

- `data/events.json` refreshed from `오선의 미국 증시 라이브 — 2026년 5월 3주 차 주요 일정`.
- Important source-operation update:
  - YouTube `/community` path may show unavailable.
  - Use `https://www.youtube.com/@futuresnow/posts` through Jina (`https://r.jina.ai/http://www.youtube.com/@futuresnow/posts`) to extract latest post text.
- Current weekly schedule covers 2026-05-11 to 2026-05-15 with 46 calendar items.
- `todayIssues` is intentionally empty in `data/events.json`; weekly schedule items should not appear in `오늘의 이슈` by default.
- `오늘의 이슈` now sorts by `occurredAt` newest first after the 3-hour freshness filter; impact is only a tie-breaker.
- Verification passed:
  - `npm run check` → events validation passed with 46 item(s)
  - `npm run fetch` → 29 total / 20 ok / 1 warn / 8 closed / 0 error
  - extracted inline `index.html` script `node --check`

## 20. Web Tunnel Restored After Wi-Fi Interruption — 2026-05-12 Night

- Wi-Fi toggle killed dashboard-serving processes.
- Restarted:
  - local server: `python3 -m http.server 8787 --bind 127.0.0.1 --directory .`
  - Cloudflare quick tunnel
  - deterministic 1-minute fetch loop
- Current quick tunnel URL:
  - `https://mel-insert-progress-mixing.trycloudflare.com/index.html`
- `.public-tunnel-status.md` updated with current URL/PID/log paths.
- Verification: public index and `data/latest.json` both returned HTTP 200.
- Safety note: `scripts/run-every-minute.sh` now defaults recurring alerts to dry-run unless `ALERT_EMAIL_ENABLED=1` is explicitly set outside the script.

## 21. US10Y Sensitive Today-Issue Rule — 2026-05-12 Night

- Dani asked for stronger sensing of US 10Y Treasury moves in `오늘의 이슈`, especially when the yield exceeds 4.40%.
- Implemented in `scripts/fetch-all.mjs`:
  - normal threshold: absolute US10Y move >= 4bp creates Today Issue,
  - sensitive threshold: if US10Y >= 4.40%, create a High issue and tighten move threshold to >= 2bp,
  - absolute move >= 8bp remains High,
  - issue summary explicitly mentions growth-stock/SOX valuation pressure and dollar reaction when above 4.40%.
- Current checked state: US10Y 4.455%, +4.3bp generated High `above_4_40_sensitive` issue.
- Verification: `npm run check` and `npm run fetch` passed.

## 22. Today Issues First-Seen Time Fix — 2026-05-12 Night

- Dani clarified the intended behavior: issue time should be the first time the issue was tracked, and the card should remain visible only up to 3 hours from that first-tracked time.
- Fixed bug where each fetch stamped every generated issue with the current snapshot time.
- New state file:
  - `data/issue-state.json`
  - active key: `signal.id + signal.status`
  - stores `firstSeenAt`, `lastSeenAt`, id/type/status/title.
- `data/latest.json.marketSignals[].occurredAt` now uses persisted `firstSeenAt`; `lastSeenAt` shows the latest detection time.
- If an issue disappears from generated signals, it is removed from active state. If it appears again later, it starts a fresh 3-hour window.
- Verification: two consecutive fetches preserved `occurredAt` and advanced `lastSeenAt`; `npm run check` passed.

## Update 2026-05-13 — Morning Today Issues Logic

Dani's morning-priority feedback has been implemented in `scripts/fetch-all.mjs`: USD/KRW >=1%, gold/BTC relationship, US10Y high, Nasdaq100 vs S&P500 larger mover, SOX/EWY/DRAM US-close lead, SOX intraday recovery shape, and KOSPI200 night futures moves now feed `오늘의 이슈`. Issue state keys include the KST data date where available so daily close signals reset with each day's first updated number. Last gate: `npm run check` and `npm run fetch` passed at 2026-05-13 morning KST.
