# KIS KRX NGT Night Futures Plan

## What was confirmed from KIS official GitHub examples

KRX night futures examples are real-time subscription APIs, not simple REST quote endpoints.

### Night futures order book / asking price

- Example: `domestic_futureoption/krx_ngt_futures_asking_price`
- TR ID: `H0MFASP0`
- Example `tr_key`: `101W9000`
- Function shape: `data_fetch(tr_id, tr_type, { tr_key })`
- Meaning: websocket-style realtime subscribe/unsubscribe

### Night futures execution / trade ticks

- Example: `domestic_futureoption/krx_ngt_futures_ccnl`
- TR ID: `H0MFCNT0`
- Example `tr_key`: `101W9000`
- Output includes:
  - `futs_prpr` current price
  - `futs_prdy_vrss`
  - `futs_prdy_ctrt`
  - `acml_vol`
  - `bsop_hour`

## Important implication

Unlike the day futures REST board already tested, KRX NGT appears to require KIS realtime/websocket flow. The next technical task is:

1. Confirm KIS realtime approval key flow.
2. Implement minimal websocket subscribe test for paper mode.
3. Subscribe to `H0MFCNT0` with `tr_key=101W9000` during night session.
4. Parse tick columns and map current price into dashboard.

## Timing

Conservative placeholder for `kr_derivatives_night` in `src/market-hours.mjs`:

- KST 18:00–05:00, weekdays only

This needs confirmation against actual KRX NGT operation/product behavior, but it is a reasonable first check window.

## Night check plan

- At/after 18:00 KST, verify KIS token still valid.
- Confirm whether NGT realtime websocket connection can be implemented/tested.
- If websocket details are missing, mark as implementation blocker and keep dashboard stable without polling an unconfirmed endpoint every minute.

## 2026-04-30 18:06 smoke-test result

Implemented and tested `scripts/kis-ngt-ws-smoke.mjs`.

- Approval key: success in paper mode.
- Websocket URL: `ws://ops.koreainvestment.com:31000`.
- `H0MFCNT0` + `101W9000`: `SUBSCRIBE SUCCESS`.
- `H0MFASP0` + `101W9000`: `SUBSCRIBE SUCCESS`.
- No actual price tick arrived inside the short 12-second smoke window.

Next step:

- Build a persistent lightweight websocket collector for night futures.
- It should keep one connection open during `kr_derivatives_night`, write latest received tick to `data/kis-ngt-latest.json`, and let the dashboard read that file.
- Do not poll websocket every minute; one persistent connection is more appropriate.
