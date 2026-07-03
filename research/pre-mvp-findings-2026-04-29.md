# Pre-MVP Findings - Stock Dashboard

작성일: 2026-04-29
상태: MVP 구현 직전 검증 진행 중

## 1. 네이버증권 모바일: 기술적 가능성

### 확인한 사실

네이버 모바일 증권은 일부 데이터를 구조화된 JSON endpoint로 제공한다.

확인된 예시:

- `https://m.stock.naver.com/api/stock/005930/basic`
- `https://m.stock.naver.com/api/stock/005930/integration`
- `https://m.stock.naver.com/api/stock/005930/price`
- `https://m.stock.naver.com/api/index/KOSPI/integration`
- `https://m.stock.naver.com/api/index/KOSDAQ/integration`
- `https://m.stock.naver.com/api/index/KOSPI/price?pageSize=5&page=1`
- `https://api.stock.naver.com/index/.DJI/basic`
- `https://api.stock.naver.com/index/.DJI/price`
- `https://api.stock.naver.com/index/.IXIC/basic`
- `https://api.stock.naver.com/index/.INX/basic`
- `https://api.stock.naver.com/index/.NDX/basic`
- `https://api.stock.naver.com/index/.SOX/basic`
- `https://api.stock.naver.com/index/.VIX/basic`
- `https://api.stock.naver.com/index/.SSEC/basic`
- `https://api.stock.naver.com/index/.SZSC/basic`
- `https://api.stock.naver.com/index/.N225/basic`
- `https://api.stock.naver.com/index/.TWII/basic`
- `https://api.stock.naver.com/index/.HSI/basic`
- `https://api.stock.naver.com/index/.HSCE/basic`
- `https://api.stock.naver.com/index/.STOXX50E/basic`

`basic` 응답에는 현재가, 전일대비, 등락률, marketStatus, 현지 거래시각, 거래소 시간대, startTime/endTime 등이 포함되는 것으로 보인다. 이는 대시보드의 상태 표시와 장시간 판단에 매우 유용하다.

### 의미

네이버 모바일은 단순 HTML 스크래핑보다 나은 형태의 JSON endpoint가 존재한다. 따라서 fallback 또는 한국 사용자 기준 검증 소스로 쓸 가능성이 있다.

### 제한/리스크

- 공식 공개 API로 문서화된 것이 아니므로 장기 안정성은 보장되지 않는다.
- endpoint 구조가 변경되면 깨질 수 있다.
- 1분마다 다수 지표를 호출하면 차단/제한 리스크가 있다.
- 약관상 자동 수집 허용 여부는 별도 확인 필요하다.
- Primary source로 쓰기보다는 보조/fallback/검증 소스로 두는 것이 안전하다.

### 잠정 판단

- 네이버 모바일 JSON endpoint는 “가능성 높음”.
- 다만 MVP 1차 primary는 `yfinance + Binance`, 한국 난점/fallback으로 네이버를 검토하는 편이 안전하다.

## 2. 한국투자증권 KIS Open API: 국내 파생/채권 가능성

### 확인한 사실

한국투자증권 공식 GitHub 샘플에는 다음 카테고리가 존재한다.

- `domestic_futureoption`
- `domestic_bond`
- `overseas_futureoption`

특히 `domestic_futureoption` 하위에 다음 기능이 있다.

- `index_futures_realtime_quote` — TR ID `H0IFASP0`
- `index_futures_realtime_conclusion`
- `krx_ngt_futures_asking_price` — TR ID `H0MFASP0`
- `krx_ngt_futures_ccnl`
- `krx_ngt_futures_ccnl_notice`
- `inquire_time_fuopchartprice`
- `inquire_price`

`domestic_bond` 하위에는 다음 기능이 있다.

- `bond_asking_price`
- `bond_ccnl`
- `bond_index_ccnl`
- `inquire_price` — TR ID `FHKBJ773400C0`, 예시 종목코드 `KR2033022D33`
- `inquire_daily_price`
- `search_bond_info`

### 의미

KIS Open API는 코스피200선물/야간선물/국내채권 후보 소스로 매우 유력하다. 특히 “krx_ngt_futures” 관련 샘플이 있어 코스피200 야간선물 난점 해결 가능성이 이전보다 커졌다.

### 제한/리스크

- 한국투자증권 계정 및 Open API 신청이 필요할 가능성이 높다.
- appkey/appsecret 등 개인 인증정보가 필요하다.
- 무료 사용 가능하더라도 호출 제한/실시간 접속 제한이 있을 수 있다.
- 실제 필요한 종목코드/상품코드 매핑 검증이 필요하다.

### 잠정 판단

- 한국 선물/야간선물/채권은 스크래핑보다 KIS API 우선 검토가 맞다.
- 다만 다니의 계정/API 신청 의사결정이 필요할 수 있다.

## 3. yfinance/Yahoo: MVP primary 후보

### 확인한 사실

다수 글로벌 지표가 Yahoo chart endpoint `range=1d&interval=1m`에서 응답했다.

응답 확인 예:

- DXY: `DX-Y.NYB`
- USD/KRW: `KRW=X`
- EUR/KRW: `EURKRW=X`
- JPY/KRW: `JPYKRW=X`
- CNY/KRW: `CNYKRW=X`
- Gold: `GC=F`
- Silver: `SI=F`
- Copper: `HG=F`
- WTI: `CL=F`
- Brent: `BZ=F`
- BTC: `BTC-USD`
- ETH: `ETH-USD`
- US 10Y: `^TNX`
- US 30Y: `^TYX`
- Dow future: `YM=F`
- Nasdaq100 future: `NQ=F`
- S&P500 future: `ES=F`
- Russell2000 future: `RTY=F`
- VIX: `^VIX`
- Dow: `^DJI`
- Nasdaq Composite: `^IXIC`
- Nasdaq100: `^NDX`
- S&P500: `^GSPC`
- SOX: `^SOX`
- EWY: `EWY`
- KOSPI: `^KS11`
- KOSDAQ: `^KQ11`
- KOSPI200: `^KS200`
- Nikkei225: `^N225`
- Taiwan Weighted: `^TWII`
- Shanghai Composite: `000001.SS`
- Shenzhen candidate: `399001.SZ`
- STAR 50 candidate: `000688.SS`
- Hang Seng: `^HSI`
- HSCEI: `^HSCE`
- EuroStoxx50: `^STOXX50E`
- DRAM: `DRAM` = Roundhill Memory ETF, 다니 확인 완료

### 제한/리스크

- yfinance는 공식 보증 데이터 소스가 아니다.
- Yahoo 약관상 개인/연구용 성격이 강하다.
- 응답 성공이 실시간 정확도 보증은 아니다.
- 무료 기반이므로 장애/fallback이 필요하다.

### 잠정 판단

- MVP primary로는 가장 빠르다.
- 장기 안정성 확보를 위해 네이버/KIS/Binance fallback 조합 필요.

## 4. Binance API

BTC/ETH는 Binance API가 가장 안정적 후보다. 공식 market data endpoint와 1m kline 지원이 있어 yfinance보다 적합하다.

## 5. 현재 큰 리스크 목록

1. 한국투자증권 KIS API 사용을 위해 다니의 계정/API 신청이 필요한지.
2. 네이버 모바일 endpoint를 자동 수집에 어느 정도까지 써도 되는지.
3. 한국채/일본채 2Y/10Y/30Y의 무료 1분 데이터 확보.
4. 미국채 2년물의 무료 1분 데이터 확보.
5. 국내금 기준 확정: KRX 금시장 vs 국제금선물×환율 환산.
6. 코스피200선물/야간선물 종목코드 매핑.
7. 무료 소스 장애 시 표시/대체 전략.

## 6. 다음 확인 작업

- 네이버 `api.stock.naver.com`에서 원자재/선물/환율/채권 endpoint 코드 추가 탐색.
- KIS GitHub 샘플에서 domestic_futureoption, domestic_bond의 실제 TR ID/필수 파라미터 확인.
- yfinance와 네이버 동일 지표 값 비교 샘플 수집.
- 장시간 캘린더 설계 초안 작성.
