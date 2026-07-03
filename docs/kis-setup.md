# KIS API Setup Notes

## KIS API가 필요한 이유

Yahoo/yfinance로 글로벌 지표는 빠르게 시작할 수 있지만, 한국 특수 지표는 약하다.

- 코스피200선물
- 코스피200 야간선물
- 한국채권 2Y/10Y/30Y
- 국내 실시간성 높은 지표

이 영역은 한국투자증권 KIS Open API가 가장 유력한 공식 후보이다.

## 다니가 할 일

1. 한국투자증권 Open API 신청
2. APP KEY / APP SECRET 발급
3. `projects/stock-dashboard/.env.example`을 `.env`로 복사
4. `.env`에 키 입력

```bash
KIS_MODE=prod
KIS_APP_KEY=...
KIS_APP_SECRET=...
```

## 현재 구현 상태

`src/providers/kis.mjs`에는 다음 껍데기가 있다.

- `getKisAccessToken()` — OAuth token 발급
- `requestKis()` — appkey/appsecret/tr_id 포함 공통 요청
- `fetchKisMetric()` — 대시보드 상태카드 연결

키가 없으면 정상적으로 `🔴 장애: KIS credentials not configured`를 표시한다.

## 다음 연결 순서

1. 키 입력 후 token 발급 확인
2. KIS 공식 문서/샘플에서 코스피200선물 REST 또는 websocket endpoint 확정
3. `KIS_TEST_PATH`, `KIS_TEST_TR_ID`, `KIS_TEST_QUERY`로 smoke test
4. 성공한 endpoint를 실제 metric provider로 분리
5. 한국 선물/채권 카드를 KIS primary로 전환

## Token handling / 24시간 토큰

KIS는 `APP_KEY`와 `APP_SECRET`을 직접 매 요청에 쓰는 방식이 아니라, 먼저 접근토큰을 발급받고 그 토큰으로 API를 호출한다.

현재 구현:

- `src/providers/kis.mjs`가 `/oauth2/tokenP`로 token을 자동 발급
- `data/kis-token-cache.json`에 로컬 캐시
- 만료 10분 전이면 자동으로 새 토큰 발급
- 캐시 파일은 `.gitignore`에 추가됨
- 1분 배치마다 매번 새 토큰을 받지 않으므로 안정적이고 호출 낭비가 적음

수동 token smoke test:

```bash
npm run kis:token
```

강제 재발급:

```bash
npm run kis:token:force
```

정상 예시:

```json
{
  "ok": true,
  "fromCache": false,
  "expiresAt": "...",
  "mode": "prod"
}
```
