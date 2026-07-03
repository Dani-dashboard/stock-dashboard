const KRX_MAIN_NOTICE_URL = 'https://www.krx.co.kr/main/main.jspx?cmd=noti_info&obj=market';
const KRX_MAIN_REFERER = 'https://www.krx.co.kr/main/main.jsp';

export async function fetchKrxMarketOperationNotices({ timeoutMs = 8000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(KRX_MAIN_NOTICE_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'accept': 'application/json, text/javascript, */*; q=0.01',
        'referer': KRX_MAIN_REFERER,
        'user-agent': 'Mozilla/5.0',
        'x-requested-with': 'XMLHttpRequest'
      }
    });
    if (!response.ok) throw new Error(`KRX notice HTTP ${response.status}`);
    const data = await response.json();
    const notices = Array.isArray(data.output) ? data.output : [];
    return {
      provider: 'krx-official',
      source: KRX_MAIN_NOTICE_URL,
      fetchedAt: new Date().toISOString(),
      status: { level: 'ok', message: `KRX market operation notices fetched: ${notices.length}` },
      notices: notices.map(normalizeNotice).filter(Boolean)
    };
  } catch (err) {
    return {
      provider: 'krx-official',
      source: KRX_MAIN_NOTICE_URL,
      fetchedAt: new Date().toISOString(),
      status: { level: 'warn', message: err.name === 'AbortError' ? 'KRX notice fetch timeout' : err.message },
      notices: []
    };
  } finally {
    clearTimeout(timer);
  }
}

export function extractKoreaMarketSafetyEvents(notices, now = new Date()) {
  const today = formatKrxNoticeDateKst(now);
  return (notices || [])
    .filter(notice => notice.date === today)
    .map(classifySafetyNotice)
    .filter(Boolean);
}

function normalizeNotice(item) {
  const title = decodeHtml(String(item?.title || '')).trim();
  if (!title) return null;
  return {
    date: String(item?.wrt_dd || '').replaceAll('/', '-'),
    title,
    url: decodeHtml(String(item?.url || '')).trim() || null
  };
}

function classifySafetyNotice(notice) {
  const title = notice.title.replace(/\s+/g, ' ');
  const compact = title.replace(/\s+/g, '');

  const isSidecar = /사이드카/.test(title) || (/프로그램매매/.test(title) && /(효력정지|일시정지|호가효력)/.test(compact));
  if (isSidecar) {
    const direction = /매수/.test(title) ? 'buy' : /매도/.test(title) ? 'sell' : 'unknown';
    return {
      id: `krx-official-sidecar-${direction}-${notice.date.replaceAll('-', '')}`,
      type: 'sidecar',
      direction,
      date: notice.date,
      title,
      url: notice.url,
      source: 'KRX 시장운영공지'
    };
  }

  const isCircuitBreaker = /서킷브레이커|Circuit\s*Breaker/i.test(title) || (/매매거래/.test(title) && /(중단|정지)/.test(title) && /(시장|KOSPI|KOSDAQ|코스피|코스닥)/i.test(title));
  if (isCircuitBreaker) {
    const market = /코스닥|KOSDAQ/i.test(title) ? 'kosdaq' : /코스피|KOSPI|유가증권/i.test(title) ? 'kospi' : 'market';
    const level = title.match(/[123]단계/)?.[0] || 'unknown';
    return {
      id: `krx-official-circuit-breaker-${market}-${level}-${notice.date.replaceAll('-', '')}`,
      type: 'circuit-breaker',
      market,
      level,
      date: notice.date,
      title,
      url: notice.url,
      source: 'KRX 시장운영공지'
    };
  }

  return null;
}

function decodeHtml(value) {
  return value
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'");
}

function formatKrxNoticeDateKst(date) {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(date);
}
