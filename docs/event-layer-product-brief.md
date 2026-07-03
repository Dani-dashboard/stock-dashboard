# Event Layer Product Brief

> Purpose: Add a mobile-first market event layer to the stock/index dashboard so Dani can quickly see what matters today and this week.

## 1. Product Direction

The dashboard should evolve from a numeric board into a market situation board.

The event layer should answer:

- What major events can move the indicators I am watching today?
- What important events are coming this week?
- Is anything meaningful enough to move near the top of the dashboard?

Do not build an exhaustive calendar. Build a filtered, high-signal schedule.

## 2. UX Principles

- **At-a-glance first:** mobile scan should work within 5–10 seconds.
- **Today before week:** today’s events should be more prominent than weekly events.
- **Impact labels:** High / Medium / Watch, not a wall of text.
- **Time clarity:** show KST first; optionally show source timezone in small text.
- **Relevance links:** connect events to dashboard groups: FX, Rates, US, KR, Semis, Commodities.
- **Promote when meaningful:** if a major event is today or imminent, surface it above ordinary metric sections.

## 3. Suggested UI Structure

### Top compact strip

Show only if important events exist today.

Example:

```text
오늘 핵심 일정
21:30 CPI · High · Rates / FX / US Futures
23:00 Fed speaker · Watch · Rates
```

### Event cards

Each event card:

- Time KST
- Event name
- Impact badge
- Related dashboard groups
- One-line why it matters
- Source label

### This week drawer / section

Compact grouped list:

- Today
- Tomorrow
- Later this week

Default collapsed on mobile if today has many events.

## 4. Event Categories

Initial inclusion list:

- Central banks: FOMC, Fed speakers, BOK, BOJ, ECB
- Inflation: CPI, PPI, PCE
- Labor: payrolls, unemployment, jobless claims
- Growth/activity: GDP, PMI, retail sales, ISM
- Market structure: US/KR holidays, futures/options expiry
- Semis/tech: major semiconductor earnings or events if clearly market-moving
- Korea-specific: BOK, export data, major Korea market closures

## 5. Data Architecture

Keep the same low-token architecture:

```text
local fetch / event script
  → data/events.json
  → index.html renders event layer
```

No AI in the 1-minute market fetch loop.

The event layer can update less frequently:

- 1–4 times/day for calendar data
- manual refresh during MVP
- later: deterministic daily/weekly schedule fetch

## 6. Future 30-Minute Market Summary Layer

Draft concept:

- Deterministic scanner checks every 30 minutes or on demand.
- It flags:
  - sharp index moves
  - unusual FX/rates moves
  - futures vs cash divergence
  - semis/ETF outliers
  - broad risk-on/risk-off pattern
- AI summary should only run after thresholds trigger or at low-frequency scheduled checkpoints.

Important guardrail:

- 1-minute data fetch remains pure local code.
- Summary/interpretation is separate and lower-frequency.

## 7. Near-Term Implementation Plan

1. Define `data/events.json` schema.
2. Add static sample events to test UX.
3. Add mobile-first Today / This Week section to `index.html`.
4. Run visual QA on phone-sized viewport.
5. Evaluate practical event sources and terms.
6. Add deterministic event fetch only after source is selected.

## 8. Open Source Questions

Need source evaluation before automation:

- Official central bank calendars for policy events.
- Official exchange holiday calendars.
- Reliable economic calendar source for CPI/jobs/PMI that allows lightweight use.
- Whether an aggregator source is acceptable for MVP if source labels are clear.


## 9. Event validation

Added MVP guardrail:

- `scripts/validate-events.mjs` validates `data/events.json`.
- `npm run check` now includes syntax check + schema validation for event data.
- Empty `events: []` is valid while the calendar source is still manual-seed.
- Allowed impact labels: `High`, `Medium`, `Watch`.
- Allowed dashboard group tags: `FX`, `Rates`, `US`, `KR`, `Semis`, `Commodity`, `Crypto`, `US Futures`, `KIS`.

This keeps the event layer deterministic and separate from the 1-minute market data loop.
