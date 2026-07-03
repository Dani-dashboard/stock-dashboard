# Market Language Style Guide

> Purpose: Make dashboard summaries sound like a finance / macro / market professional, not a generic alert bot.

## 1. Core Principle

Use market-native phrasing that explains direction and implication.

Bad:

- `USD/KRW support near`
- `환율 하락`
- `지표 변동`

Better:

- `USD/KRW 5일 지지선 하향 이탈 — 원화 강세 / 달러 약세 압력`
- `원화가 강하게 절상되며 USD/KRW가 단기 박스권 하단을 이탈`
- `금리 급등 → 성장주/나스닥 밸류에이션 부담`

## 2. FX Direction Rules

For KRW crosses shown as `foreign currency / KRW`:

### USD/KRW

- USD/KRW **falls** → KRW strengthens / USD weakens.
  - Korean wording: `원화 강세`, `달러-원 하락`, `원화 절상`, `달러 약세 압력`.
- USD/KRW **rises** → KRW weakens / USD strengthens.
  - Korean wording: `원화 약세`, `달러-원 상승`, `원화 절하`, `달러 강세 압력`.

### EUR/KRW / JPY/KRW x100

- Pair falls → KRW strengthens against EUR/JPY.
- Pair rises → KRW weakens against EUR/JPY.

Avoid saying only “환율 하락” when the market implication matters. Prefer “원화 강세” or “원화 약세”.

## 3. Support / Resistance Language

- Price below support: `지지선 하향 이탈`, `박스권 하단 이탈`, `하방 돌파`.
- Price above resistance: `저항선 상향 돌파`, `박스권 상단 돌파`, `상방 돌파`.
- Near but not broken:
  - Above support and close to it: `지지선 테스트`, `지지선 근접`.
  - Below resistance and close to it: `저항선 테스트`, `저항선 근접`.

For dashboard alerts:

- Break = `High`.
- Near/test = `Watch`.
- If current is below support, do **not** call it “near support”. It is a break.

## 4. Rates Language

- Yield up: `금리 상승`, `채권가격 하락`, `할인율 부담`, `성장주/나스닥 밸류에이션 부담`.
- Yield down: `금리 하락`, `채권가격 상승`, `할인율 부담 완화`, `성장주에 우호적`.
- Long-end rise after Treasury issuance/QRA: `장기물 공급 부담`, `기간프리미엄 확대 가능성`.

## 5. Equity Index Language

- Nasdaq / SOX strong: `성장주·반도체 위험선호`, `AI/반도체 체인 강세`.
- Nasdaq / SOX weak: `성장주 부담`, `반도체 리스크오프`, `고밸류 압박`.
- Futures diverge from cash: `선물 선행 약세/강세`, `현물 개장 전 방향성`.

## 6. Commodities Language

- WTI up: `유가 상승`, `인플레이션 기대/에너지 섹터 민감`.
- WTI down: `유가 하락`, `인플레이션 압력 완화`, `수요 둔화 우려 가능`.
- Gold up with rates down/USD down: `안전자산 또는 실질금리 하락 수혜`.

## 7. Event Layer Language

For `오늘의 이슈`, each item should contain:

1. What happened / will happen.
2. Direction in market-native terms.
3. Why it matters for dashboard groups.

Example:

```text
USD/KRW 5일 지지선 하향 이탈 — 원화 강세
현재 1,455.9원 · 5일 지지 1,456.2원. 달러 약세/원화 절상 흐름이면 한국 위험자산과 외국인 수급에 우호적일 수 있음.
```

## 8. Sources / Basis

Reference basis used while creating this guide:

- CFI currency pair explanation: currency pairs quote one currency against another; first currency is base, second is quote.
- Standard technical-analysis usage: support is a lower price area where buying interest may appear; resistance is an upper price area where selling pressure may appear.

This guide is a local writing standard, not investment advice.
