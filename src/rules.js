// כללים לתגובה: זיהוי שגיאה לפי תוכן (גם כשהשרת מחזיר 200), ופעולות מותנות אחרי ריצה.
// הקובץ טהור (בלי גישה למסד או לרשת) כדי שאפשר יהיה לבדוק אותו ולהריץ אותו גם ב"בדיקת כללים".

export const SOURCES = {
  body: 'גוף התגובה',
  json: 'שדה JSON',
  status: 'קוד תגובה',
  header: 'כותרת תגובה',
};

export const OPS = {
  contains: 'מכיל',
  not_contains: 'לא מכיל',
  equals: 'שווה ל',
  not_equals: 'שונה מ',
  starts_with: 'מתחיל ב',
  regex: 'תואם לביטוי רגולרי',
  gt: 'גדול מ',
  lt: 'קטן מ',
  exists: 'קיים',
  not_exists: 'לא קיים',
};

const NO_VALUE_OPS = new Set(['exists', 'not_exists']);
export const WHEN = { always: 'תמיד', success: 'אחרי הצלחה', failure: 'אחרי כשל' };
export const MAX_ACTIONS = 20;
export const MAX_CONDITIONS = 20;

export const EMPTY_RULES = Object.freeze({
  fail_keywords: [],
  keywords_case_sensitive: false,
  fail_conditions: [],
  no_retry_on_content_error: false,
  actions: [],
});

/** "data.items[0].status" → ערך מתוך אובייקט */
export function getPath(obj, path) {
  if (!path) return obj;
  const parts = String(path)
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter(Boolean);
  let cur = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[p];
  }
  return cur;
}

/** עוטף תגובה כך ש-JSON מפוענח רק כשצריך */
export function makeResponse({ status = null, body = '', headers = {}, error = null } = {}) {
  let parsed;
  let tried = false;
  const lower = {};
  for (const [k, v] of Object.entries(headers || {})) lower[k.toLowerCase()] = v;
  return {
    status,
    body: body || '',
    headers: lower,
    error,
    get json() {
      if (!tried) {
        tried = true;
        try {
          parsed = JSON.parse(this.body);
        } catch {
          parsed = undefined;
        }
      }
      return parsed;
    },
  };
}

function actualValue(c, resp) {
  switch (c.source) {
    case 'status':
      return resp.status;
    case 'json':
      return getPath(resp.json, c.path);
    case 'header':
      return resp.headers[String(c.path || '').toLowerCase()];
    default:
      return resp.body;
  }
}

const asText = (v) => (v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));

/** בודק תנאי בודד מול תגובה */
export function testCondition(c, resp) {
  const actual = actualValue(c, resp);
  if (c.op === 'exists') return actual !== undefined && actual !== null;
  if (c.op === 'not_exists') return actual === undefined || actual === null;
  const cs = Boolean(c.case_sensitive);
  const a = cs ? asText(actual) : asText(actual).toLowerCase();
  const v = cs ? String(c.value ?? '') : String(c.value ?? '').toLowerCase();
  switch (c.op) {
    case 'contains':
      return a.includes(v);
    case 'not_contains':
      return !a.includes(v);
    case 'equals':
    case 'not_equals': {
      const numeric = a !== '' && v !== '' && !Number.isNaN(Number(a)) && !Number.isNaN(Number(v));
      const eq = numeric ? Number(a) === Number(v) : a === v;
      return c.op === 'equals' ? eq : !eq;
    }
    case 'starts_with':
      return a.startsWith(v);
    case 'regex':
      try {
        return new RegExp(String(c.value ?? ''), cs ? '' : 'i').test(asText(actual));
      } catch {
        return false;
      }
    case 'gt':
    case 'lt': {
      const x = Number(asText(actual));
      const y = Number(c.value);
      if (Number.isNaN(x) || Number.isNaN(y)) return false;
      return c.op === 'gt' ? x > y : x < y;
    }
    default:
      return false;
  }
}

export function describeCondition(c) {
  const src = c.source === 'json' || c.source === 'header' ? `${SOURCES[c.source]} "${c.path}"` : SOURCES[c.source] || c.source;
  const val = NO_VALUE_OPS.has(c.op) ? '' : ` "${c.value}"`;
  return `${src} ${OPS[c.op] || c.op}${val}`;
}

export function conditionsMatch(conditions, match, resp) {
  if (!conditions?.length) return true;
  return match === 'any' ? conditions.some((c) => testCondition(c, resp)) : conditions.every((c) => testCondition(c, resp));
}

/**
 * בודק אם התגובה מעידה על שגיאה לפי התוכן (מילים אסורות או תנאי שגיאה).
 * מחזיר הודעת שגיאה בעברית, או null אם הכל תקין.
 */
export function contentError(rules, resp) {
  if (!rules) return null;
  const cs = Boolean(rules.keywords_case_sensitive);
  const body = cs ? resp.body : resp.body.toLowerCase();
  for (const k of rules.fail_keywords || []) {
    if (k && body.includes(cs ? k : k.toLowerCase())) return `התגובה מכילה את הביטוי "${k}" שמוגדר כשגיאה`;
  }
  for (const c of rules.fail_conditions || []) {
    if (testCondition(c, resp)) return `תנאי שגיאה התקיים: ${describeCondition(c)}`;
  }
  return null;
}

/**
 * אילו פעולות צריכות לרוץ, לפי הסדר. פעולה עם stop עוצרת את הבדיקה של הפעולות שאחריה.
 * מחזיר [{ action, index, run, reason }]
 */
export function selectActions(rules, outcome, resp) {
  const out = [];
  let stopped = false;
  (rules?.actions || []).forEach((action, index) => {
    if (stopped) return out.push({ action, index, run: false, reason: 'פעולה קודמת עצרה את המשך הבדיקה' });
    if (!action.enabled) return out.push({ action, index, run: false, reason: 'הפעולה מושבתת' });
    if (action.when === 'success' && outcome !== 'success') return out.push({ action, index, run: false, reason: 'רצה רק אחרי הצלחה' });
    if (action.when === 'failure' && outcome !== 'failure') return out.push({ action, index, run: false, reason: 'רצה רק אחרי כשל' });
    if (!conditionsMatch(action.conditions, action.match, resp)) return out.push({ action, index, run: false, reason: 'התנאים לא התקיימו' });
    out.push({ action, index, run: true, reason: 'התנאים התקיימו' });
    if (action.stop) stopped = true;
  });
  return out;
}

// ---------- אימות ונרמול של קלט מהממשק ----------

const str = (v, max) => String(v ?? '').slice(0, max);

function normalizeCondition(c, errors, key) {
  const out = {
    source: SOURCES[c?.source] ? c.source : 'body',
    path: str(c?.path, 300).trim(),
    op: OPS[c?.op] ? c.op : 'contains',
    value: str(c?.value, 2000),
    case_sensitive: Boolean(c?.case_sensitive),
  };
  if ((out.source === 'json' || out.source === 'header') && !out.path) errors[key] = `חסר ${out.source === 'json' ? 'נתיב לשדה JSON (למשל data.status)' : 'שם כותרת'}`;
  if (out.op === 'regex') {
    try {
      new RegExp(out.value);
    } catch {
      errors[key] = `ביטוי רגולרי לא תקין: ${out.value}`;
    }
  }
  if ((out.op === 'gt' || out.op === 'lt') && Number.isNaN(Number(out.value))) errors[key] = 'בהשוואת גדול/קטן הערך צריך להיות מספר';
  return out;
}

/**
 * מנרמל ומאמת את הכללים. validators: { isUrlLike, isValidAddressList } מועברים מבחוץ
 * כדי שהקובץ יישאר בלי תלויות.
 */
export function normalizeRules(input, { isUrlLike, badAddress } = {}) {
  const errors = {};
  const r = input && typeof input === 'object' ? input : {};
  let keywords = r.fail_keywords;
  if (typeof keywords === 'string') keywords = keywords.split('\n');
  const rules = {
    fail_keywords: [...new Set((Array.isArray(keywords) ? keywords : []).map((k) => str(k, 300).trim()).filter(Boolean))].slice(0, 100),
    keywords_case_sensitive: Boolean(r.keywords_case_sensitive),
    fail_conditions: (Array.isArray(r.fail_conditions) ? r.fail_conditions : [])
      .slice(0, MAX_CONDITIONS)
      .map((c, i) => normalizeCondition(c, errors, `rules.fail_conditions.${i}`)),
    no_retry_on_content_error: Boolean(r.no_retry_on_content_error),
    actions: [],
  };
  const actions = Array.isArray(r.actions) ? r.actions : [];
  if (actions.length > MAX_ACTIONS) errors['rules.actions'] = `אפשר להגדיר עד ${MAX_ACTIONS} פעולות`;
  actions.slice(0, MAX_ACTIONS).forEach((a, i) => {
    const key = `rules.actions.${i}`;
    const action = {
      name: str(a?.name, 200).trim() || `פעולה ${i + 1}`,
      enabled: a?.enabled !== false,
      when: WHEN[a?.when] ? a.when : 'always',
      match: a?.match === 'any' ? 'any' : 'all',
      conditions: (Array.isArray(a?.conditions) ? a.conditions : []).slice(0, MAX_CONDITIONS).map((c, j) => normalizeCondition(c, errors, `${key}.conditions.${j}`)),
      type: a?.type === 'webhook' ? 'webhook' : 'email',
      stop: Boolean(a?.stop),
    };
    if (action.type === 'email') {
      const e = a?.email || {};
      action.email = {
        from: str(e.from, 500).trim(),
        to: str(e.to, 2000).trim(),
        cc: str(e.cc, 2000).trim(),
        bcc: str(e.bcc, 2000).trim(),
        subject: str(e.subject, 1000),
        html: str(e.html, 200_000),
        text: str(e.text, 100_000),
      };
      if (!action.email.to) errors[`${key}.email.to`] = 'חובה לציין נמען';
      for (const f of ['from', 'to', 'cc', 'bcc']) {
        const bad = badAddress?.(action.email[f]);
        if (bad) errors[`${key}.email.${f}`] = `כתובת לא תקינה: ${bad}`;
      }
      if (!action.email.subject.trim()) errors[`${key}.email.subject`] = 'חובה למלא נושא';
      if (!action.email.html.trim() && !action.email.text.trim()) errors[`${key}.email.html`] = 'חובה למלא תוכן';
    } else {
      const w = a?.webhook || {};
      action.webhook = {
        method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(String(w.method).toUpperCase()) ? String(w.method).toUpperCase() : 'POST',
        url: str(w.url, 4000).trim(),
        headers: str(w.headers, 20_000).trim() || '{}',
        body: str(w.body, 200_000),
      };
      if (!action.webhook.url) errors[`${key}.webhook.url`] = 'חובה לציין כתובת';
      else if (isUrlLike && !isUrlLike(action.webhook.url)) errors[`${key}.webhook.url`] = 'כתובת לא תקינה';
      try {
        const h = JSON.parse(action.webhook.headers);
        if (!h || typeof h !== 'object' || Array.isArray(h)) throw new Error();
      } catch {
        errors[`${key}.webhook.headers`] = 'הכותרות צריכות להיות אובייקט JSON';
      }
    }
    rules.actions.push(action);
  });
  return { rules, errors };
}

export function parseStoredRules(text) {
  try {
    const r = JSON.parse(text || '{}');
    return { ...EMPTY_RULES, ...r };
  } catch {
    return { ...EMPTY_RULES };
  }
}
