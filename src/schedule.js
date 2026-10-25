// תזמון משימה: אימות, חישוב הריצה הבאה ותיאור בעברית. כל הזמנים לפי שעון ישראל.
//
// סוגים:
//   dates     - מועדים מסוימים: ["2026-11-03 10:30", ...]
//   daily     - כל יום (או ימים נבחרים בשבוע) בשעות קבועות
//   monthly   - כל חודש ביום מסוים, לועזי או עברי
//   yearly    - כל שנה בתאריך מסוים, לועזי או עברי
//   interval  - כל כמה דקות, בטווח שעות ובימים נבחרים

import { zonedToUtc, localParts, parseLocalDateTime, formatDateTime } from './time.js';
import { hebrewMonthKey, hebrewMonthName, matchesHebrewDay, gematria, formatHebrewDate } from './hebrew.js';

export const TYPES = { dates: 'מועדים מסוימים', daily: 'כל יום', monthly: 'כל חודש', yearly: 'כל שנה', interval: 'כל כמה דקות' };
export const INTERVALS = [1, 2, 5, 10, 15, 20, 30, 60, 120, 180, 240, 360, 720];
const DAY_NAMES = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
const GREG_MONTHS = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
const DAY_MS = 86_400_000;

const pad = (n) => String(n).padStart(2, '0');
const isTime = (t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(t);
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
const toMinutes = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const normTime = (t) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(t ?? '').trim());
  return m ? `${pad(m[1])}:${m[2]}` : String(t ?? '').trim();
};

/** מנרמל את הגדרת התזמון ומוסיף שגיאות (בעברית) למערך errors */
export function normalizeSchedule(input, errors) {
  const s = input && typeof input === 'object' ? input : {};
  const type = TYPES[s.type] ? s.type : null;
  if (!type) {
    errors.push(`schedule.type: סוג תזמון לא מוכר. אפשרויות: ${Object.keys(TYPES).join(', ')}`);
    return { type: 'dates', dates: [] };
  }
  const out = { type };

  if (type === 'dates') {
    const list = Array.isArray(s.dates) ? s.dates : [];
    const dates = [];
    list.forEach((raw, i) => {
      const v = String(raw ?? '').trim().replace('T', ' ');
      const m = /^(\d{4}-\d{2}-\d{2}) (\d{1,2}:\d{2})$/.exec(v);
      const norm = m ? `${m[1]} ${normTime(m[2])}` : v;
      if (!m || !parseLocalDateTime(norm)) errors.push(`schedule.dates[${i}]: "${raw}" אינו תאריך ושעה תקינים (פורמט: 2026-11-03 10:30)`);
      else dates.push(norm);
    });
    out.dates = [...new Set(dates)].sort();
    if (!out.dates.length && !errors.some((e) => e.startsWith('schedule.dates'))) errors.push('schedule.dates: יש להוסיף לפחות מועד אחד');
    return out;
  }

  if (type === 'interval') {
    out.minutes = Number(s.minutes);
    if (!INTERVALS.includes(out.minutes)) errors.push(`schedule.minutes: ערך לא נתמך. אפשרויות: ${INTERVALS.join(', ')}`);
    out.from = normTime(s.from || '00:00');
    out.to = normTime(s.to || '23:59');
    if (!isTime(out.from) || !isTime(out.to)) errors.push('schedule.from/to: שעה לא תקינה (פורמט HH:MM)');
    else if (toMinutes(out.from) > toMinutes(out.to)) errors.push('schedule.from/to: שעת ההתחלה מאוחרת משעת הסיום');
  } else {
    const times = (Array.isArray(s.times) ? s.times : s.time ? [s.time] : []).map(normTime);
    const bad = times.find((t) => !isTime(t));
    if (bad) errors.push(`schedule.times: "${bad}" אינה שעה תקינה (פורמט HH:MM)`);
    out.times = [...new Set(times.filter(isTime))].sort();
    if (!out.times.length && !bad) errors.push('schedule.times: יש להוסיף לפחות שעה אחת');
  }

  if (type === 'daily' || type === 'interval') {
    const days = Array.isArray(s.days) && s.days.length ? s.days.map(Number) : ALL_DAYS;
    if (days.some((d) => !ALL_DAYS.includes(d))) errors.push('schedule.days: ימים בשבוע הם 0 (ראשון) עד 6 (שבת)');
    out.days = [...new Set(days.filter((d) => ALL_DAYS.includes(d)))].sort();
  }

  if (type === 'monthly' || type === 'yearly') {
    out.calendar = s.calendar === 'hebrew' ? 'hebrew' : 'gregorian';
    out.day = Number(s.day);
    const maxDay = out.calendar === 'hebrew' ? 30 : 31;
    if (!Number.isInteger(out.day) || out.day < 1 || out.day > maxDay) errors.push(`schedule.day: יום בחודש צריך להיות 1-${maxDay}`);
  }
  if (type === 'yearly') {
    if (out.calendar === 'hebrew') {
      out.month = hebrewMonthKey(s.month);
      if (!out.month) errors.push(`schedule.month: חודש עברי לא מוכר "${s.month}" (למשל: ניסן, אדר ב)`);
    } else {
      out.month = Number(s.month);
      if (!Number.isInteger(out.month) || out.month < 1 || out.month > 12) errors.push('schedule.month: חודש לועזי צריך להיות 1-12');
    }
  }

  for (const k of ['start_date', 'end_date']) {
    if (s[k]) {
      if (isDate(String(s[k]))) out[k] = String(s[k]);
      else errors.push(`schedule.${k}: תאריך לא תקין (פורמט 2026-11-01)`);
    }
  }
  if (out.start_date && out.end_date && out.start_date > out.end_date) errors.push('schedule: תאריך ההתחלה אחרי תאריך הסיום');
  return out;
}

function dayMatches(s, y, m, d, wd) {
  const iso = `${y}-${pad(m)}-${pad(d)}`;
  if (s.start_date && iso < s.start_date) return false;
  if (s.end_date && iso > s.end_date) return false;
  switch (s.type) {
    case 'daily':
    case 'interval':
      return s.days.includes(wd);
    case 'monthly':
    case 'yearly': {
      if (s.calendar === 'hebrew') return matchesHebrewDay(y, m, d, s.day, s.type === 'yearly' ? s.month : null);
      if (s.type === 'yearly' && m !== s.month) return false;
      // יום שלא קיים בחודש (31, או 29 בפברואר) נופל על היום האחרון בחודש
      const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
      return d === s.day || (s.day > last && d === last);
    }
    default:
      return false;
  }
}

/** הריצה הבאה (UTC במילישניות) אחרי afterMs, או null אם אין */
export function nextRun(s, afterMs) {
  if (s.type === 'dates') {
    for (const v of s.dates) {
      const t = parseLocalDateTime(v);
      if (t > afterMs) return t;
    }
    return null;
  }
  const start = localParts(afterMs + 1);
  const first = Date.UTC(start.year, start.month - 1, start.day);
  // 800 ימים מספיקים גם לתאריך עברי שנתי וגם לתאריך התחלה רחוק
  for (let i = 0; i < 800; i++) {
    const dt = new Date(first + i * DAY_MS);
    const y = dt.getUTCFullYear();
    const m = dt.getUTCMonth() + 1;
    const d = dt.getUTCDate();
    if (!dayMatches(s, y, m, d, dt.getUTCDay())) continue;
    let minutes;
    if (s.type === 'interval') {
      minutes = [];
      for (let x = Math.ceil(toMinutes(s.from) / s.minutes) * s.minutes; x <= toMinutes(s.to); x += s.minutes) minutes.push(x);
    } else {
      minutes = s.times.map(toMinutes);
    }
    for (const x of minutes) {
      const t = zonedToUtc(y, m, d, Math.floor(x / 60), x % 60);
      if (t > afterMs) return t;
    }
  }
  return null;
}

/** count המועדים הבאים, כל אחד עם תאריך לועזי ועברי */
export function upcoming(s, afterMs, count = 5) {
  const out = [];
  let t = afterMs;
  while (out.length < count) {
    t = nextRun(s, t);
    if (t == null) break;
    out.push(describeInstant(t));
  }
  return out;
}

export function describeInstant(ms) {
  const p = localParts(ms);
  return {
    at: ms,
    local: formatDateTime(ms).slice(0, 16),
    day: `יום ${DAY_NAMES[p.weekday]}`,
    hebrew: formatHebrewDate(p.year, p.month, p.day),
  };
}

const joinHe = (list) => (list.length <= 1 ? list.join('') : `${list.slice(0, -1).join(', ')} ו${list[list.length - 1]}`);
const timesText = (times) => (times.length === 1 ? `בשעה ${times[0]}` : `בשעות ${joinHe(times)}`);
function daysText(days) {
  if (days.length === 7) return 'כל יום';
  if (days.join() === '0,1,2,3,4') return "בימים א'-ה'";
  if (days.join() === '0,1,2,3,4,5') return "בימים א'-ו'";
  return `בימי ${joinHe(days.map((d) => DAY_NAMES[d]))}`;
}

/** תיאור קצר בעברית */
export function describeSchedule(s) {
  let text;
  switch (s.type) {
    case 'dates':
      text = s.dates.length === 1 ? `פעם אחת: ${s.dates[0].split(' ').reverse().join(' ')}` : `${s.dates.length} מועדים מסוימים`;
      break;
    case 'daily':
      text = `${daysText(s.days)} ${timesText(s.times)}`;
      break;
    case 'monthly':
      text = s.calendar === 'hebrew' ? `ב-${gematria(s.day)} בכל חודש עברי, ${timesText(s.times)}` : `ב-${s.day} בכל חודש, ${timesText(s.times)}`;
      break;
    case 'yearly':
      text =
        s.calendar === 'hebrew'
          ? `כל שנה ב-${gematria(s.day)} ב${hebrewMonthName(s.month)}, ${timesText(s.times)}`
          : `כל שנה ב-${s.day} ב${GREG_MONTHS[s.month - 1]}, ${timesText(s.times)}`;
      break;
    case 'interval': {
      const every = s.minutes < 60 ? `כל ${s.minutes} דקות` : s.minutes === 60 ? 'כל שעה' : `כל ${s.minutes / 60} שעות`;
      const range = s.from === '00:00' && s.to === '23:59' ? '' : ` בין ${s.from} ל-${s.to}`;
      text = `${every}${range}${s.days.length === 7 ? '' : `, ${daysText(s.days)}`}`;
      break;
    }
    default:
      text = '';
  }
  if (s.start_date || s.end_date) {
    text += ` (${s.start_date ? `מ-${s.start_date}` : ''}${s.start_date && s.end_date ? ' ' : ''}${s.end_date ? `עד ${s.end_date}` : ''})`;
  }
  return text;
}
