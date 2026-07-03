export function okStatus(extra = {}) {
  return { level: 'ok', icon: '🟢', label: '정상', ...extra };
}

export function delayedStatus(extra = {}) {
  return { level: 'warn', icon: '🟡', label: '지연/검증필요', ...extra };
}

export function closedStatus(extra = {}) {
  return { level: 'closed', icon: '⚪', label: '장종료/휴장', ...extra };
}

export function failedStatus(message, extra = {}) {
  return { level: 'error', icon: '🔴', label: '장애', message, ...extra };
}

export function normalizeValue(value, scale = 1) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return null;
  return Number(value) * scale;
}
