// כלי זמן לאזור הזמן Asia/Jerusalem, כולל מעבר שעון קיץ/חורף.
// כל הזמנים נשמרים במסד כמילישניות UTC; ההמרה לשעון מקומי נעשית כאן בלבד.

export const TZ = 'Asia/Jerusalem';
const MINUTE = 60_000;

const partsFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  weekday: 'short',
});

const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** מפרק רגע UTC לרכיבי שעון מקומי בירושלים. */
export function localParts(ms) {
  const out = {};
  for (const p of partsFormatter.formatToParts(new Date(ms))) {
    if (p.type === 'weekday') out.weekday = WEEKDAYS[p.value];
    else if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  return {
    year: out.year,
    month: out.month,
    day: out.day,
    hour: out.hour,
    minute: out.minute,
    second: out.second,
    weekday: out.weekday,
  };
}

/** ההפרש (במילישניות) בין השעון המקומי ל-UTC ברגע נתון. */
export function tzOffset(ms) {
  const p = localParts(ms);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/**
 * ממיר שעון-קיר מקומי לרגע UTC.
 * - שעה כפולה (מעבר לשעון חורף): נבחרת ההופעה הראשונה.
 * - שעה שלא קיימת (מעבר לשעון קיץ): מוזזת קדימה באורך הפער (02:30 → 03:30).
 */
export function zonedToUtc(year, month, day, hour, minute) {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const offsets = new Set([tzOffset(guess - 86_400_000), tzOffset(guess), tzOffset(guess + 86_400_000)]);
  const matches = [];
  for (const off of offsets) {
    const t = guess - off;
    const p = localParts(t);
    if (p.year === year && p.month === month && p.day === day && p.hour === hour && p.minute === minute) {
      matches.push(t);
    }
  }
  if (matches.length) return Math.min(...matches);
  // השעה לא קיימת - משתמשים בהיסט שלפני המעבר, וכך מתקבלת השעה שאחרי הפער
  return guess - tzOffset(guess - 86_400_000);
}

const pad = (n, w = 2) => String(n).padStart(w, '0');

/** YYYY-MM-DD לפי שעון ירושלים */
export function formatDate(ms) {
  const p = localParts(ms);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** YYYY-MM-DD HH:mm:ss לפי שעון ירושלים */
export function formatDateTime(ms) {
  const p = localParts(ms);
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`;
}

/** YYYY-MM-DDTHH:mm לפי שעון ירושלים (מתאים ל-input מסוג datetime-local) */
export function formatLocalInput(ms) {
  const p = localParts(ms);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

/** מפענח "YYYY-MM-DDTHH:mm" (או עם רווח) כשעון ירושלים ומחזיר UTC במילישניות, או null. */
export function parseLocalDateTime(str) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::\d{2})?$/.exec(String(str || '').trim());
  if (!m) return null;
  const [, y, mo, d, h, mi] = m.map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  const check = new Date(Date.UTC(y, mo - 1, d));
  if (check.getUTCMonth() !== mo - 1) return null;
  return zonedToUtc(y, mo, d, h, mi);
}

export const floorToMinute = (ms) => Math.floor(ms / MINUTE) * MINUTE;
