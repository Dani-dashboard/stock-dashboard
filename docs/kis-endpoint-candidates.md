# KIS Endpoint Candidates

작성일: 2026-04-30
목적: KIS 키 입력 후 바로 smoke test할 후보 endpoint/TR-ID를 정리한다. 실제 path/필수 파라미터는 KIS 공식 문서/샘플로 재확인 필요.

## 전제

- 현재는 credential 없이 구조만 준비한 상태.
- `src/providers/kis.mjs`는 OAuth token 발급과 공통 REST 요청 껍데기를 갖고 있다.
- `.env`에 `KIS_TEST_PATH`, `KIS_TEST_TR_ID`, `KIS_TEST_QUERY`를 넣으면 smoke test 카드로 연결 상태를 볼 수 있다.

## 후보 1: 코스피200 선물 호가 / 실시간 quote

| 항목 | 내용 |
|---|---|
| 카테고리 | `domestic_futureoption` |
| 기능 후보 | `index_futures_realtime_quote` |
| TR ID 후보 | `H0IFASP0` |
| 용도 | 코스피200 선물 호가/현재가 후보 |
| 필요한 것 | 상품 코드/종목 코드 매핑 확인 |
| 신뢰도 | 중간-높음. 기존 KIS 샘플명/TR-ID 확인 기반 |

## 후보 2: KRX NGT / 야간선물 호가

| 항목 | 내용 |
|---|---|
| 카테고리 | `domestic_futureoption` |
| 기능 후보 | `krx_ngt_futures_asking_price` |
| TR ID 후보 | `H0MFASP0` |
| 관련 후보 | `krx_ngt_futures_ccnl`, `krx_ngt_futures_ccnl_notice` |
| 용도 | 코스피200 야간선물 난점 해결 후보 |
| 필요한 것 | KRX NGT 상품 코드, 실시간/REST 구분, 거래시간 확인 |
| 신뢰도 | 중간. 샘플 존재 확인, 실제 파라미터 미확정 |

## 후보 3: 선물옵션 시간별 차트/현재가

| 항목 | 내용 |
|---|---|
| 카테고리 | `domestic_futureoption` |
| 기능 후보 | `inquire_time_fuopchartprice`, `inquire_price` |
| TR ID 후보 | 미확정 |
| 용도 | 1분 대시보드용 current/최근 tick 후보 |
| 필요한 것 | KIS 문서에서 REST path/TR-ID/입력 필드 확인 |
| 신뢰도 | 중간 |

## 후보 4: 국내채권 현재가/호가

| 항목 | 내용 |
|---|---|
| 카테고리 | `domestic_bond` |
| 기능 후보 | `inquire_price`, `bond_asking_price`, `bond_ccnl`, `bond_index_ccnl` |
| TR ID 후보 | `FHKBJ773400C0` (`inquire_price` 후보) |
| 예시 종목코드 | `KR2033022D33` 메모 존재 |
| 용도 | 한국채 2Y/10Y/30Y 직접/대체 데이터 후보 |
| 필요한 것 | 만기별 국고채 ISIN 매핑, 수익률 필드 존재 여부 확인 |
| 신뢰도 | 중간. 샘플 존재 확인, 대시보드 지표와 직접 매핑은 미검증 |

## 키 입력 후 테스트 순서

1. `.env`에 `KIS_APP_KEY`, `KIS_APP_SECRET` 입력.
2. `npm run fetch` 실행해 token 발급 여부 확인.
3. KIS 공식 샘플에서 가장 단순한 REST 조회 path/TR-ID를 골라 `KIS_TEST_PATH`, `KIS_TEST_TR_ID`, `KIS_TEST_QUERY`에 입력.
4. `KIS 연결 테스트` 카드가 `🟢 KIS_CONNECTED`로 바뀌는지 확인.
5. 성공한 endpoint를 `src/providers/kis.mjs`에서 실제 metric fetcher로 분리.

## 다음 구현 판단

- 가장 먼저 붙일 KIS 지표는 `코스피200선물`이 좋다. 사용 가치가 높고 Yahoo 후보가 약하기 때문.
- 그다음 `KRX NGT 야간선물`.
- 국내채권은 ISIN/수익률 필드 검증이 필요해서 3순위.
