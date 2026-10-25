// מפענח ביטויי cron (5 שדות) ומחשב מועדי ריצה לפי שעון ירושלים.
// נתמך: * , - / שמות חודשים וימים (JAN, SUN), 7 = ראשון, ומקרואים (@daily וכו').
// כשגם יום-בחודש וגם יום-בשבוע מוגבלים, מספיק שאחד מהם מתקיים (כמו ב-cron הקלאסי).

import { zonedToUtc, tzOffset, localParts, floorToMinute } from './time.js';

const MINUTE = 60_000;
const DAY = 86_400_000;

const MACROS = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
};

const MONTH_NAMES = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const DOW_NAMES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

const FIELDS = [
  { name: 'דקה', min: 0, max: 59 },
  { name: 'שעה', min: 0, max: 23 },
  { name: 'יום בחודש', min: 1, max: 31 },
  { name: 'חודש', min: 1, max: 12, names: MONTH_NAMES, nameBase: 1 },
  { name: 'יום בשבוע', min: 0, max: 7, names: DOW_NAMES, nameBase: 0 },
];

export class CronError extends Error {}

function parseValue(raw, field) {
  const up = raw.toUpperCase();
  if (field.names) {
    const idx = field.names.indexOf(up);
    if (idx >= 0) return idx + field.nameBase;
  }
  if (!/^\d+$/.test(raw)) throw new CronError(`ערך לא תקין "${raw}" בשדה ${field.name}`);
  const n = Number(raw);
  if (n < field.min || n > field.max) {
    throw new CronError(`הערך ${n} מחוץ לטווח ${field.min}-${field.max} בשדה ${field.name}`);
  }
  return n;
}

function parseField(text, field) {
  const values = new Set();
  for (const part of text.split(',')) {
    if (!part) throw new CronError(`רשימה לא תקינה בשדה ${field.name}`);
    const [rangePart, stepPart, extra] = part.split('/');
    if (extra !== undefined) throw new CronError(`צעד לא תקין בשדה ${field.name}`);
    let step = 1;
    if (stepPart !== undefined) {
      if (!/^\d+$/.test(stepPart) || Number(stepPart) < 1) throw new CronError(`צעד לא תקין "${stepPart}" בשדה ${field.name}`);
      step = Number(stepPart);
    }
    let lo;
    let hi;
    if (rangePart === '*') {
      lo = field.min;
      hi = field.max === 7 ? 6 : field.max;
    } else if (rangePart.includes('-')) {
      const [a, b] = rangePart.split('-');
      lo = parseValue(a, field);
      hi = parseValue(b, field);
      if (lo > hi) throw new CronError(`טווח הפוך ${rangePart} בשדה ${field.name}`);
    } else {
      lo = parseValue(rangePart, field);
      hi = stepPart !== undefined ? (field.max === 7 ? 6 : field.max) : lo;
    }
    for (let v = lo; v <= hi; v += step) values.add(field.max === 7 && v === 7 ? 0 : v);
  }
  return [...values].sort((a, b) => a - b);
}

/** מפענח ביטוי cron. זורק CronError עם הודעה בעברית במקרה של שגיאה. */
export function parseCron(expr) {
  let text = String(expr || '').trim().replace(/\s+/g, ' ');
  if (!text) throw new CronError('ביטוי ה-cron ריק');
  if (text.startsWith('@')) {
    const macro = MACROS[text.toLowerCase()];
    if (!macro) throw new CronError(`מקרו לא מוכר: ${text}`);
    text = macro;
  }
  const parts = text.split(' ');
  if (parts.length !== 5) throw new CronError(`נדרשים 5 שדות (דקה שעה יום חודש יום-בשבוע), התקבלו ${parts.length}`);
  const [minutes, hours, doms, months, dows] = parts.map((p, i) => parseField(p, FIELDS[i]));
  return {
    source: text,
    minutes,
    hours,
    doms: new Set(doms),
    months: new Set(months),
    dows: new Set(dows),
    domStar: parts[2].startsWith('*'),
    dowStar: parts[4].startsWith('*'),
  };
}

function dayMatches(c, month, day, weekday) {
  if (!c.months.has(month)) return false;
  if (c.domStar && c.dowStar) return true;
  if (c.domStar) return c.dows.has(weekday);
  if (c.dowStar) return c.doms.has(day);
  return c.doms.has(day) || c.dows.has(weekday);
}

/**
 * מחזיר את count מועדי הריצה הבאים (UTC במילישניות) אחרי afterMs (לא כולל).
 * מחזיר מערך ריק אם הביטוי לעולם לא יתקיים (למשל 30 בפברואר).
 */
export function nextRuns(exprOrParsed, afterMs, count = 1) {
  const c = typeof exprOrParsed === 'string' ? parseCron(exprOrParsed) : exprOrParsed;
  const start = floorToMinute(afterMs) + MINUTE;
  const sp = localParts(start);
  const startLocalMinutes = sp.hour * 60 + sp.minute;
  const firstDay = Date.UTC(sp.year, sp.month - 1, sp.day);
  const results = [];
  const maxDays = 366 * 30;

  for (let i = 0; i < maxDays && results.length < count; i++) {
    const d = new Date(firstDay + i * DAY);
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth() + 1;
    const dd = d.getUTCDate();
    if (!dayMatches(c, m, dd, d.getUTCDay())) continue;

    // ביום ללא מעבר שעון מספיק היסט אחד; ביום מעבר מחשבים כל שעה בנפרד
    const dayUtc = Date.UTC(y, m - 1, dd);
    const offBefore = tzOffset(dayUtc - 4 * 3_600_000);
    const offAfter = tzOffset(dayUtc + 28 * 3_600_000);
    const stable = offBefore === offAfter;

    const candidates = [];
    for (const h of c.hours) {
      for (const mi of c.minutes) {
        if (i === 0 && h * 60 + mi < startLocalMinutes - 60) continue;
        const t = stable ? Date.UTC(y, m - 1, dd, h, mi) - offBefore : zonedToUtc(y, m, dd, h, mi);
        if (t >= start) candidates.push(t);
      }
    }
    candidates.sort((a, b) => a - b);
    for (const t of candidates) {
      if (results.length >= count) break;
      if (results[results.length - 1] !== t) results.push(t);
    }
  }
  return results;
}

export function nextRun(expr, afterMs) {
  return nextRuns(expr, afterMs, 1)[0] ?? null;
}

// ---------- תיאור בעברית ----------

const HE_DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
const HE_MONTHS = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];
const pad = (n) => String(n).padStart(2, '0');
const isNum = (s) => /^\d+$/.test(s);

function joinHe(list) {
  if (list.length <= 1) return list.join('');
  return `${list.slice(0, -1).join(', ')} ו${list[list.length - 1]}`;
}

function describeDays(values, names) {
  // רצף של 3 ומעלה מוצג כטווח
  const sorted = [...values].sort((a, b) => a - b);
  const contiguous = sorted.length >= 3 && sorted.every((v, i) => i === 0 || v === sorted[i - 1] + 1);
  if (contiguous) return `${names(sorted[0])} עד ${names(sorted[sorted.length - 1])}`;
  return joinHe(sorted.map(names));
}

/** תיאור קריא בעברית של ביטוי cron. */
export function describeCron(expr) {
  const c = parseCron(expr);
  const [fMin, fHour, fDom, fMon, fDow] = c.source.split(' ');

  let timePart;
  if (fMin === '*' && fHour === '*') timePart = 'כל דקה';
  else if (/^\*\/\d+$/.test(fMin) && fHour === '*') timePart = `כל ${fMin.slice(2)} דקות`;
  else if (isNum(fMin) && fHour === '*') timePart = Number(fMin) === 0 ? 'כל שעה עגולה' : `כל שעה, בדקה ${fMin}`;
  else if (isNum(fMin) && /^\*\/\d+$/.test(fHour)) timePart = `כל ${fHour.slice(2)} שעות, בדקה ${pad(fMin)}`;
  else if (c.hours.length * c.minutes.length <= 6 && !fMin.includes('*') && !fHour.includes('*')) {
    const times = [];
    for (const h of c.hours) for (const m of c.minutes) times.push(`${pad(h)}:${pad(m)}`);
    timePart = times.length === 1 ? `בשעה ${times[0]}` : `בשעות ${joinHe(times)}`;
  } else if (isNum(fMin) && /^\d+-\d+$/.test(fHour)) {
    const [a, b] = fHour.split('-');
    timePart = `כל שעה בין ${pad(a)}:${pad(fMin)} ל-${pad(b)}:${pad(fMin)}`;
  } else if (/^\*\/\d+$/.test(fMin) && /^\d+-\d+$/.test(fHour)) {
    const [a, b] = fHour.split('-');
    timePart = `כל ${fMin.slice(2)} דקות בין השעות ${pad(a)}:00 ל-${pad(b)}:59`;
  } else {
    timePart = `בדקות ${fMin} של השעות ${fHour}`;
  }

  const dowText = describeDays(c.dows, (d) => HE_DAYS[d]);
  const domText = joinHe([...c.doms].sort((a, b) => a - b).map(String));
  let dayPart = '';
  if (!c.domStar && !c.dowStar) dayPart = `בימי ${dowText} או ב-${domText} בחודש`;
  else if (!c.dowStar) dayPart = c.dows.size === 1 ? `בכל יום ${dowText}` : `בימים ${dowText}`;
  else if (!c.domStar) dayPart = `ב-${domText} בכל חודש`;
  else if (!timePart.startsWith('כל')) dayPart = 'כל יום';

  let monthPart = '';
  if (fMon !== '*') monthPart = `בחודשים ${describeDays(c.months, (m) => HE_MONTHS[m - 1])}`;

  return [dayPart, timePart, monthPart].filter(Boolean).join(', ');
}

/** בדיקה מהירה: מחזיר הודעת שגיאה או null */
export function validateCron(expr) {
  try {
    const c = parseCron(expr);
    if (!nextRuns(c, Date.now(), 1).length) return 'הביטוי לעולם לא יתקיים (למשל תאריך שלא קיים)';
    return null;
  } catch (e) {
    return e instanceof CronError ? e.message : String(e);
  }
}
