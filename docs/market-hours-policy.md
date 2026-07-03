# Market Hours / 1-Minute Batch Policy

## Principle

1-minute batch may run continuously, but provider calls should be conservative:

- Crypto/Binance: 24h fetch OK.
- Yahoo/Naver: current MVP fetches each batch; provider status/marketState is displayed.
- KIS: use explicit market-hours guard where possible to avoid unnecessary calls.

## Implemented Guards

File: `src/market-hours.mjs`

### `kr_derivatives_day`

- Weekdays only
- KST 08:45–15:45
- Used by: `kospi200_futures_kis`
- Outside this window, dashboard shows `⚪ 장종료/휴장` and skips KIS API call.

### `kr_cash_day`

- Weekdays only
- KST 09:00–15:30
- Reserved for future Korean cash-market KIS metrics.

### `kr_derivatives_night`

- Weekdays only
- KST 18:00–05:00 conservative placeholder
- Exact KRX NGT product/session rules still need confirmation before enabling.

## Current KIS Status

- Token issuance verified in paper mode.
- `display-board-futures` REST endpoint verified with KIS:
  - Path: `/uapi/domestic-futureoption/v1/quotations/display-board-futures`
  - TR ID: `FHPIF05030200`
  - Params: `FID_COND_MRKT_DIV_CODE=F`, `FID_COND_SCR_DIV_CODE=20503`, `FID_COND_MRKT_CLS_CODE=`
  - Response included front futures rows such as `F 202606` with `futs_prpr`, `futs_prdy_vrss`, `futs_prdy_ctrt`.
- Dashboard metric added:
  - `kospi200_futures_kis`
  - Provider: `kisFuturesBoard`
  - Active market: `kr_derivatives_day`

## Safety Notes

- Running `npm run fetch` every minute is acceptable from an architecture/token perspective because no AI is called.
- KIS call volume is controlled by market-hours guard for KIS futures.
- Further KIS metrics should each define `activeMarket` before enabling 1-minute polling.
