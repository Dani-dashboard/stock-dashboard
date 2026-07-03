# Local Runbook

## 1회 수집

```bash
npm run fetch
```

## 로컬 대시보드 열기

```bash
npm run serve
# http://127.0.0.1:8787/index.html
```

## 1분 반복 수집

```bash
./scripts/run-every-minute.sh
```

운영 자동화는 MVP 화면/데이터 품질을 본 뒤 launchd로 등록한다. 지금은 안전하게 수동 루프만 제공한다.
