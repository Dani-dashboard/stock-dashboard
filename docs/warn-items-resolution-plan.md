# Warn Items Resolution Plan

작성일: 2026-04-30
목적: 대시보드의 주황색(`warn`) 항목이 왜 남아있는지, 언제/어떻게 확인하고 해결할지 명확히 관리한다.

## Current warn items

2026-04-30 22:47 기준:

1. 미국채 2Y 후보
2. 한국채 10Y
3. 일본채 10Y
4. 코스피200 야간선물

---

## 1. 미국채 2Y 후보

### 현재 문제

- Yahoo에서 `^TNX` 10Y, `^TYX` 30Y는 확인됨.
- 2Y 현물 수익률에 해당하는 명확한 Yahoo 1분 ticker가 아직 확정되지 않음.
- `2YY=F`는 존재하지만 “2-Year Yield Futures”라서 현물 2년물 금리와 직접 동일하다고 표시하면 위험함.

### 확인 방법

1. Yahoo/Investing/MarketWatch/Stooq/FRED 후보 재검색.
2. 후보가 있으면 1분 endpoint 응답 여부 확인.
3. 실제 2Y 현물 금리와 값 단위/방향 비교.
4. 현물 금리로 확정되면 대시보드에 값 표시.
5. 선물/ETF/프록시라면 이름을 `미국채 2Y 프록시`로 명확히 바꾸거나 제외.

### 해결 기준

- **Go:** 현물 또는 공신력 있는 지표성 ticker가 확인되고, 소수점 3자리 표시 가능.
- **Keep pending:** 후보가 프록시뿐이면 주황색 유지.
- **Remove:** 신뢰 낮은 프록시만 있으면 대시보드에서 제외 가능.

---

## 2. 한국채 10Y

### 현재 문제

- KIS `domestic_bond` 샘플은 존재.
- 하지만 한국채 10Y에 해당하는 현재 on-the-run 국고채 ISIN/종목코드와 수익률 필드 매핑이 아직 미확정.
- 잘못된 채권 종목 하나를 10Y 대표처럼 표시하면 안 됨.

### 확인 방법

1. KIS GitHub `domestic_bond` 샘플 세부 path/TR-ID 확인.
2. KIS bond master 또는 공식/금투협/거래소 자료에서 10Y 지표 채권 코드 확인.
3. KIS REST smoke test:
   - `domestic_bond/inquire_price`
   - `bond_index_ccnl`
   - `bond_asking_price`
4. 응답 필드 중 수익률/yield에 해당하는 필드 식별.
5. 값이 외부 기준과 비슷한지 교차 확인.

### 해결 기준

- **Go:** KIS 또는 공식 소스에서 10Y 대표 수익률 확인.
- **Fallback:** 금투협/공공/네이버 등 일중 지연 데이터라도 신뢰 가능하면 `지연`으로 표시.
- **Keep pending:** ISIN/수익률 필드 미확정이면 주황색 유지.

---

## 3. 일본채 10Y

### 현재 문제

- Yahoo search/chart에서 명확한 JGB 10Y 1분 ticker를 아직 찾지 못함.
- 일본채 10Y는 무료 실시간/1분 소스가 제한적일 가능성이 있음.

### 확인 방법

1. Yahoo/Stooq/Investing/TradingView 심볼 후보 조사.
2. 일본 재무성/거래소/공공 source가 실시간에 가까운지 확인.
3. 후보가 delayed daily/near-real-time인지 구분.
4. 신뢰 가능한 delayed source라도 있으면 `지연` 상태로 표시.

### 해결 기준

- **Go:** 신뢰 가능한 JGB 10Y yield source 확인.
- **Delayed:** 실시간은 아니지만 공신력 있는 지연값이면 명확히 `지연` 표시.
- **Keep pending/remove:** 무료 소스가 너무 약하면 보류 또는 제외.

---

## 4. 코스피200 야간선물

### 현재 문제

- KIS websocket approval key 성공.
- `H0MFCNT0`, `H0MFASP0` 모두 `SUBSCRIBE SUCCESS` 확인.
- 여러 tr_key 후보도 구독은 성공:
  - `101V06`
  - `101W9000`
  - `101W06`
  - `101T06`
  - `101W09`
- 하지만 아직 live price tick이 들어오지 않음.

### 가능한 원인

1. 현재 모의투자 websocket은 구독 성공만 반환하고 실제 tick이 제한될 수 있음.
2. active night futures tr_key가 다를 수 있음.
3. 실제 거래/체결이 드물어 짧은 테스트 시간에 tick이 없었을 수 있음.
4. 호가 TR은 체결보다 tick 가능성이 높으므로 collector가 호가도 함께 들어야 할 수 있음.

### 확인 방법

1. `fo_cme_code.mst`와 `fo_idx_code_mts.mst` 코드 매핑 비교.
2. WebSocket collector를 30초가 아니라 10–30분 이상 야간 세션에 유지.
3. 체결 `H0MFCNT0`뿐 아니라 호가 `H0MFASP0`도 collector에 추가.
4. 수신 raw message를 `logs/ngt-ws/`에 bounded 저장.
5. 실제 live tick 수신 시 `data/kis-ngt-latest.json`에 기록하고 dashboard 값 표시.

### 해결 기준

- **Go:** live tick 수신 + 가격 필드 parse 성공.
- **Partial:** 구독 성공/무틱이면 `구독대기` 유지.
- **Blocked:** 모의투자 websocket이 실시간 tick을 제공하지 않는 것으로 확인되면 실전키/다른 source 필요 여부를 Dani에게 문의.

---

## Next execution order

1. NGT collector를 호가+체결 동시 구독 구조로 개선.
2. NGT collector를 야간에 더 오래 실행해 tick 수신 여부 확인.
3. KIS domestic_bond 샘플 상세 조사 및 한국채 10Y smoke test.
4. 미국 2Y/Japan 10Y source search and validation.

## Display rule

주황색은 실패가 아니라 “값을 확정 표시하기 전에 검증 중”이라는 뜻이다. 값이 불확실하면 숫자를 보여주지 않는다.

## 2026-05-01 progress update

- 한국채 10Y: partially resolved. KIS bond endpoint works and `KR103502GFC1` (`국고03250-3512(25-11)`) returns `ernn_rate`. Dashboard now shows `kr10y` with 3 decimals. Continue validating whether this is the best representative 10Y benchmark.
- 미국채 2Y: Yahoo direct cash-yield candidates failed. `2YY=F` and `ZT=F` exist but are futures/proxies, so do not display as cash yield yet.
- 일본채 10Y: tested several Yahoo candidates and no valid chart endpoint found. Remains pending.
- 코스피200 야간선물: more tr_key candidates accepted subscription; no tick yet. A single non-overlapping night watch is scheduled for next night session.
