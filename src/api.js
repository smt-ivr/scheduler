// ה-API של הממשק. כל השאילתות פונות לטבלאות scheduler_ בלבד.

import { normalizeTask, WHEN, OPS } from './task.js';
import { nextRun, upcoming, describeSchedule, describeInstant, TYPES, INTERVALS } from './schedule.js';
import { performRequest, planEmails, executeTask, claimTask, parseConfig } from './runner.js';
import { getMailSettings, saveMailSettings, sendEmail, designedEmail, textToBlocks } from './email.js';
import { hebrewToGregorian, HEBREW_MONTHS, gematria, hebrewParts } from './hebrew.js';
import { VARIABLES } from './template.js';
import { localParts } from './time.js';
import { makeResponse } from './task.js';
import { render, whenText } from './template.js';

const json = (data, status = 200) => Response.json(data, { status });
const fail = (error, status = 400, extra = {}) => json({ error, ...extra }, status);

async function body(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function present(row) {
  const cfg = parseConfig(row);
  return {
    id: row.id,
    name: row.name,
    enabled: Boolean(row.enabled),
    description: cfg ? describeSchedule(cfg.schedule) : '',
    url: cfg ? `${cfg.request.method} ${cfg.request.url}` : '',
    rules: cfg?.rules.length || 0,
    next: row.next_run_at ? describeInstant(row.next_run_at) : null,
    last_run_at: row.last_run_at,
    last_status: row.last_status,
    last_error: row.last_error,
    running: Boolean(row.running_since),
  };
}

/** מאמת משימה ומחזיר גם תיאור ומועדים קרובים */
function validate(input, now = Date.now()) {
  const { config, errors } = normalizeTask(input);
  const scheduleOk = !errors.some((e) => e.startsWith('schedule'));
  const info = { description: '', upcoming: [], dates: [] };
  if (scheduleOk) {
    info.description = describeSchedule(config.schedule);
    info.upcoming = upcoming(config.schedule, now, 5);
    if (config.schedule.type === 'dates') {
      info.dates = config.schedule.dates.map((d) => {
        const [y, m, dd] = d.slice(0, 10).split('-').map(Number);
        const p = hebrewParts(y, m, dd);
        return { date: d, hebrew: `${gematria(p.day)} ${HEBREW_MONTHS.find(([k]) => k === p.month)?.[1] || p.month} ${gematria(p.year)}`, past: d <= describeInstant(now).local };
      });
    }
    if (config.enabled && !info.upcoming.length) errors.push('schedule: אין מועד עתידי - כל המועדים כבר עברו');
  }
  return { config, errors, ...info };
}

async function getRow(db, id) {
  return db.prepare('SELECT * FROM scheduler_tasks WHERE id = ?').bind(id).first();
}

async function saveTask(env, request, id = null) {
  const db = env.DB;
  const input = (await body(request)).config;
  const v = validate(input);
  if (v.errors.length) return fail('יש שגיאות במשימה', 422, { errors: v.errors });
  const { config } = v;
  const now = Date.now();
  const next = config.enabled ? nextRun(config.schedule, now) : null;
  if (id) {
    const res = await db
      .prepare('UPDATE scheduler_tasks SET name = ?, enabled = ?, config = ?, next_run_at = ?, updated_at = ? WHERE id = ?')
      .bind(config.name, config.enabled ? 1 : 0, JSON.stringify(config), next, now, id)
      .run();
    if (!res.meta.changes) return fail('המשימה לא נמצאה', 404);
  } else {
    const res = await db
      .prepare('INSERT INTO scheduler_tasks (name, enabled, config, next_run_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(config.name, config.enabled ? 1 : 0, JSON.stringify(config), next, now, now)
      .run();
    id = res.meta.last_row_id;
  }
  return json({ task: present(await getRow(db, id)), config });
}

async function setEnabled(env, id, enabled) {
  const db = env.DB;
  const row = await getRow(db, id);
  const cfg = row && parseConfig(row);
  if (!cfg) return fail('המשימה לא נמצאה', 404);
  const next = enabled ? nextRun(cfg.schedule, Date.now()) : null;
  if (enabled && !next) return fail('אין למשימה מועד עתידי. ערוך אותה והוסף מועד', 409);
  cfg.enabled = enabled;
  await db
    .prepare('UPDATE scheduler_tasks SET enabled = ?, config = ?, next_run_at = ?, updated_at = ? WHERE id = ?')
    .bind(enabled ? 1 : 0, JSON.stringify(cfg), next, Date.now(), id)
    .run();
  return json({ task: present(await getRow(db, id)) });
}

async function runNow(env, ctx, id) {
  const db = env.DB;
  const row = await getRow(db, id);
  const cfg = row && parseConfig(row);
  if (!cfg) return fail('המשימה לא נמצאה', 404);
  const claim = await claimTask(db, row, cfg, { now: Date.now(), scheduled: false });
  if (!claim) return fail('המשימה רצה כרגע, נסה שוב בעוד רגע', 409);
  const p = executeTask(env, row, cfg, { trigger: 'manual', token: claim.token });
  ctx.waitUntil(p.catch(() => {}));
  return json({ run: await p });
}

/** בדיקה: מריץ את הבקשה בלי לשמור ובלי לשלוח מיילים, ומראה מה היה נשלח */
async function testTask(env, request) {
  const v = validate((await body(request)).config);
  const errors = v.errors.filter((e) => !e.startsWith('schedule'));
  if (errors.length) return fail('יש שגיאות במשימה', 422, { errors });
  const ctx = { env, now: Date.now(), task: { id: 0, name: v.config.name }, runId: 'בדיקה' };
  const t0 = Date.now();
  const res = await performRequest(v.config, ctx, { retries: 0 });
  Object.assign(ctx, { resp: res.resp, outcome: res.outcome, error: res.error });
  return json({
    outcome: res.outcome,
    error: res.error,
    status_code: res.resp.status,
    duration_ms: Date.now() - t0,
    response: res.resp.body.slice(0, 5000),
    emails: planEmails(v.config, ctx, { brand: (await getMailSettings(env.DB)).brand_name }),
  });
}

async function listRuns(env, url) {
  const where = [];
  const binds = [];
  const taskId = Number(url.searchParams.get('task_id'));
  if (taskId) {
    where.push('task_id = ?');
    binds.push(taskId);
  }
  const before = Number(url.searchParams.get('before_id'));
  if (before) {
    where.push('id < ?');
    binds.push(before);
  }
  const { results } = await env.DB
    .prepare(
      `SELECT id, task_id, task_name, trigger, status, started_at, duration_ms, attempts, status_code, error, emails
       FROM scheduler_runs ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT 51`
    )
    .bind(...binds)
    .all();
  const runs = results.slice(0, 50).map((r) => ({ ...r, emails: JSON.parse(r.emails || '[]').length }));
  return json({ runs, has_more: results.length > 50 });
}

async function getRun(env, id) {
  const run = await env.DB.prepare('SELECT * FROM scheduler_runs WHERE id = ?').bind(id).first();
  if (!run) return fail('הריצה לא נמצאה', 404);
  run.emails = JSON.parse(run.emails || '[]');
  return json({ run });
}

async function getSettings(env) {
  const s = await getMailSettings(env.DB);
  const key = s.resend_api_key || env.RESEND_API_KEY || '';
  return json({
    from_email: s.from_email,
    reply_to: s.reply_to,
    brand_name: s.brand_name,
    has_key: Boolean(key),
    key_hint: key ? `${key.slice(0, 3)}…${key.slice(-4)}` : '',
  });
}

async function putSettings(env, request) {
  const b = await body(request);
  const values = { from_email: String(b.from_email ?? '').trim(), reply_to: String(b.reply_to ?? '').trim(), brand_name: String(b.brand_name ?? '').trim().slice(0, 100) };
  if (b.resend_api_key) values.resend_api_key = String(b.resend_api_key).trim();
  if (values.from_email && !/^[^<>]*<?[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+>?$/.test(values.from_email)) return fail('כתובת השולח לא תקינה. דוגמה: מערכת <noreply@your-domain.com>');
  if (values.reply_to && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.reply_to)) return fail('כתובת המענה לא תקינה');
  await saveMailSettings(env.DB, values);
  return getSettings(env);
}

async function testEmail(env, request) {
  const to = String((await body(request)).to || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return fail('כתובת לא תקינה');
  const settings = await getMailSettings(env.DB);
  const text = 'שלום,\n\nזהו מייל בדיקה. אם הוא הגיע אליך, הגדרות המייל תקינות והמיילים של המשימות יישלחו כך.\n\nבברכה';
  const html = designedEmail({ title: 'מייל בדיקה', bodyHtml: textToBlocks(text), outcome: 'success', brand: settings.brand_name });
  const r = await sendEmail(env, settings, { to: [to], subject: 'מייל בדיקה ממתזמן המשימות', text, html });
  return r.ok ? json({ ok: true }) : fail(r.error, 502);
}

/**
 * תצוגה מקדימה של מייל מעוצב, בלי להריץ את הבקשה.
 * עם rule: מציג את המייל של הכלל עם נתוני דוגמה. בלי rule: מייל לדוגמה (לדף ההגדרות).
 */
async function emailPreview(env, request) {
  const b = await body(request);
  const settings = await getMailSettings(env.DB);
  const brand = b.brand_name ?? settings.brand_name;
  const rule = b.rule;
  const outcome = rule?.when === 'failure' ? 'failure' : 'success';
  const ctx = {
    env,
    now: Date.now(),
    task: { name: b.name || 'שם המשימה' },
    resp: makeResponse({ status: outcome === 'success' ? 200 : 500, body: '{"responseStatus":"OK","message":"ok"}' }),
    outcome,
    error: 'דוגמה לסיבת כשל: השרת לא ענה',
  };
  const subject = rule ? render(rule.email?.subject || '', ctx) : 'בוצע בהצלחה: העתקת הקובץ';
  const text = rule ? render(rule.email?.body || '', ctx) : 'שלום רב,\n\nרצינו לעדכן שהפעולה בוצעה בהצלחה.\n\nמה בוצע:\n• הקובץ הועתק משלוחה 1 לשלוחה 2\n• הוא זמין עכשיו למאזינים\n\nבברכה';
  if (rule?.email?.html) return json({ subject, html: render(rule.email.body || '', ctx, { html: true }) });
  const html = designedEmail({
    title: subject,
    bodyHtml: textToBlocks(text),
    outcome: rule?.when === 'always' ? 'success' : outcome,
    details: [['משימה', ctx.task.name], ['מתי', whenText(ctx.now)]],
    brand,
  });
  return json({ subject, html });
}

function meta() {
  const p = localParts(Date.now());
  const hy = hebrewParts(p.year, p.month, p.day).year;
  return json({
    types: TYPES,
    intervals: INTERVALS,
    when: WHEN,
    ops: OPS,
    variables: VARIABLES,
    hebrew_months: HEBREW_MONTHS,
    hebrew_years: [hy, hy + 1, hy + 2].map((y) => ({ year: y, label: gematria(y) })),
  });
}

export async function handleApi(request, env, ctx, path) {
  const m = request.method;
  const p = path.replace(/^\/api/, '');
  let match;

  if (p === '/meta' && m === 'GET') return meta();
  if (p === '/stats' && m === 'GET') {
    const since = Date.now() - 7 * 86_400_000;
    const [t, r] = await Promise.all([
      env.DB.prepare('SELECT COUNT(*) AS total, SUM(enabled = 1) AS active, MIN(CASE WHEN enabled = 1 THEN next_run_at END) AS next_at FROM scheduler_tasks').first(),
      env.DB.prepare("SELECT SUM(status = 'success') AS ok, SUM(status = 'failure') AS bad FROM scheduler_runs WHERE started_at >= ?").bind(since).first(),
    ]);
    return json({ total: t.total || 0, active: t.active || 0, next: t.next_at ? describeInstant(t.next_at) : null, ok7: r.ok || 0, bad7: r.bad || 0 });
  }
  if (p === '/tasks' && m === 'GET') {
    const { results } = await env.DB.prepare('SELECT * FROM scheduler_tasks ORDER BY enabled DESC, COALESCE(next_run_at, 9e15), id').all();
    return json({ tasks: results.map(present) });
  }
  if (p === '/tasks' && m === 'POST') return saveTask(env, request);
  if (p === '/validate' && m === 'POST') {
    const v = validate((await body(request)).config);
    return json(v);
  }
  if (p === '/test' && m === 'POST') return testTask(env, request);
  if ((match = /^\/tasks\/(\d+)$/.exec(p))) {
    const id = Number(match[1]);
    if (m === 'GET') {
      const row = await getRow(env.DB, id);
      const cfg = row && parseConfig(row);
      if (!cfg) return fail('המשימה לא נמצאה', 404);
      cfg.enabled = Boolean(row.enabled);
      return json({ task: present(row), config: cfg });
    }
    if (m === 'PUT') return saveTask(env, request, id);
    if (m === 'DELETE') {
      await env.DB.batch([
        env.DB.prepare('DELETE FROM scheduler_tasks WHERE id = ?').bind(id),
        env.DB.prepare('DELETE FROM scheduler_runs WHERE task_id = ?').bind(id),
      ]);
      return json({ ok: true });
    }
  }
  if ((match = /^\/tasks\/(\d+)\/(enable|disable|run)$/.exec(p)) && m === 'POST') {
    const id = Number(match[1]);
    if (match[2] === 'run') return runNow(env, ctx, id);
    return setEnabled(env, id, match[2] === 'enable');
  }
  if (p === '/runs' && m === 'GET') return listRuns(env, new URL(request.url));
  if ((match = /^\/runs\/(\d+)$/.exec(p)) && m === 'GET') return getRun(env, Number(match[1]));
  if (p === '/settings' && m === 'GET') return getSettings(env);
  if (p === '/settings' && m === 'PUT') return putSettings(env, request);
  if (p === '/settings/test' && m === 'POST') return testEmail(env, request);
  if (p === '/email-preview' && m === 'POST') return emailPreview(env, request);
  if (p === '/hebrew-to-gregorian' && m === 'GET') {
    const u = new URL(request.url);
    const date = hebrewToGregorian(Number(u.searchParams.get('year')), u.searchParams.get('month'), Number(u.searchParams.get('day')));
    return date ? json({ date }) : fail('התאריך העברי לא נמצא');
  }
  return fail('לא נמצא', 404);
}
