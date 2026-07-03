# Event Layer UX Spec

> Direction from Dani, 2026-05-06: split the event layer into two clear categories: top `오늘의 이슈` and lower mobile calendar-style `이번주 일정`.

## 1. Information Architecture

### A. 오늘의 이슈 — top situation board

Position: very top of dashboard, above or near mobile capture / quick cards when meaningful.

Purpose: show what can matter **today**.

Include:

1. **주요 인덱스 급변**
   - Example: Nasdaq futures ±1%+, KOSPI200 sharp move, SOX outsized move.
2. **특정 움직임 / 이상 변화**
   - Example: USD/KRW sudden move, US yields jump, BTC/ETH volatility, semis divergence.
3. **오늘 일정 중 장중 변동성을 만들 이벤트**
   - Example: CPI, FOMC, Fed speaker, BOK/BOJ, jobs data, PMI, options expiry.
4. **Short summary line**
   - One concise Korean sentence: “오늘은 CPI 전까지 금리/환율 민감도가 높음.”

UX:

- Top card stack, not calendar grid.
- Each item should be one-line scannable on mobile.
- Badge system:
  - `High` / `Watch` / `Info`
  - related groups: `Rates`, `FX`, `US`, `KR`, `Semis`, `Crypto`
- If no major issue exists, collapse to a small “오늘 큰 이벤트 없음 / 일반 모니터링” state.

### B. 이번주 일정 — calendar below mobile capture

Position: below mobile capture / quick index area.

Purpose: weekly planning context.

UX:

- Calendar-like weekly strip/card.
- Days as sections: Mon / Tue / Wed / Thu / Fri / Weekend.
- Today highlighted.
- High-impact events visually emphasized.
- Mobile-first: horizontal day tabs or compact stacked day cards.

Suggested mobile layout:

```text
이번주 일정
[오늘 Wed] [Thu] [Fri] [Weekend]

Wed 5/6
21:30 CPI · High · Rates/FX
23:00 Fed speaker · Watch

Thu 5/7
...
```

## 2. Data Schema Draft

File: `data/events.json`

```json
{
  "generatedAt": "2026-05-06T00:00:00.000Z",
  "sourceNotes": [
    {
      "name": "오선 주간 캘린더",
      "type": "creator_reference",
      "url": "",
      "usage": "manual_or_semiauto_reference"
    }
  ],
  "todayIssues": [
    {
      "id": "issue-1",
      "type": "scheduled_event | market_move | anomaly | summary",
      "timeKst": "21:30",
      "title": "미국 CPI",
      "impact": "High",
      "relatedGroups": ["Rates", "FX", "US Futures"],
      "summary": "금리와 달러 방향성을 만들 수 있는 핵심 이벤트",
      "source": "오선 주간 캘린더 / official cross-check",
      "status": "upcoming | live | done | watch"
    }
  ],
  "weeklyEvents": [
    {
      "date": "2026-05-06",
      "dayLabel": "Wed",
      "events": [
        {
          "timeKst": "21:30",
          "title": "미국 CPI",
          "impact": "High",
          "relatedGroups": ["Rates", "FX"],
          "source": "오선 주간 캘린더"
        }
      ]
    }
  ]
}
```

## 3. Source Plan — 오선 Weekly Calendar

Dani suggested using a YouTuber called `오선`, who operates a weekly calendar.

Initial policy:

- Use as a **reference source**, not a blind automated scrape, until terms/format are checked.
- Prefer source attribution in dashboard: `출처: 오선 주간 캘린더`.
- If the calendar is in video/community image form, initial MVP can use manual or semi-manual extraction into `data/events.json`.
- Cross-check high-impact macro events against official/secondary sources when practical.

Risk notes:

- YouTube video/community content may not be stable for machine extraction.
- Direct reuse of full calendar image/text may raise copyright concerns.
- Safer MVP: extract only factual event metadata: date, time, event name, impact, source link.

## 4. Implementation Steps

1. Find and inspect 오선 calendar source format.
2. Create sample `data/events.json` with placeholder/example events.
3. Add dashboard UI:
   - top `오늘의 이슈`
   - lower `이번주 일정` calendar cards
4. Add source attribution and empty states.
5. Visual QA on mobile width.
6. Later automate only if source format and terms are acceptable.

## 5. Weekly Update Operating Rule

Dani's direction on 2026-05-06:

- Update the event calendar weekly.
- Usually after **Sunday 20:00 KST**, check the `오선의 미국 증시 라이브` YouTube community board for the new weekly calendar post.
- Use the post as a creator-reference source and extract only factual event metadata: date, time, event name, impact, and related groups.
- Keep source attribution visible.

## 6. Structural Market-Flow Events

The calendar should also include events that can move index flows even if they are not in the weekly creator calendar.

Include and source separately:

- Korea futures/options expiry dates.
- US futures/options expiry dates.
- US monthly options expiration / quarterly triple- or quad-witching style dates.
- Exchange holidays and shortened sessions.
- Major index rebalancing dates if they are known and relevant.

UX rule:

- These should appear in `이번주 일정` as calendar items.
- If they are today and likely to create intraday volatility, promote them into `오늘의 이슈`.
