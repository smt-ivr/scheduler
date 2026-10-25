// החלפת משתנים בתבניות: {{secret:NAME}}, {{date}}, {{datetime}}, {{timestamp}} ועוד.
// ערכי סודות נאספים כדי להסתיר אותם (***) בכל מה שנשמר ביומן.

import { formatDate, formatDateTime } from './time.js';

// סודות של המערכת עצמה - אי אפשר להפנות אליהם מתוך משימה
export const RESERVED_SECRETS = new Set(['ADMIN_PASSWORD', 'RESEND_API_KEY', 'RESEND_WEBHOOK_SECRET', 'RESEND_API_URL']);

export class TemplateError extends Error {}

const PATTERN = /\{\{\s*([a-z_]+)(?::([A-Za-z0-9_+-]+))?\s*\}\}/g;

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

/**
 * יוצר הקשר להחלפה. כל ההחלפות באותה ריצה משתמשות באותו "עכשיו",
 * כך שגם בניסיון חוזר הערכים זהים.
 */
export function createContext(env, { now = Date.now(), task = {}, runId = '' } = {}) {
  return { env, now, task, runId, secrets: new Set(), maskSecrets: false };
}

export function render(text, ctx) {
  if (text == null || text === '') return text ?? '';
  return String(text).replace(PATTERN, (whole, name, arg) => {
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
        return String(ctx.task.name ?? '');
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
