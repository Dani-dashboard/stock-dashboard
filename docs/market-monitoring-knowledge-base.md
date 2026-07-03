# Market Monitoring Knowledge Base

> Purpose: Build a reusable market-interpretation library for the dashboard so `오늘의 이슈` and future 30-minute summaries can distinguish important vs. noisy moves and use professional market language.

This is not investment advice. It is a monitoring and wording framework.

## 1. Core Monitoring Philosophy

The dashboard should not merely report numbers. It should detect and explain market context:

1. **Direction** — what moved?
2. **Magnitude** — is the move meaningful?
3. **Cross-asset confirmation** — do FX, rates, futures, equities, commodities agree?
4. **Catalyst** — is there a scheduled event or structural flow behind it?
5. **Market implication** — risk-on, risk-off, inflation concern, liquidity pressure, KRW strength, etc.

Good summary format:

```text
[What happened] → [market-native interpretation] → [why it matters]
```

Example:

```text
USD/KRW가 5일 지지선을 하향 이탈하며 원화 강세가 확대. 달러 약세와 외국인 수급 개선 가능성을 함께 점검할 필요.
```

## 2. Cross-Asset Interpretation Map

### FX — USD/KRW, EUR/KRW, JPY/KRW x100

| Move | Professional interpretation | Watch with |
|---|---|---|
| USD/KRW down | 원화 강세 / 달러 약세 / 원화 절상 | KOSPI, KOSPI200, 외국인 수급, DXY |
| USD/KRW up | 원화 약세 / 달러 강세 / 원화 절하 | DXY, US yields, risk-off assets |
| USD/KRW below support | 단기 박스권 하단 이탈 / 원화 강세 가속 | KOSPI200, EWY, KR futures |
| USD/KRW above resistance | 원화 약세 압력 확대 / 달러 강세 재개 | DXY, US yields, KOSPI weakness |
| JPY/KRW up | 엔화 상대 강세 또는 원화 약세 | risk-off, BOJ, USD/JPY context |
| JPY/KRW down | 엔화 상대 약세 또는 원화 강세 | Japan rates, global risk appetite |

Important wording:

- For `foreign currency / KRW` pairs, a lower pair means KRW is stronger against that currency.
- Do not say only “환율 하락.” Prefer the market implication: `원화 강세`, `달러 약세`, `원화 절상`.

### Rates — US 2Y / 10Y / 30Y, KR10Y, JP10Y

| Move | Professional interpretation | Watch with |
|---|---|---|
| US 2Y up | 정책금리 경로 재가격 / 매파적 금리 반응 | DXY, Nasdaq futures |
| US 10Y up | 장기금리 상승 / 할인율 부담 / 기간프리미엄 확대 | Nasdaq, SOX, gold, USD |
| US 30Y up | 장기물 공급 부담 / 재정·기간프리미엄 우려 | QRA, auctions, equity duration |
| US yields down | 금리 부담 완화 / 성장주 우호 | Nasdaq, SOX, gold |
| Curve steepening | 장기물 부담 또는 성장/물가 재평가 | 10Y-2Y, QRA, inflation data |
| Curve flattening | 정책금리 부담/경기둔화 우려 | 2Y, labor data, recession narrative |

Event sensitivity:

- CPI/PCE/PPI: inflation repricing → 2Y/10Y/DXY/Nasdaq.
- Payrolls/jobless claims/JOLTs: labor strength/weakness → 2Y/DXY/equities.
- QRA/Treasury auctions: long-end supply → 10Y/30Y/equity duration pressure.

### US Equity / Futures — Nasdaq, S&P, Dow, SOX, EWY, DRAM

| Move | Professional interpretation | Watch with |
|---|---|---|
| Nasdaq futures up | 성장주 위험선호 / 할인율 부담 완화 가능 | US yields, DXY, SOX |
| Nasdaq futures down | 성장주 리스크오프 / 금리 또는 실적 부담 | US 10Y, SOX, mega-cap earnings |
| SOX up | 반도체/AI 체인 강세 | DRAM, Nasdaq, TSMC/NVDA/AMD news |
| SOX down | 반도체 리스크오프 / AI 체인 부담 | Nasdaq, DRAM, Korea semis |
| EWY up | 한국 위험자산 선호 / 원화 또는 반도체 연동 가능 | USD/KRW, KOSPI200, SOX |
| EWY down | 한국 익스포저 약세 / 외국인 수급 부담 가능 | USD/KRW, SOX, KOSPI |

Important distinction:

- Cash index closed-market values should not be described as active moves.
- Futures are useful for pre-market / overnight direction.

### Korea — KOSPI, KOSPI200, KOSDAQ, KOSPI200 futures

| Move | Professional interpretation | Watch with |
|---|---|---|
| KOSPI/KOSPI200 up with USD/KRW down | 원화 강세 + 위험선호 조합 | foreign flow proxy, EWY, SOX |
| KOSPI down with USD/KRW up | 원화 약세 + 리스크오프 가능 | DXY, US yields, SOX |
| KOSDAQ strong | 성장/개별주 위험선호 | rates, biotech/secondary themes |
| KOSPI200 futures divergence | 선물 수급/헤지 흐름 가능 | basis, expiry calendar |

Structural flow events:

- Korea options expiry: usually second Thursday monthly.
- Korea futures/options simultaneous expiry: quarterly, usually second Thursday of Mar/Jun/Sep/Dec.
- These can create intraday or close-driven flow volatility.

### Commodities — WTI, Gold

| Move | Professional interpretation | Watch with |
|---|---|---|
| WTI up | 유가 상승 / 인플레이션 압력 / 에너지 민감 | CPI expectations, yields |
| WTI down | 인플레 압력 완화 or 수요 둔화 우려 | yields, equities, DXY |
| Gold up with yields down | 실질금리 하락 수혜 / 안전자산 선호 | US 10Y, DXY |
| Gold up with risk-off | 안전자산 수요 | VIX, equities, USD |
| Gold down with yields up | 실질금리 부담 | US real yields proxy |

### Crypto — BTC / ETH

| Move | Professional interpretation | Watch with |
|---|---|---|
| BTC up with Nasdaq up | 위험선호 강화 | Nasdaq, DXY |
| BTC down with Nasdaq down | 고베타 리스크오프 | DXY, rates |
| BTC diverges strong | crypto-specific catalyst / liquidity impulse | Coinbase, ETF flows, regulation |

## 3. Importance Classification

### High

Use `High` when:

- Major scheduled event today: CPI, payrolls, FOMC, PCE, QRA, major central bank decision.
- FX support/resistance break, not just proximity.
- Nasdaq/S&P futures move >= ±1.0% pre-market/overnight.
- SOX or semiconductor proxy move >= ±2.0%.
- USD/KRW move >= ±0.7% intraday or breaks 5-day range.
- US 10Y move >= ±8–10 bp intraday.
- OpEx / futures-options expiry today.
- Major source failure affects core dashboard reliability.

### Watch

Use `Watch` when:

- Price is testing support/resistance but not broken.
- Moderate scheduled event: jobless claims, PMI, ISM, Fed speakers, EIA inventory.
- Futures move around ±0.4–1.0%.
- USD/KRW move around ±0.3–0.7%.
- US 10Y move around ±4–8 bp.
- Semis or EWY diverge from broad index.

### Info

Use `Info` when:

- Event is relevant but unlikely to move market alone.
- Calendar/earnings item is contextual.
- Data source note or dashboard status item.

## 4. Today Issues Detection Rules

Priority order for `오늘의 이슈`:

1. Active High market breaks:
   - FX support/resistance break.
   - Major futures/index move.
   - US yield shock.
2. Today’s High scheduled events.
3. Structural flow events today.
4. Cross-asset divergence.
5. Watch-level items.

Avoid overcrowding:

- Show top 3–5 issues on mobile.
- Collapse remaining issues if needed.

## 5. Market-Native Wording Templates

### FX

```text
USD/KRW 5일 지지선 하향 이탈 — 원화 강세 / 달러 약세 압력
현재 {current}원 · 5일 지지 {support}원. 단기 박스권 하단 이탈로 원화 절상 흐름이 강화되는지 관찰.
```

```text
USD/KRW 5일 저항선 상향 돌파 — 원화 약세 / 달러 강세 압력
현재 {current}원 · 5일 저항 {resistance}원. 달러 강세와 위험회피가 결합되는지 확인 필요.
```

### Rates

```text
미국 10Y 금리 급등 — 성장주 할인율 부담 확대
10Y가 {move}bp 상승. Nasdaq/SOX의 밸류에이션 압박과 달러 반응을 함께 점검.
```

### Equity

```text
SOX 급락 — 반도체 리스크오프
SOX가 {pct}% 하락. AI/반도체 체인 심리 약화 여부와 DRAM/EWY 동조를 확인.
```

### Structural Events

```text
미국 월간 OpEx — 장중/마감 수급성 변동성 유의
옵션 만기일에는 주요 지수와 대형주의 핀ning/헤지 플로우가 변동성을 만들 수 있음.
```

## 6. Source and Confidence Language

Use confidence labels:

- `confirmed`: source is direct and timestamp is fresh.
- `stale`: value exists but source timestamp is old.
- `reference`: useful reference but not live.
- `candidate`: rule-based/needs official cross-check.

Example:

```text
KR10Y는 Naver/Reuters 레퍼런스 기준값은 있으나 timestamp가 오래되어 stale reference로 표시.
```

## 7. Implementation Notes

- The 1-minute fetch loop should produce raw facts and deterministic flags.
- `오늘의 이슈` should translate facts into professional wording using this knowledge base.
- Future 30-minute summary should use this KB as the style/interpretation guide.
- Keep this file updated whenever Dani corrects market language or priority judgment.
