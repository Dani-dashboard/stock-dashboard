# Status and Fallback Policy

다니 결정 반영: 무료 소스 장애 시 숨기지 않고 `장애`로 띄운다. 1분마다 API/스크래핑 확인 결과를 지표별 status로 갱신한다.

## 상태 규칙

| 상태 | 의미 | 화면 처리 |
|---|---|---|
| 🟢 정상 | 수집 성공, 최신 tick이 stale 기준 이내 | 값/등락 표시 |
| 🟡 지연/검증필요 | 응답은 왔지만 최신 tick이 오래됐거나 보조소스/검증필요 | 값은 표시하되 경고 노출 |
| ⚪ 장종료/휴장 | source가 장종료 상태를 반환 | 마지막 값과 장종료 표시 |
| 🔴 장애 | timeout, HTTP error, parsing error, 인증 미설정/실패 | 값 `—`, 장애 메시지 표시 |

## 현재 stale 기준

`.env`에서 조정 가능.

```bash
DATA_STALE_SECONDS=180
```

즉 3분 넘게 새 tick이 없으면 `🟡 지연/검증필요`로 내려간다. 실제 거래가 거의 없는 지표는 과하게 경고가 뜰 수 있어, MVP 사용 중 조정한다.

## Fallback 원칙

1. Primary source 시도
2. 실패하면 fallback source가 있는 지표만 보조 소스 시도
3. fallback도 실패하면 `🔴 장애`
4. 성공/실패와 무관하게 `fetchedAt`, `timestamp`, `provider`, `status.message` 기록

## 현재 구현 범위

- Yahoo/yfinance 후보: 구현됨
- Binance BTC/ETH: 구현됨
- KIS: 인증/공통요청 껍데기 구현됨, 실제 지표 매핑은 키 입력 후 endpoint 확정 필요
- Naver index provider: 구현됨. KOSPI/KOSDAQ/KOSPI200 우선 소스로 사용 중
- Naver fallback for broader overseas/other assets: 다음 단계
