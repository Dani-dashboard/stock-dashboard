export function kisCredentialLifecycle(env = process.env, now = new Date()) {
  const expiresAt = parseDate(env.KIS_CREDENTIAL_EXPIRES_AT);
  const issuedAt = parseDate(env.KIS_CREDENTIAL_ISSUED_AT);
  const remindDays = Number(env.KIS_CREDENTIAL_REMIND_DAYS || 14);
  if (!expiresAt) return { configured: false, level: 'warn', message: 'KIS credential expiry date not configured' };
  const msLeft = expiresAt.getTime() - now.getTime();
  const daysLeft = Math.ceil(msLeft / (24 * 60 * 60 * 1000));
  let level = 'ok';
  let message = `KIS credential lifecycle OK; ${daysLeft} days left`;
  if (daysLeft < 0) {
    level = 'error';
    message = `KIS paper credential may be expired by ${Math.abs(daysLeft)} days; refresh keys`;
  } else if (daysLeft <= remindDays) {
    level = 'warn';
    message = `KIS credential renewal reminder: ${daysLeft} days left`;
  }
  return {
    configured: true,
    issuedAt: env.KIS_CREDENTIAL_ISSUED_AT || null,
    expiresAt: env.KIS_CREDENTIAL_EXPIRES_AT,
    remindDays,
    daysLeft,
    level,
    message
  };
}

export function classifyKisAuthError(message = '') {
  const m = String(message).toLowerCase();
  if (m.includes('appkey') || m.includes('app key') || m.includes('appsecret') || m.includes('app secret') || m.includes('invalid_client') || m.includes('unauthorized') || m.includes('401') || m.includes('기간') || m.includes('만료')) {
    return 'KIS_KEY_OR_TOKEN_ERROR';
  }
  if (m.includes('token')) return 'KIS_TOKEN_ERROR';
  return 'KIS_API_ERROR';
}

function parseDate(v) {
  if (!v) return null;
  const d = new Date(`${v}T00:00:00+09:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}
