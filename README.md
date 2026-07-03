# Stock / Index Dashboard MVP

무료 소스 우선 1분 갱신 대시보드. 무료 API나 스크래핑 후보가 실패하면 값을 숨기지 않고 지표별로 `🔴 장애`를 표시한다.

## 실행

```bash
cd projects/stock-dashboard
npm run fetch
npm run serve
```

브라우저에서 `http://127.0.0.1:8787/index.html` 열기.

## KIS 키 넣기

```bash
cp .env.example .env
# .env 안에 KIS_APP_KEY / KIS_APP_SECRET 입력
```

실제 키는 `.env`에만 저장한다. `.env.example`은 공유 가능한 템플릿이다.

## 현재 구조

- `config/metrics.json` — 지표 목록과 provider 매핑
- `scripts/fetch-all.mjs` — 1회 수집 후 `data/latest.json` 생성
- `src/providers/yahoo.mjs` — Yahoo chart 1분 데이터
- `src/providers/binance.mjs` — BTC/ETH Binance 데이터
- `src/providers/kis.mjs` — KIS 인증/요청 껍데기
- `src/providers/naver.mjs` — 네이버 모바일 지수 JSON 후보
- `index.html` — 로컬 대시보드

## 1분 반복 갱신

```bash
./scripts/run-every-minute.sh
```

운영 자동화는 MVP 화면/데이터 품질을 본 뒤 cron/launchd에 등록한다.
