// הגדרת משימה: JSON אחד שכולל את התזמון, הבקשה, מתי זה נחשב הצלחה, ומה לשלוח לפי התגובה.
// ראה README לתיאור המלא של המבנה.

import { normalizeSchedule } from './schedule.js';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
export const WHEN = { always: 'תמיד', success: 'כשהצליח', failure: 'כשנכשל' };
export const OPS = {
  equals: 'שווה ל',
  not_equals: 'שונה מ',
  contains: 'מכיל',
  not_contains: 'לא מכיל',
  starts_with: 'מתחיל ב',
  gt: 'גדול מ',
  lt: 'קטן מ',
  exists: 'קיים',
  not_exists: 'לא קיים',
  regex: 'תואם לביטוי',
};
const NO_VALUE = new Set(['exists', 'not_exists']);
const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const STATUS_RE = /^\s*\d{3}(\s*-\s*\d{3})?(\s*,\s*\d{3}(\s*-\s*\d{3})?)*\s*$/;

const str = (v, max = 100_000) => String(v ?? '').slice(0, max);
const list = (v) =>
  (Array.isArray(v) ? v : String(v ?? '').split(/[,;\n]/))
    .map((x) => String(x ?? '').trim())
    .filter(Boolean);
const lines = (v) => (Array.isArray(v) ? v : String(v ?? '').split('\n')).map((x) => String(x ?? '').trim()).filter(Boolean);
const hasTemplate = (s) => s.includes('{{');
export const isEmail = (a) => {
  const m = /<([^>]+)>\s*$/.exec(a);
  return EMAIL_RE.test(m ? m[1].trim() : a.trim());
};

/** field: "status" | "body" | "json:data.status" | "header:content-type" */
export function fieldLabel(field) {
  if (field === 'status') return 'קוד התגובה';
  if (field === 'body') return 'גוף התגובה';
  if (field.startsWith('json:')) return `השדה ${field.slice(5)}`;
  if (field.startsWith('header:')) return `הכותרת ${field.slice(7)}`;
  return field;
}

/**
 * מנרמל ומאמת משימה. מחזיר { config, errors } כאשר errors הוא מערך הודעות בעברית.
 * config הוא הגרסה הנקייה שנשמרת ומוצגת בלשונית ה-JSON.
 */
export function normalizeTask(input) {
  const errors = [];
  const t = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  if (input !== t) errors.push('המשימה צריכה להיות אובייקט JSON');

  const config = {
    name: str(t.name, 200).trim(),
    enabled: t.enabled !== false,
    schedule: normalizeSchedule(t.schedule, errors),
  };
  if (!config.name) errors.push('name: חסר שם למשימה');

  // ---- הבקשה ----
  const r = t.request && typeof t.request === 'object' ? t.request : {};
  const method = String(r.method || 'GET').toUpperCase();
  const request = {
    method: METHODS.includes(method) ? method : 'GET',
    url: str(r.url, 4000).trim(),
    headers: {},
    body: typeof r.body === 'object' && r.body !== null ? JSON.stringify(r.body, null, 2) : str(r.body, 200_000),
    timeout_seconds: Math.min(Math.max(Math.round(Number(r.timeout_seconds) || 30), 1), 120),
    retries: Math.min(Math.max(Math.round(Number(r.retries ?? 2)), 0), 4),
  };
  if (!METHODS.includes(method)) errors.push(`request.method: שיטה לא נתמכת "${r.method}"`);
  if (!request.url) errors.push('request.url: חסרה כתובת');
  else {
    try {
      const u = new URL(request.url.replace(/\{\{[^}]*\}\}/g, 'x'));
      if (!['http:', 'https:'].includes(u.protocol)) throw new Error();
    } catch {
      errors.push('request.url: כתובת לא תקינה (צריכה להתחיל ב-https:// או http://)');
    }
  }
  if (r.headers != null && (typeof r.headers !== 'object' || Array.isArray(r.headers))) errors.push('request.headers: צריך להיות אובייקט, למשל {"Authorization": "Bearer ..."}');
  else for (const [k, v] of Object.entries(r.headers || {})) if (k.trim()) request.headers[k.trim()] = str(v, 8000);
  config.request = request;

  // ---- מתי זה נחשב הצלחה ----
  const sc = t.success && typeof t.success === 'object' ? t.success : {};
  config.success = {
    status: str(sc.status || '200-299', 100).trim(),
    error_words: lines(sc.error_words).slice(0, 100),
    must_contain: lines(sc.must_contain).slice(0, 50),
  };
  if (!STATUS_RE.test(config.success.status)) errors.push('success.status: פורמט לא תקין. דוגמה: 200-299 או 200,201');

  // ---- כללים: מה לשלוח לפי התגובה ----
  const rules = Array.isArray(t.rules) ? t.rules : [];
  if (t.rules != null && !Array.isArray(t.rules)) errors.push('rules: צריך להיות מערך');
  config.rules = rules.slice(0, 30).map((raw, i) => {
    const where = `rules[${i}]`;
    const rule = raw && typeof raw === 'object' ? raw : {};
    const out = {
      name: str(rule.name, 200).trim() || `כלל ${i + 1}`,
      when: WHEN[rule.when] ? rule.when : 'always',
      match: rule.match === 'any' ? 'any' : 'all',
      if: (Array.isArray(rule.if) ? rule.if : []).slice(0, 20).map((c, j) => {
        const cond = {
          field: str(c?.field || 'body', 300).trim(),
          op: OPS[c?.op] ? c.op : 'contains',
          value: NO_VALUE.has(c?.op) ? '' : str(c?.value, 2000),
        };
        if (!/^(status|body|json:.+|header:.+)$/.test(cond.field)) errors.push(`${where}.if[${j}]: שדה לא מוכר "${cond.field}" (status, body, json:נתיב, header:שם)`);
        if (c?.op && !OPS[c.op]) errors.push(`${where}.if[${j}]: פעולת השוואה לא מוכרת "${c.op}"`);
        if (cond.op === 'regex') {
          try {
            new RegExp(cond.value);
          } catch {
            errors.push(`${where}.if[${j}]: ביטוי רגולרי לא תקין`);
          }
        }
        if ((cond.op === 'gt' || cond.op === 'lt') && Number.isNaN(Number(cond.value))) errors.push(`${where}.if[${j}]: בהשוואת גדול/קטן הערך צריך להיות מספר`);
        return cond;
      }),
      email: null,
      stop: Boolean(rule.stop),
    };
    const e = rule.email && typeof rule.email === 'object' ? rule.email : {};
    out.email = {
      to: list(e.to),
      cc: list(e.cc),
      subject: str(e.subject, 1000),
      body: str(e.body, 200_000),
      html: Boolean(e.html),
    };
    if (!out.email.to.length) errors.push(`${where}.email.to: חסר נמען`);
    for (const a of [...out.email.to, ...out.email.cc]) if (!hasTemplate(a) && !isEmail(a)) errors.push(`${where}.email: כתובת לא תקינה "${a}"`);
    if (!out.email.subject.trim()) errors.push(`${where}.email.subject: חסר נושא`);
    if (!out.email.body.trim()) errors.push(`${where}.email.body: חסר תוכן`);
    return out;
  });
  return { config, errors };
}

// ---------- הערכת התגובה ----------

export function statusMatches(code, spec) {
  return String(spec || '200-299')
    .split(',')
    .some((part) => {
      const [a, b] = part.split('-').map((x) => Number(x.trim()));
      return Number.isNaN(b) || b === undefined ? code === a : code >= a && code <= b;
    });
}

export function getPath(obj, path) {
  let cur = obj;
  for (const p of String(path).replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean)) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[p];
  }
  return cur;
}

/** תגובה עם JSON שמפוענח רק כשצריך */
export function makeResponse({ status = null, body = '', headers = {} } = {}) {
  const lower = {};
  for (const [k, v] of Object.entries(headers || {})) lower[k.toLowerCase()] = v;
  let parsed;
  let tried = false;
  return {
    status,
    body: body || '',
    headers: lower,
    get json() {
      if (!tried) {
        tried = true;
        try {
          parsed = JSON.parse(this.body);
        } catch {}
      }
      return parsed;
    },
  };
}

export function fieldValue(field, resp) {
  if (field === 'status') return resp.status;
  if (field === 'body') return resp.body;
  if (field.startsWith('json:')) return getPath(resp.json, field.slice(5));
  if (field.startsWith('header:')) return resp.headers[field.slice(7).toLowerCase()];
  return undefined;
}

const asText = (v) => (v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));

export function conditionMatches(c, resp) {
  const actual = fieldValue(c.field, resp);
  if (c.op === 'exists') return actual !== undefined && actual !== null;
  if (c.op === 'not_exists') return actual === undefined || actual === null;
  const a = asText(actual).toLowerCase();
  const v = String(c.value ?? '').toLowerCase();
  switch (c.op) {
    case 'equals':
    case 'not_equals': {
      const numeric = a !== '' && v !== '' && !Number.isNaN(Number(a)) && !Number.isNaN(Number(v));
      const eq = numeric ? Number(a) === Number(v) : a === v;
      return c.op === 'equals' ? eq : !eq;
    }
    case 'contains':
      return a.includes(v);
    case 'not_contains':
      return !a.includes(v);
    case 'starts_with':
      return a.startsWith(v);
    case 'gt':
      return a !== '' && Number(a) > Number(v);
    case 'lt':
      return a !== '' && Number(a) < Number(v);
    case 'regex':
      try {
        return new RegExp(c.value, 'i').test(asText(actual));
      } catch {
        return false;
      }
    default:
      return false;
  }
}

/**
 * האם התגובה נחשבת הצלחה. מחזיר { ok, error, retry }.
 * retry=false כשהשרת ענה בבירור (מילת שגיאה בתוכן) - אין טעם לנסות שוב.
 */
export function evaluateResponse(success, resp) {
  if (!statusMatches(resp.status, success.status)) {
    return { ok: false, retry: true, error: `קוד תגובה ${resp.status} (מצופה: ${success.status})` };
  }
  const body = resp.body.toLowerCase();
  const word = success.error_words.find((w) => body.includes(w.toLowerCase()));
  if (word) return { ok: false, retry: false, error: `התגובה מכילה "${word}"` };
  const missing = success.must_contain.find((w) => !body.includes(w.toLowerCase()));
  if (missing) return { ok: false, retry: false, error: `התגובה לא מכילה "${missing}"` };
  return { ok: true, retry: false, error: null };
}

/** אילו כללים חלים, לפי הסדר. כלל עם stop עוצר את הבדיקה של הכללים שאחריו */
export function matchingRules(rules, outcome, resp) {
  const out = [];
  for (const rule of rules) {
    if (rule.when !== 'always' && rule.when !== outcome) continue;
    const results = rule.if.map((c) => conditionMatches(c, resp));
    const pass = !results.length || (rule.match === 'any' ? results.some(Boolean) : results.every(Boolean));
    if (!pass) continue;
    out.push(rule);
    if (rule.stop) break;
  }
  return out;
}
