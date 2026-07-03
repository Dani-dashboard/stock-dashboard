# KIS Credential Checklist for Dani

오후 5시에 KIS API 정보를 넣을 때 필요한 항목.

## 절대 채팅으로 보내지 말 것

가능하면 실제 키는 텔레그램에 보내지 말고, iMac에서 직접 `.env`에 붙여넣기.

```bash
cd /Users/dani/.openclaw/workspace/projects/stock-dashboard
cp .env.example .env
open -e .env
```

## 필요한 값

```bash
KIS_MODE=prod     # 실전이면 prod, 모의투자면 paper
KIS_APP_KEY=...
KIS_APP_SECRET=...
KIS_ACCOUNT_NO=...
KIS_ACCOUNT_PRODUCT_CODE=01
```

초기 token smoke test에는 `APP_KEY`와 `APP_SECRET`만 있어도 충분할 가능성이 높다. 실제 주문/계좌성 조회가 아니라 시세 조회 중심이면 계좌번호가 필요 없는 endpoint도 있을 수 있다.

## 키 입력 후 내가 할 일

1. `npm run fetch`로 KIS token 발급 여부 확인
2. KIS endpoint 후보 중 가장 단순한 시세 조회 smoke test
3. 성공한 endpoint를 실제 metric fetcher로 분리
4. 코스피200선물 → 야간선물 → 국내채권 순서로 연결

## 현재 KIS 후보 문서

- `docs/kis-endpoint-candidates.md`
- `docs/kis-setup.md`
