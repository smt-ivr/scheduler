// לוח עברי: המרה מלועזי לעברי (דרך Intl), חיפוש תאריך לועזי לפי תאריך עברי, וכתיבה באותיות.

const fmt = new Intl.DateTimeFormat('en-u-ca-hebrew', { timeZone: 'UTC', year: 'numeric', month: 'long', day: 'numeric' });

const ICU_MONTH = {
  Tishri: 'tishrei', Heshvan: 'cheshvan', Kislev: 'kislev', Tevet: 'tevet', Shevat: 'shevat',
  'Adar I': 'adar1', 'Adar II': 'adar2', Adar: 'adar', Nisan: 'nisan', Iyar: 'iyar',
  Sivan: 'sivan', Tamuz: 'tammuz', Av: 'av', Elul: 'elul',
};

export const HEBREW_MONTHS = [
  ['tishrei', 'תשרי'], ['cheshvan', 'חשוון'], ['kislev', 'כסלו'], ['tevet', 'טבת'], ['shevat', 'שבט'],
  ['adar', 'אדר'], ['adar1', 'אדר א׳'], ['adar2', 'אדר ב׳'], ['nisan', 'ניסן'], ['iyar', 'אייר'],
  ['sivan', 'סיוון'], ['tammuz', 'תמוז'], ['av', 'אב'], ['elul', 'אלול'],
];
const MONTH_NAME = Object.fromEntries(HEBREW_MONTHS);

// מקבל גם שם עברי ("ניסן", "אדר ב") וגם מפתח ("nisan")
export function hebrewMonthKey(value) {
  const v = String(value ?? '').trim().replace(/["'׳״]/g, '').replace(/\s+/g, ' ');
  if (MONTH_NAME[v.toLowerCase()]) return v.toLowerCase();
  const aliases = { חשון: 'cheshvan', מרחשון: 'cheshvan', סיון: 'sivan', 'אדר א': 'adar1', 'אדר ב': 'adar2', 'אדר 1': 'adar1', 'אדר 2': 'adar2' };
  if (aliases[v]) return aliases[v];
  const found = HEBREW_MONTHS.find(([, name]) => name.replace(/[׳']/g, '') === v);
  return found ? found[0] : null;
}

export const hebrewLeap = (year) => (7 * year + 1) % 19 < 7;

const cache = new Map();
/** רכיבי התאריך העברי של יום לועזי (y, m 1-12, d) */
export function hebrewParts(y, m, d) {
  const key = y * 10000 + m * 100 + d;
  let p = cache.get(key);
  if (!p) {
    const parts = {};
    for (const x of fmt.formatToParts(new Date(Date.UTC(y, m - 1, d)))) parts[x.type] = x.value;
    p = { day: Number(parts.day), month: ICU_MONTH[parts.month] || parts.month, year: Number(parts.year) };
    if (cache.size > 5000) cache.clear();
    cache.set(key, p);
  }
  return p;
}

/** האם זה היום האחרון בחודש העברי */
export function isLastHebrewDay(y, m, d) {
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  return hebrewParts(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate()).day === 1;
}

/** בשנה פשוטה אדר א'/ב' הם "אדר"; בשנה מעוברת "אדר" הוא אדר ב' */
export function effectiveMonth(monthKey, year) {
  const leap = hebrewLeap(year);
  if (!leap && (monthKey === 'adar1' || monthKey === 'adar2')) return 'adar';
  if (leap && monthKey === 'adar') return 'adar2';
  return monthKey;
}

/**
 * האם היום הלועזי הזה הוא היום העברי המבוקש. monthKey ריק = כל חודש.
 * יום 30 בחודש של 29 יום נופל על היום האחרון בחודש.
 */
export function matchesHebrewDay(y, m, d, day, monthKey = null) {
  const p = hebrewParts(y, m, d);
  if (monthKey && p.month !== effectiveMonth(monthKey, p.year)) return false;
  if (p.day === day) return true;
  return day === 30 && p.day === 29 && isLastHebrewDay(y, m, d);
}

/** מחפש את התאריך הלועזי של תאריך עברי. מחזיר "YYYY-MM-DD" או null */
export function hebrewToGregorian(year, monthKey, day) {
  const key = hebrewMonthKey(monthKey);
  if (!key || !year || !day) return null;
  // שנה עברית Y מתחילה בסתיו של השנה הלועזית Y-3761
  const start = Date.UTC(year - 3761, 7, 1);
  for (let i = 0; i < 430; i++) {
    const dt = new Date(start + i * 86_400_000);
    const y = dt.getUTCFullYear();
    const m = dt.getUTCMonth() + 1;
    const d = dt.getUTCDate();
    if (hebrewParts(y, m, d).year === year && matchesHebrewDay(y, m, d, day, key)) {
      return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
  }
  return null;
}

// ---------- כתיבה באותיות ----------

const ONES = ['', 'א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ז', 'ח', 'ט'];
const TENS = ['', 'י', 'כ', 'ל', 'מ', 'נ', 'ס', 'ע', 'פ', 'צ'];
const HUNDREDS = ['', 'ק', 'ר', 'ש', 'ת'];

export function gematria(num) {
  let n = num % 1000;
  let s = '';
  while (n >= 400) {
    s += 'ת';
    n -= 400;
  }
  if (n >= 100) {
    s += HUNDREDS[Math.floor(n / 100)];
    n %= 100;
  }
  if (n === 15) s += 'טו';
  else if (n === 16) s += 'טז';
  else s += TENS[Math.floor(n / 10)] + ONES[n % 10];
  // גרש וגרשיים עבריים (׳ ״), כדי שהתאריך לא ישבור JSON או HTML
  return s.length === 1 ? `${s}׳` : `${s.slice(0, -1)}״${s.slice(-1)}`;
}

export function hebrewMonthName(key) {
  return MONTH_NAME[key] || key;
}

/** "ט"ו שבט תשפ"ז" */
export function formatHebrewDate(y, m, d) {
  const p = hebrewParts(y, m, d);
  return `${gematria(p.day)} ${hebrewMonthName(p.month)} ${gematria(p.year)}`;
}
