// החלפת משתנים בתבניות: {{secret:NAME}}, {{date}}, {{datetime}}, {{timestamp}} ועוד.
// ערכי סודות נאספים כדי להסתיר אותם (***) בכל מה שנשמר ביומן.

import { formatDate, formatDateTime } from './time.js';
import { getPath } from './rules.js';

// סודות של המערכת עצמה - אי אפשר להפנות אליהם מתוך משימה
export const RESERVED_SECRETS = new Set(['ADMIN_PASSWORD', 'RESEND_API_KEY', 'RESEND_WEBHOOK_SECRET', 'RESEND_API_URL', 'BASE_PATH']);

export class TemplateError extends Error {}

const PATTERN = /\{\{\s*([a-z_]+)(?::([^{}]+?))?\s*\}\}/g;

export const TEMPLATE_VARIABLES = [
  { name: '{{secret:NAME}}', desc: 'ערך של Worker secret בשם NAME (לא נשמר ולא מוצג)' },
  { name: '{{date}}', desc: 'תאריך היום בירושלים, YYYY-MM-DD' },
  { name: '{{date:-1}}', desc: 'תאריך עם הזזה בימים (אתמול, מחר...)' },
  { name: '{{datetime}}', desc: 'תאריך ושעה בירושלים, YYYY-MM-DD HH:mm:ss' },
  { name: '{{timestamp}}', desc: 'Unix timestamp בשניות' },
  { name: '{{timestamp_ms}}', desc: 'Unix timestamp במילישניות' },
  { name: '{{iso}}', desc: 'זמן UTC בפורמט ISO 8601' },
  { name: '{{uuid}}', desc: 'מזהה ייחודי אקראי' },
  { name: '{{task_id}}', desc: 'מזהה המשימה' },
  { name: '{{task_name}}', desc: 'שם המשימה' },
  { name: '{{run_id}}', desc: 'מזהה הריצה' },
];

// משתנים שזמינים רק בפעולות שאחרי הריצה (מיילים ו-webhooks מותנים)
export const RESULT_VARIABLES = [
  { name: '{{result}}', desc: 'תוצאת הריצה: "הצליחה" או "נכשלה"' },
  { name: '{{status_code}}', desc: 'קוד התגובה (למשל 200)' },
  { name: '{{response}}', desc: 'תחילת גוף התגובה (עד 2000 תווים)' },
  { name: '{{json:data.status}}', desc: 'ערך של שדה מתוך תגובת JSON' },
  { name: '{{header:content-type}}', desc: 'ערך של כותרת מהתגובה' },
  { name: '{{error}}', desc: 'הודעת השגיאה, אם הייתה' },
  { name: '{{attempts}}', desc: 'מספר הניסיונות' },
  { name: '{{duration_ms}}', desc: 'משך הריצה במילישניות' },
  { name: '{{run_url}}', desc: 'קישור לפרטי הריצה בממשק' },
];

const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const asText = (v) => (v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));

/**
 * יוצר הקשר להחלפה. כל ההחלפות באותה ריצה משתמשות באותו "עכשיו",
 * כך שגם בניסיון חוזר הערכים זהים.
 */
export function createContext(env, { now = Date.now(), task = {}, runId = '' } = {}) {
  return { env, now, task, runId, secrets: new Set(), maskSecrets: false };
}

/**
 * opts.html: הערכים שמגיעים מהתגובה עוברים escape, כדי שתוכן מ-API חיצוני לא ישתול HTML במייל.
 */
export function render(text, ctx, opts = {}) {
  if (text == null || text === '') return text ?? '';
  const out = (v) => (opts.html ? escapeHtml(asText(v)) : asText(v));
  return String(text).replace(PATTERN, (whole, name, arg) => {
    // משתני תוצאה - רק כשיש תגובה בהקשר
    const r = ctx.result;
    if (r) {
      switch (name) {
        case 'result':
          return r.outcome === 'success' ? 'הצליחה' : 'נכשלה';
        case 'status_code':
          return out(r.response.status ?? '');
        case 'response':
          return out(r.response.body.slice(0, 2000));
        case 'json':
          return out(getPath(r.response.json, arg));
        case 'header':
          return out(r.response.headers[String(arg || '').toLowerCase()]);
        case 'error':
          return out(r.error || '');
        case 'attempts':
          return String(r.attempts ?? '');
        case 'duration_ms':
          return String(r.duration_ms ?? '');
        case 'run_url':
          return out(r.run_url || '');
      }
    }
    switch (name) {
      case 'secret': {
        if (!arg) throw new TemplateError('חסר שם סוד ב-{{secret:NAME}}');
        if (RESERVED_SECRETS.has(arg)) throw new TemplateError(`הסוד ${arg} שמור למערכת ואי אפשר להשתמש בו במשימה`);
        const value = ctx.env[arg];
        if (typeof value !== 'string') throw new TemplateError(`הסוד ${arg} לא מוגדר ב-Worker`);
        if (ctx.maskSecrets) return `***${arg}***`;
        ctx.secrets.add(value);
        return value;
      }
      case 'date': {
        const shift = arg && /^[+-]?\d+$/.test(arg) ? Number(arg) : 0;
        return formatDate(ctx.now + shift * 86_400_000);
      }
      case 'datetime':
        return formatDateTime(ctx.now);
      case 'timestamp':
        return String(Math.floor(ctx.now / 1000));
      case 'timestamp_ms':
        return String(ctx.now);
      case 'iso':
        return new Date(ctx.now).toISOString();
      case 'uuid':
        return crypto.randomUUID();
      case 'task_id':
        return String(ctx.task.id ?? '');
      case 'task_name':
        return out(ctx.task.name ?? '');
      case 'run_id':
        return String(ctx.runId ?? '');
      default:
        return whole;
    }
  });
}

/** מסתיר ערכי סודות שהופיעו בריצה */
export function redact(text, ctx) {
  if (text == null) return text;
  let out = String(text);
  for (const s of ctx.secrets) {
    if (s && s.length >= 3) out = out.split(s).join('***');
  }
  return out;
}

/** שמות הסודות הזמינים למשימות (שמות בלבד, לעולם לא ערכים) */
export function listSecretNames(env) {
  return Object.keys(env)
    .filter((k) => typeof env[k] === 'string' && /^[A-Z][A-Z0-9_]*$/.test(k) && !RESERVED_SECRETS.has(k))
    .sort();
}
