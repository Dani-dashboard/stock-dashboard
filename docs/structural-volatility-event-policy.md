# Structural Volatility Event Policy

> Purpose: Define which non-routine calendar events deserve dashboard visibility because they can create index/FX/rates volatility or flow distortions.

## 1. Selection Principle

Do **not** add every calendar item. Add events that can plausibly change one of:

- policy-rate expectations
- long-end yield / Treasury supply expectations
- FX direction
- index futures / options hedging flows
- liquidity / settlement / holiday behavior
- semiconductor or Korea-specific risk appetite

Use three tiers:

- **Core structural events:** always track.
- **Conditional structural events:** track when nearby or when market context makes them important.
- **Do not include by default:** too noisy unless specifically relevant that week.

## 2. Core Structural Events — Always Track

### A. FOMC policy decisions

Why it matters:

- Directly reprices US 2Y, DXY, Nasdaq/SOX, gold, and global risk appetite.
- SEP/dot-plot meetings are higher impact.

Dashboard treatment:

- `High` when meeting result is this week / today.
- Promote to `오늘의 이슈` on decision day.
- Related groups: `Rates`, `FX`, `US`, `US Futures`, `Semis`.

Confirmed reference:

- Federal Reserve FOMC calendar states 2026 scheduled meetings include Jun 16–17, Jul 28–29, Sep 15–16, Oct 27–28, Dec 8–9. Starred Fed meetings include Summary of Economic Projections.

### B. Bank of Korea rate decisions / MPC meetings

Why it matters:

- Directly affects KRW, Korean rates, KOSPI/KOSPI200, bank/real estate sentiment.

Dashboard treatment:

- `High` in decision week.
- Promote to `오늘의 이슈` on decision day.
- Related groups: `KR`, `FX`, `Rates`, `KIS`.

Need:

- Official BOK schedule source cross-check before auto-populating exact dates.

### C. Bank of Japan MPM / rate decisions

Why it matters:

- JPY rates and yen moves can spill into global rates, USD/JPY, JPY/KRW, and risk appetite.

Dashboard treatment:

- `High` when decision day or Outlook Report meeting.
- `Watch` for Summary of Opinions/minutes unless market is already focused on BOJ.
- Related groups: `Rates`, `FX`, `US`, `KR`.

Confirmed reference:

- BOJ 2026 MPM schedule includes Jun 15–16, Jul 30–31, Sep 17–18, Oct 29–30, Dec 17–18.

### D. US monthly OpEx / quarterly futures-options expiry

Why it matters:

- Can produce index pinning, dealer hedging flows, and close/open volatility.

Dashboard treatment:

- Monthly OpEx: `High` for current week, `Watch` otherwise.
- Quarterly witching/futures expiry: `High`.
- Related groups: `US`, `US Futures`, `Semis`.

Rule of thumb:

- Monthly equity options expiration: third Friday.
- Quarterly index futures/options expiry: March/June/September/December third Friday area; verify holiday/session effects.

### E. Korea options / futures-options expiry

Why it matters:

- KOSPI200 derivatives can create intraday and close-driven flow volatility.

Dashboard treatment:

- Monthly options expiry: `High` in current/next week.
- Quarterly futures-options expiry: `High` and promote on the day.
- Related groups: `KR`, `KIS`, `FX`.

Rule of thumb:

- Korea options expiry: usually second Thursday monthly.
- Korea quarterly futures/options simultaneous expiry: usually second Thursday of Mar/Jun/Sep/Dec.
- Must cross-check exchange calendar when possible.

## 3. Conditional Structural Events — Track Selectively

### A. Treasury QRA / major Treasury auctions

Why it matters:

- Affects long-end supply, 10Y/30Y, term premium, and equity duration pressure.

Treatment:

- QRA: `High`.
- 10Y/30Y auctions: `Watch` or `High` if yields are already stressed.

### B. Major central bank minutes / summaries

Examples:

- FOMC minutes
- BOJ Summary of Opinions
- BOK minutes

Treatment:

- `Watch`, unless market is actively repricing policy.

### C. Exchange holidays / early closes

Why it matters:

- Liquidity thins, stale source statuses can look confusing, and futures/cash relationships change.

Treatment:

- `Watch` normally.
- `High` if it affects expiry/settlement or major event timing.

### D. Index rebalancing / MSCI / FTSE / Nasdaq/S&P changes

Why it matters:

- Can affect close auctions, Korea flows, EWY/KOSPI names, semis.

Treatment:

- Include only when dates and impacted markets are clear.
- Usually `Watch`; `High` if Korea/semis impact is material.

### E. Major semiconductor ecosystem events

Examples:

- TSMC monthly revenue
- NVDA/AMD/ARM major earnings
- Major AI/semiconductor conference/keynote

Treatment:

- `Watch` by default.
- `High` if directly tied to SOX/Nasdaq/DRAM large moves.

## 4. Exclude By Default

- Every Fed speaker: include only if chair/vice chair, hawkish/dovish inflection, or already in Osun calendar as important.
- Small earnings unrelated to monitored groups.
- Low-tier economic data without current market sensitivity.
- Repetitive dividend ex-dates unless tied to major index/fund flow.

## 5. Dashboard Decision

Recommended core set to implement now:

1. FOMC decision dates.
2. BOK decision dates after official source confirmation.
3. BOJ MPM dates.
4. US monthly OpEx and quarterly expiry candidates.
5. Korea monthly options and quarterly futures/options expiry candidates.
6. QRA / Treasury supply events from weekly calendar or official source.
7. Exchange holidays/early closes when they affect monitored markets.

Keep the number small: show only the next 4–8 structural events, with `verify` tags when official confirmation is pending.
