const SHANGHAI_OFFSET_SECONDS = 8 * 60 * 60;
const PERIOD_LABELS = { 5: '5分钟', 30: '30分钟', 240: '4小时', 101: '日K', 102: '周K', 103: '月K', day: '日K', week: '周K', month: '月K', '5m': '5分钟', '30m': '30分钟', '240m': '4小时' };

export function isFourHourPeriod(period) {
  return ['240', '240m'].includes(String(period));
}

// Chart granularity, rather than a promise that a provider accepts this period.
export function isMinutePeriod(period) {
  return ['5', '30', '5m', '30m'].includes(String(period)) || isFourHourPeriod(period);
}

export function periodLabel(period) {
  return PERIOD_LABELS[period] || String(period ?? '');
}

function calendarParts(value) {
  const text = String(value ?? '').trim();
  const compact = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?$/.exec(text);
  if (compact) return { year: +compact[1], month: +compact[2], day: +compact[3],
    hour: +(compact[4] || 0), minute: +(compact[5] || 0), second: +(compact[6] || 0), millisecond: 0,
    hasTime: compact[4] !== undefined, offsetSeconds: SHANGHAI_OFFSET_SECONDS };
  const separated = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:?\d{2})?)?$/.exec(text);
  if (!separated) return null;
  const zone = separated[8];
  let offsetSeconds = SHANGHAI_OFFSET_SECONDS;
  if (zone === 'Z') offsetSeconds = 0;
  else if (zone) {
    const zoneDigits = zone.replace(/[^\d]/g, '');
    const hours = +zoneDigits.slice(0, 2), minutes = +zoneDigits.slice(2);
    if (hours > 23 || minutes > 59) return null;
    offsetSeconds = (zone.startsWith('-') ? -1 : 1) * (hours * 60 + minutes) * 60;
  }
  return { year: +separated[1], month: +separated[2], day: +separated[3],
    hour: +(separated[4] || 0), minute: +(separated[5] || 0), second: +(separated[6] || 0),
    millisecond: +(separated[7] || '').padEnd(3, '0'),
    hasTime: separated[4] !== undefined, offsetSeconds };
}

function calendarSeconds(parts) {
  const { year, month, day, hour, minute, second, millisecond, offsetSeconds } = parts;
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31
    || hour > 23 || minute > 59 || second > 59) return NaN;
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, millisecond);
  // Date.UTC/Date.parse normalize impossible dates such as February 30. Reject them.
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return NaN;
  return date.getTime() / 1000 - offsetSeconds;
}

/**
 * Parse a market timestamp to Unix seconds. Calendar values without an explicit
 * offset use Asia/Shanghai, independently of the browser/server timezone.
 * Tencent YYYYMMDDHHmm values must be checked before numeric Unix timestamps.
 */
export function parseKlineTime(value) {
  if (value == null || value === '') return NaN;
  if (value instanceof Date) return value.getTime() / 1000;
  const text = String(value).trim();
  const parts = calendarParts(text);
  if (parts) return calendarSeconds(parts);
  // These lengths represent compact calendar keys, even when the date is invalid.
  if (/^\d{12}$|^\d{14}$/.test(text)) return NaN;
  if (!/^-?\d+(?:\.\d+)?$/.test(text)) return NaN;
  const numeric = Number(text);
  if (!Number.isFinite(numeric)) return NaN;
  return /^-?\d{13}$/.test(text) ? numeric / 1000 : numeric;
}

function shanghaiParts(value) {
  const seconds = parseKlineTime(value);
  if (!Number.isFinite(seconds)) return null;
  const date = new Date((seconds + SHANGHAI_OFFSET_SECONDS) * 1000);
  if (!Number.isFinite(date.getTime())) return null;
  const key = date.toISOString();
  // The chart date format has a four-digit year.
  if (!/^\d{4}-/.test(key)) return null;
  return { date: key.slice(0, 10), time: key.slice(11, 16), weekday: date.getUTCDay() };
}

/** Canonical calendar key; minute keys retain the time, daily keys retain the date. */
export function klineDateKey(value) {
  const parts = shanghaiParts(value);
  if (!parts) return '';
  const calendar = calendarParts(value);
  return calendar && !calendar.hasTime ? parts.date : `${parts.date} ${parts.time}`;
}

export function klineTradingDate(value) {
  return shanghaiParts(value)?.date || '';
}

/** Compact labels keep the date on minute charts so separate sessions are distinguishable. */
export function klineDateLabel(value, { compact = false, weekday = false } = {}) {
  const key = klineDateKey(value);
  if (!key) return '—';
  if (weekday) {
    const day = ['日', '一', '二', '三', '四', '五', '六'][shanghaiParts(value).weekday];
    return `${key.slice(0, 10).replace(/-/g, '/')} 周${day}${key.length > 10 ? ` ${key.slice(11)}` : ''}`;
  }
  return compact ? key.slice(5) : key;
}
