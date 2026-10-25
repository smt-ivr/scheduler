// ה-API של ממשק הניהול. כל השאילתות כאן פונות לטבלאות scheduler_ בלבד.

import { nextRuns, describeCron, validateCron, parseCron, CronError } from './cron.js';
import { formatDateTime, formatLocalInput, parseLocalDateTime } from './time.js';
import { computeNextRun, claimTask } from './scheduler.js';
import { executeTask, buildHttpRequest, buildEmail } from './executor.js';
import { getSettings, saveSettings, DEFAULT_SETTINGS } from './settings.js';
import { createContext, listSecretNames, TEMPLATE_VARIABLES } from './templates.js';
import { sendEmail, recordEmail, splitAddresses, isValidAddress } from './resend.js';
import { clientIp } from './auth.js';
import { normalizeRules, parseStoredRules, makeResponse, contentError, selectActions, SOURCES, OPS, WHEN } from './rules.js';
import { statusMatches, loadRules } from './executor.js';
import { RESULT_VARIABLES, render } from './templates.js';

const json = (data, status = 200) => Response.json(data, { status });
const fail = (error, status = 400, extra = {}) => json({ error, ...extra }, status);

// שדות ההגדרה של משימה (מה שנשמר בעריכה, בשכפול ובייצוא)
const CONFIG_FIELDS = [
  'name', 'description', 'tags', 'task_type', 'schedule_type', 'cron_expr', 'run_at',
  'http_url', 'http_method', 'http_headers', 'http_body', 'expect_status', 'expect_body',
  'email_from', 'email_to', 'email_cc', 'email_bcc', 'email_reply_to', 'email_subject', 'email_html', 'email_text',
  'enabled', 'timeout_ms', 'max_attempts', 'retry_delay_ms', 'notify_webhook_url', 'notify_email',
];

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const STATUS_SPEC = /^\s*\d{3}(\s*-\s*\d{3})?(\s*,\s*\d{3}(\s*-\s*\d{3})?)*\s*$/;
const clamp = (v, lo, hi, def) => {
  if (v == null || v === '') return def;
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(Math.max(n, lo), hi) : def;
};
const str = (v, max = 100_000) => String(v ?? '').slice(0, max);

function isUrlLike(s) {
  try {
    const u = new URL(String(s).replace(/\{\{[^}]*\}\}/g, 'x'));
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** מנרמל ומאמת קלט של משימה. מחזיר { values, errors } */
export function normalizeTask(input, { now = Date.now() } = {}) {
  const errors = {};
  const v = {};
  v.name = str(input.name, 200).trim();
  if (!v.name) errors.name = 'שם המשימה חובה';
  v.description = str(input.description, 2000);
  v.tags = str(input.tags, 500)
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
    .join(', ');
  v.task_type = input.task_type === 'email' ? 'email' : 'http';
  v.schedule_type = input.schedule_type === 'once' ? 'once' : 'cron';
  v.enabled = input.enabled === false || input.enabled === 0 || input.enabled === '0' ? 0 : 1;

  if (v.schedule_type === 'cron') {
    v.cron_expr = str(input.cron_expr, 200).trim().replace(/\s+/g, ' ');
    v.run_at = null;
    const err = validateCron(v.cron_expr);
    if (err) errors.cron_expr = err;
  } else {
    // תאריכים מדויקים: רשימה של מועדים (או מועד יחיד, לתאימות לאחור)
    v.cron_expr = null;
    let list = input.run_dates_local;
    if (!Array.isArray(list)) list = input.run_at_local ? [input.run_at_local] : input.run_at ? [formatLocalInput(Number(input.run_at))] : [];
    const parsed = [];
    let bad = null;
    for (const s of list.slice(0, 1000)) {
      if (!String(s ?? '').trim()) continue;
      const ms = parseLocalDateTime(s);
      if (ms) parsed.push(ms);
      else bad ??= s;
    }
    v.run_dates = [...new Set(parsed)].sort((a, b) => a - b);
    const past = v.run_dates.find((ms) => ms <= now);
    if (bad) errors.run_dates = `תאריך לא תקין: ${bad}`;
    else if (!v.run_dates.length) errors.run_dates = 'יש להוסיף לפחות מועד אחד';
    else if (v.run_dates.length > 500) errors.run_dates = 'אפשר להגדיר עד 500 מועדים';
    else if (past && v.enabled) errors.run_dates = `המועד ${formatDateTime(past).slice(0, 16)} כבר עבר`;
    v.run_at = v.run_dates.find((ms) => ms > now) ?? null;
  }

  v.http_method = METHODS.includes(String(input.http_method).toUpperCase()) ? String(input.http_method).toUpperCase() : 'GET';
  v.http_url = str(input.http_url, 4000).trim();
  let headers = input.http_headers ?? '{}';
  if (typeof headers === 'object') headers = JSON.stringify(headers);
  v.http_headers = str(headers, 20_000).trim() || '{}';
  v.http_body = str(input.http_body, 200_000);
  v.expect_status = str(input.expect_status, 100).trim() || '200-299';
  v.expect_body = str(input.expect_body, 500);
  if (!STATUS_SPEC.test(v.expect_status)) errors.expect_status = 'פורמט לא תקין. דוגמה: 200-299,304';

  for (const f of ['email_from', 'email_to', 'email_cc', 'email_bcc', 'email_reply_to']) v[f] = str(input[f], 4000).trim();
  v.email_subject = str(input.email_subject, 1000);
  v.email_html = str(input.email_html, 500_000);
  v.email_text = str(input.email_text, 200_000);

  if (v.task_type === 'http') {
    if (!v.http_url) errors.http_url = 'כתובת URL חובה';
    else if (!isUrlLike(v.http_url)) errors.http_url = 'כתובת לא תקינה (נדרש http:// או https://)';
    try {
      const h = JSON.parse(v.http_headers);
      if (!h || typeof h !== 'object' || Array.isArray(h)) throw new Error();
      if (Object.values(h).some((x) => typeof x !== 'string')) errors.http_headers = 'כל ערכי הכותרות צריכים להיות מחרוזות';
    } catch {
      errors.http_headers = 'הכותרות צריכות להיות אובייקט JSON תקין, למשל {"Authorization": "Bearer {{secret:API_KEY}}"}';
    }
  } else {
    const hasTemplate = (s) => s.includes('{{');
    if (!v.email_to) errors.email_to = 'חובה לציין לפחות נמען אחד';
    for (const f of ['email_from', 'email_to', 'email_cc', 'email_bcc', 'email_reply_to']) {
      const bad = splitAddresses(v[f]).find((a) => !hasTemplate(a) && !isValidAddress(a));
      if (bad) errors[f] = `כתובת לא תקינה: ${bad}`;
    }
    if (!v.email_subject.trim()) errors.email_subject = 'נושא חובה';
    if (!v.email_html.trim() && !v.email_text.trim()) errors.email_html = 'יש למלא תוכן HTML או טקסט';
  }

  v.timeout_ms = clamp(input.timeout_ms, 1000, 120_000, 30_000);
  v.max_attempts = clamp(input.max_attempts, 1, 5, 3);
  v.retry_delay_ms = clamp(input.retry_delay_ms, 0, 60_000, 2000);
  v.notify_webhook_url = str(input.notify_webhook_url, 2000).trim();
  if (v.notify_webhook_url && !isUrlLike(v.notify_webhook_url)) errors.notify_webhook_url = 'כתובת webhook לא תקינה';
  v.notify_email = str(input.notify_email, 1000).trim();
  const badNotify = splitAddresses(v.notify_email).find((a) => !isValidAddress(a));
  if (badNotify) errors.notify_email = `כתובת לא תקינה: ${badNotify}`;

  const { rules, errors: ruleErrors } = normalizeRules(input.rules, {
    isUrlLike: (s) => isUrlLike(s),
    badAddress: (s) => splitAddresses(s).find((a) => !a.includes('{{') && !isValidAddress(a)),
  });
  v.rules = rules;
  Object.assign(errors, ruleErrors);

  return { values: v, errors };
}

/** מה שנשלח לממשק על משימה */
/** pending: מספר המועדים העתידיים שממתינים (למשימת תאריכים); dates: כל המועדים, לעורך */
function presentTask(t, { pending = null, dates = null } = {}) {
  let description = '';
  if (t.schedule_type === 'cron') {
    try {
      description = describeCron(t.cron_expr);
    } catch {}
  } else {
    const n = pending ?? (dates ? dates.filter((d) => d.ran_at == null && d.run_at > Date.now()).length : t.run_at ? 1 : 0);
    const nextText = t.run_at ? formatDateTime(t.run_at).slice(0, 16) : '';
    if (n === 0) description = t.last_run_at ? 'תאריכים מדויקים: כל המועדים רצו' : 'תאריכים מדויקים: אין מועדים עתידיים';
    else if (n === 1) description = `תאריך מדויק: ${nextText}`;
    else description = `${n} תאריכים מדויקים, הבא: ${nextText}`;
  }
  const out = { ...t, lock_token: undefined, schedule_text: description };
  if (dates) {
    out.run_dates = dates.map((d) => ({ run_at: d.run_at, ran_at: d.ran_at, local: formatLocalInput(d.run_at) }));
  }
  return out;
}

async function fullTask(db, id) {
  const t = await getTask(db, id);
  if (!t) return null;
  const [dates, rules] = await Promise.all([getTaskDates(db, id), loadRules(db, id)]);
  return { ...presentTask(t, { dates }), rules };
}

function saveRulesStatement(db, taskId, rules) {
  return db
    .prepare(
      `INSERT INTO scheduler_task_rules (task_id, rules, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(task_id) DO UPDATE SET rules = excluded.rules, updated_at = excluded.updated_at`
    )
    .bind(taskId, JSON.stringify(rules), Date.now());
}

async function getTaskDates(db, taskId) {
  const { results } = await db.prepare('SELECT run_at, ran_at FROM scheduler_task_dates WHERE task_id = ? ORDER BY run_at').bind(taskId).all();
  return results;
}

/** מחליף את המועדים הממתינים של משימה. מועדים שכבר רצו נשארים כהיסטוריה. */
function saveDatesStatements(db, taskId, dates = []) {
  return [
    db.prepare('DELETE FROM scheduler_task_dates WHERE task_id = ? AND ran_at IS NULL').bind(taskId),
    ...dates.map((ms) => db.prepare('INSERT OR IGNORE INTO scheduler_task_dates (task_id, run_at) VALUES (?, ?)').bind(taskId, ms)),
  ];
}

async function audit(env, request, action, taskId = null, details = null) {
  await env.DB.prepare('INSERT INTO scheduler_audit (at, action, task_id, ip, details) VALUES (?, ?, ?, ?, ?)')
    .bind(Date.now(), action, taskId, clientIp(request), details ? String(details).slice(0, 2000) : null)
    .run()
    .catch((e) => console.error('audit failed', e));
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

async function getTask(db, id) {
  return db.prepare('SELECT * FROM scheduler_tasks WHERE id = ?').bind(id).first();
}

async function insertTask(db, v, now = Date.now()) {
  const next = computeNextRun(v, now);
  const cols = [...CONFIG_FIELDS, 'next_run_at', 'created_at', 'updated_at'];
  const vals = [...CONFIG_FIELDS.map((f) => v[f] ?? null), next, now, now];
  const res = await db
    .prepare(`INSERT INTO scheduler_tasks (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
    .bind(...vals)
    .run();
  const id = res.meta.last_row_id;
  const extra = [];
  if (v.schedule_type === 'once' && v.run_dates?.length) extra.push(...saveDatesStatements(db, id, v.run_dates));
  if (v.rules) extra.push(saveRulesStatement(db, id, v.rules));
  if (extra.length) await db.batch(extra);
  return id;
}

// ---------- handlers ----------

async function dashboard(env) {
  const db = env.DB;
  const now = Date.now();
  const dayAgo = now - 86_400_000;
  const [tasks, runs24, hourly, emails7, upcoming, failures, settings] = await Promise.all([
    db
      .prepare(
        `SELECT COUNT(*) AS total,
           SUM(enabled = 1) AS enabled,
           SUM(enabled = 0) AS disabled,
           SUM(enabled = 1 AND last_status = 'failure') AS failing,
           SUM(running_since IS NOT NULL) AS running,
           SUM(task_type = 'email') AS email_tasks
         FROM scheduler_tasks`
      )
      .first(),
    db
      .prepare(
        `SELECT COUNT(*) AS total, SUM(status = 'success') AS success, SUM(status = 'failure') AS failure,
           CAST(AVG(duration_ms) AS INTEGER) AS avg_ms
         FROM scheduler_runs WHERE started_at >= ?`
      )
      .bind(dayAgo)
      .first(),
    db
      .prepare(
        `SELECT CAST((started_at - ?) / 3600000 AS INTEGER) AS bucket, status, COUNT(*) AS n
         FROM scheduler_runs WHERE started_at >= ? GROUP BY bucket, status`
      )
      .bind(dayAgo, dayAgo)
      .all(),
    db.prepare('SELECT status, COUNT(*) AS n FROM scheduler_emails WHERE created_at >= ? GROUP BY status').bind(now - 7 * 86_400_000).all(),
    db
      .prepare(
        `SELECT id, name, task_type, schedule_type, cron_expr, run_at, next_run_at FROM scheduler_tasks
         WHERE enabled = 1 AND next_run_at IS NOT NULL ORDER BY next_run_at LIMIT 8`
      )
      .all(),
    db
      .prepare(`SELECT id, task_id, task_name, started_at, status_code, error FROM scheduler_runs WHERE status = 'failure' ORDER BY id DESC LIMIT 8`)
      .all(),
    getSettings(db),
  ]);
  const buckets = Array.from({ length: 24 }, (_, i) => ({ hour_start: dayAgo + i * 3_600_000, success: 0, failure: 0 }));
  for (const r of hourly.results) {
    const b = buckets[Math.min(Math.max(r.bucket, 0), 23)];
    if (r.status === 'success' || r.status === 'failure') b[r.status] += r.n;
  }
  return json({
    now,
    paused: settings.paused === '1',
    tasks,
    runs24,
    hourly: buckets,
    emails7: Object.fromEntries(emails7.results.map((r) => [r.status, r.n])),
    upcoming: upcoming.results.map(presentTask),
    failures: failures.results,
    resend_configured: Boolean(env.RESEND_API_KEY),
    webhook_configured: Boolean(env.RESEND_WEBHOOK_SECRET),
  });
}

async function listTasks(env, url) {
  const { results } = await env.DB.prepare('SELECT * FROM scheduler_tasks ORDER BY enabled DESC, COALESCE(next_run_at, 9e15), id').all();
  const pendingRows = await env.DB
    .prepare('SELECT task_id, COUNT(*) AS n FROM scheduler_task_dates WHERE ran_at IS NULL AND run_at > ? GROUP BY task_id')
    .bind(Date.now())
    .all();
  const pending = new Map(pendingRows.results.map((r) => [r.task_id, r.n]));
  const q = (url.searchParams.get('q') || '').toLowerCase();
  const status = url.searchParams.get('status') || '';
  const type = url.searchParams.get('type') || '';
  const tag = url.searchParams.get('tag') || '';
  const filtered = results.filter((t) => {
    if (q && ![t.name, t.description, t.http_url, t.email_to, t.tags].some((x) => String(x || '').toLowerCase().includes(q))) return false;
    if (type && t.task_type !== type) return false;
    if (tag && !String(t.tags || '').split(',').map((x) => x.trim()).includes(tag)) return false;
    if (status === 'active' && !t.enabled) return false;
    if (status === 'disabled' && t.enabled) return false;
    if (status === 'failing' && !(t.enabled && t.last_status === 'failure')) return false;
    if (status === 'running' && !t.running_since) return false;
    return true;
  });
  const tags = [...new Set(results.flatMap((t) => String(t.tags || '').split(',').map((x) => x.trim()).filter(Boolean)))].sort();
  return json({ tasks: filtered.map((t) => presentTask(t, { pending: pending.get(t.id) ?? 0 })), tags, total: results.length });
}

async function createTask(env, request) {
  const body = await readJson(request);
  const { values, errors } = normalizeTask(body);
  if (Object.keys(errors).length) return fail('יש שגיאות בטופס', 422, { fields: errors });
  const id = await insertTask(env.DB, values);
  await audit(env, request, 'task.create', id, values.name);
  return json({ task: await fullTask(env.DB, id) }, 201);
}

async function updateTask(env, request, id) {
  const db = env.DB;
  const prev = await getTask(db, id);
  if (!prev) return fail('המשימה לא נמצאה', 404);
  const body = await readJson(request);
  const { values, errors } = normalizeTask(body);
  if (Object.keys(errors).length) return fail('יש שגיאות בטופס', 422, { fields: errors });
  const now = Date.now();
  const next = computeNextRun(values, now);
  const sets = CONFIG_FIELDS.map((f) => `${f} = ?`).join(', ');
  await db.batch([
    db
      .prepare(`UPDATE scheduler_tasks SET ${sets}, next_run_at = ?, updated_at = ? WHERE id = ?`)
      .bind(...CONFIG_FIELDS.map((f) => values[f] ?? null), next, now, id),
    ...saveDatesStatements(db, id, values.schedule_type === 'once' ? values.run_dates : []),
    saveRulesStatement(db, id, values.rules),
  ]);
  await audit(env, request, 'task.update', id, values.name);
  return json({ task: await fullTask(db, id) });
}

async function deleteTask(env, request, id) {
  const db = env.DB;
  const t = await getTask(db, id);
  if (!t) return fail('המשימה לא נמצאה', 404);
  await db.batch([
    db.prepare('DELETE FROM scheduler_tasks WHERE id = ?').bind(id),
    db.prepare('DELETE FROM scheduler_runs WHERE task_id = ?').bind(id),
    db.prepare('DELETE FROM scheduler_task_dates WHERE task_id = ?').bind(id),
    db.prepare('DELETE FROM scheduler_task_rules WHERE task_id = ?').bind(id),
    db.prepare('DELETE FROM scheduler_action_log WHERE task_id = ?').bind(id),
  ]);
  await audit(env, request, 'task.delete', id, t.name);
  return json({ ok: true });
}

async function setEnabled(env, request, id, enabled) {
  const db = env.DB;
  const t = await getTask(db, id);
  if (!t) return fail('המשימה לא נמצאה', 404);
  const now = Date.now();
  let runAt = t.run_at;
  if (t.schedule_type === 'once') {
    // המועד הבא שעוד לא עבר; מועדים שעברו בזמן שהמשימה הייתה מושבתת מדולגים
    const row = await db
      .prepare('SELECT MIN(run_at) AS next FROM scheduler_task_dates WHERE task_id = ? AND ran_at IS NULL AND run_at > ?')
      .bind(id, now)
      .first();
    runAt = row?.next ?? null;
    if (enabled && !runAt) return fail('אין למשימה מועדים עתידיים. ערוך אותה והוסף תאריך חדש', 409);
  }
  const next = computeNextRun({ ...t, run_at: runAt, enabled: enabled ? 1 : 0 }, now);
  await db
    .prepare('UPDATE scheduler_tasks SET enabled = ?, run_at = ?, next_run_at = ?, updated_at = ? WHERE id = ?')
    .bind(enabled ? 1 : 0, runAt, next, now, id)
    .run();
  await audit(env, request, enabled ? 'task.enable' : 'task.disable', id, t.name);
  return json({ task: await fullTask(db, id) });
}

async function duplicateTask(env, request, id) {
  const t = await getTask(env.DB, id);
  if (!t) return fail('המשימה לא נמצאה', 404);
  const copy = Object.fromEntries(CONFIG_FIELDS.map((f) => [f, t[f]]));
  copy.name = `${t.name} (עותק)`;
  copy.enabled = 0;
  copy.rules = await loadRules(env.DB, id);
  if (t.schedule_type === 'once') {
    copy.run_dates = (await getTaskDates(env.DB, id)).filter((d) => d.ran_at == null && d.run_at > Date.now()).map((d) => d.run_at);
  }
  const newId = await insertTask(env.DB, copy);
  await audit(env, request, 'task.duplicate', newId, `מתוך #${id}`);
  return json({ task: await fullTask(env.DB, newId) }, 201);
}

async function runNow(env, request, ctx, id) {
  const db = env.DB;
  const t = await getTask(db, id);
  if (!t) return fail('המשימה לא נמצאה', 404);
  const token = await claimTask(db, t, { now: Date.now(), advanceSchedule: false });
  if (!token) return fail('המשימה רצה כרגע. נסה שוב כשהריצה תסתיים', 409);
  await audit(env, request, 'task.run_now', id, t.name);
  const settings = await getSettings(db);
  const promise = executeTask(env, t, settings, { trigger: 'manual', lockToken: token });
  ctx.waitUntil(promise.catch(() => {}));
  const run = await promise;
  return json({ run });
}

async function unlockTask(env, request, id) {
  const db = env.DB;
  const now = Date.now();
  await db.batch([
    db
      .prepare(
        `UPDATE scheduler_runs SET status = 'failure', finished_at = ?, duration_ms = ? - started_at, error = 'הנעילה שוחררה ידנית'
         WHERE task_id = ? AND status = 'running'`
      )
      .bind(now, now, id),
    db.prepare('UPDATE scheduler_tasks SET running_since = NULL, lock_token = NULL WHERE id = ?').bind(id),
  ]);
  await audit(env, request, 'task.unlock', id);
  return json({ task: await fullTask(db, id) });
}

async function bulk(env, request) {
  const { ids = [], action } = await readJson(request);
  const list = ids.map(Number).filter(Number.isInteger).slice(0, 500);
  if (!list.length) return fail('לא נבחרו משימות');
  const results = [];
  for (const id of list) {
    let res;
    if (action === 'enable') res = await setEnabled(env, request, id, true);
    else if (action === 'disable') res = await setEnabled(env, request, id, false);
    else if (action === 'delete') res = await deleteTask(env, request, id);
    else return fail('פעולה לא מוכרת');
    results.push({ id, ok: res.ok, error: res.ok ? null : (await res.json()).error });
  }
  return json({ results });
}

async function previewRequest(env, request) {
  const body = await readJson(request);
  const { values, errors } = normalizeTask({ ...body, name: body.name || 'תצוגה מקדימה', enabled: 0 });
  delete errors.name;
  delete errors.run_dates;
  if (Object.keys(errors).length) return fail('יש שגיאות בטופס', 422, { fields: errors });
  const ctx = createContext(env, { task: { id: body.id || 0, name: values.name }, runId: 'preview' });
  ctx.maskSecrets = true;
  try {
    if (values.task_type === 'email') {
      const msg = buildEmail(values, ctx, await getSettings(env.DB));
      return json({ type: 'email', email: msg });
    }
    return json({ type: 'http', request: buildHttpRequest(values, ctx) });
  } catch (e) {
    return fail(e.message, 422);
  }
}

function cronPreview(url) {
  const expr = url.searchParams.get('expr') || '';
  try {
    const c = parseCron(expr);
    const runs = nextRuns(c, Date.now(), 5);
    if (!runs.length) return json({ ok: false, error: 'הביטוי לעולם לא יתקיים' });
    return json({ ok: true, normalized: c.source, description: describeCron(expr), next: runs.map((ms) => ({ ms, local: formatDateTime(ms) })) });
  } catch (e) {
    return json({ ok: false, error: e instanceof CronError ? e.message : String(e) });
  }
}

async function listRuns(env, url) {
  const where = [];
  const binds = [];
  const taskId = Number(url.searchParams.get('task_id'));
  if (taskId) {
    where.push('task_id = ?');
    binds.push(taskId);
  }
  const status = url.searchParams.get('status');
  if (['running', 'success', 'failure'].includes(status)) {
    where.push('status = ?');
    binds.push(status);
  }
  const trigger = url.searchParams.get('trigger');
  if (['schedule', 'manual'].includes(trigger)) {
    where.push('trigger = ?');
    binds.push(trigger);
  }
  const before = Number(url.searchParams.get('before_id'));
  if (before) {
    where.push('id < ?');
    binds.push(before);
  }
  const limit = clamp(url.searchParams.get('limit'), 1, 200, 50);
  const sql = `SELECT id, task_id, task_name, trigger, status, scheduled_for, started_at, finished_at, duration_ms, attempts,
      status_code, error, request_summary, substr(response_snippet, 1, 200) AS response_snippet, email_message_id
    FROM scheduler_runs ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`;
  const { results } = await env.DB.prepare(sql).bind(...binds, limit + 1).all();
  return json({ runs: results.slice(0, limit), has_more: results.length > limit });
}

async function getRun(env, id) {
  const run = await env.DB.prepare('SELECT * FROM scheduler_runs WHERE id = ?').bind(id).first();
  if (!run) return fail('הריצה לא נמצאה', 404);
  try {
    run.attempts_detail = JSON.parse(run.attempts_detail || '[]');
  } catch {
    run.attempts_detail = [];
  }
  let email = null;
  if (run.email_message_id) email = await env.DB.prepare('SELECT * FROM scheduler_emails WHERE message_id = ?').bind(run.email_message_id).first();
  const { results: actions } = await env.DB
    .prepare('SELECT action_name, action_type, status, detail, created_at FROM scheduler_action_log WHERE run_id = ? ORDER BY id')
    .bind(id)
    .all();
  return json({ run, email, actions });
}

async function listEmails(env, url) {
  const where = [];
  const binds = [];
  const status = url.searchParams.get('status');
  if (status) {
    where.push('status = ?');
    binds.push(status);
  }
  const source = url.searchParams.get('source');
  if (source) {
    where.push('source = ?');
    binds.push(source);
  }
  const taskId = Number(url.searchParams.get('task_id'));
  if (taskId) {
    where.push('task_id = ?');
    binds.push(taskId);
  }
  const q = url.searchParams.get('q');
  if (q) {
    where.push('(to_addr LIKE ? OR subject LIKE ?)');
    binds.push(`%${q}%`, `%${q}%`);
  }
  const before = Number(url.searchParams.get('before_id'));
  if (before) {
    where.push('id < ?');
    binds.push(before);
  }
  const limit = clamp(url.searchParams.get('limit'), 1, 200, 50);
  const { results } = await env.DB
    .prepare(`SELECT * FROM scheduler_emails ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`)
    .bind(...binds, limit + 1)
    .all();
  const stats = await env.DB.prepare('SELECT status, COUNT(*) AS n FROM scheduler_emails GROUP BY status').all();
  return json({
    emails: results.slice(0, limit),
    has_more: results.length > limit,
    stats: Object.fromEntries(stats.results.map((r) => [r.status, r.n])),
  });
}

async function getEmail(env, id) {
  const email = await env.DB.prepare('SELECT * FROM scheduler_emails WHERE id = ?').bind(id).first();
  if (!email) return fail('המייל לא נמצא', 404);
  const { results } = await env.DB
    .prepare('SELECT event_type, detail, occurred_at FROM scheduler_email_events WHERE message_id = ? ORDER BY occurred_at, id')
    .bind(email.message_id)
    .all();
  return json({ email, events: results });
}

async function sendManualEmail(env, request) {
  const body = await readJson(request);
  const settings = await getSettings(env.DB);
  const pseudo = {
    id: 0,
    name: 'שליחה ידנית',
    email_from: body.from,
    email_to: body.to,
    email_cc: body.cc,
    email_bcc: body.bcc,
    email_reply_to: body.reply_to,
    email_subject: body.subject,
    email_html: body.html,
    email_text: body.text,
  };
  let msg;
  try {
    msg = buildEmail(pseudo, createContext(env, { task: pseudo, runId: 'manual' }), settings);
  } catch (e) {
    return fail(e.message, 422);
  }
  msg.tags = [{ name: 'source', value: 'scheduler_manual' }];
  const r = await sendEmail(env, msg, { idempotencyKey: crypto.randomUUID() });
  if (!r.ok) return fail(`השליחה נכשלה: ${r.error}`, 502);
  const to = [...msg.to, ...msg.cc, ...msg.bcc];
  await recordEmail(env.DB, { messageId: r.id, source: 'manual', from: msg.from, to, subject: msg.subject });
  await audit(env, request, 'email.send', null, `${to.join(', ')} | ${msg.subject}`);
  return json({ ok: true, id: r.id });
}

async function settingsInfo(env, request, base = '') {
  const settings = await getSettings(env.DB);
  const origin = new URL(request.url).origin;
  return json({
    settings,
    secrets: listSecretNames(env),
    variables: TEMPLATE_VARIABLES,
    resend_configured: Boolean(env.RESEND_API_KEY),
    webhook_configured: Boolean(env.RESEND_WEBHOOK_SECRET),
    resend_webhook_url: `${origin}${base}/webhooks/resend`,
    timezone: 'Asia/Jerusalem',
  });
}

async function updateSettings(env, request, base = '') {
  const body = await readJson(request);
  const errors = {};
  const out = {};
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (!(key in body)) continue;
    out[key] = String(body[key] ?? '').trim();
  }
  if ('paused' in out) out.paused = out.paused === '1' || out.paused === 'true' ? '1' : '0';
  if ('notify_on_recovery' in out) out.notify_on_recovery = out.notify_on_recovery === '1' || out.notify_on_recovery === 'true' ? '1' : '0';
  if ('notify_mode' in out && !['every', 'first'].includes(out.notify_mode)) errors.notify_mode = 'ערך לא תקין';
  if (out.notify_webhook_url && !isUrlLike(out.notify_webhook_url)) errors.notify_webhook_url = 'כתובת לא תקינה';
  if (out.public_url && !isUrlLike(out.public_url)) errors.public_url = 'כתובת לא תקינה';
  const badMail = splitAddresses(out.notify_email || '').find((a) => !isValidAddress(a));
  if (badMail) errors.notify_email = `כתובת לא תקינה: ${badMail}`;
  if (out.default_from_email && !isValidAddress(out.default_from_email)) errors.default_from_email = 'כתובת לא תקינה';
  if ('retention_days' in out) out.retention_days = String(clamp(out.retention_days, 1, 365, 30));
  if ('max_tasks_per_tick' in out) out.max_tasks_per_tick = String(clamp(out.max_tasks_per_tick, 1, 100, 25));
  if ('lock_timeout_minutes' in out) out.lock_timeout_minutes = String(clamp(out.lock_timeout_minutes, 2, 60, 15));
  if (Object.keys(errors).length) return fail('יש שגיאות בהגדרות', 422, { fields: errors });
  await saveSettings(env.DB, out);
  await audit(env, request, 'settings.update', null, Object.keys(out).join(', '));
  return settingsInfo(env, request, base);
}

async function exportTasks(env, request) {
  const { results } = await env.DB.prepare('SELECT * FROM scheduler_tasks ORDER BY id').all();
  const { results: dateRows } = await env.DB
    .prepare('SELECT task_id, run_at FROM scheduler_task_dates WHERE ran_at IS NULL AND run_at > ? ORDER BY run_at')
    .bind(Date.now())
    .all();
  const datesByTask = new Map();
  for (const r of dateRows) datesByTask.set(r.task_id, [...(datesByTask.get(r.task_id) || []), formatLocalInput(r.run_at)]);
  const { results: ruleRows } = await env.DB.prepare('SELECT task_id, rules FROM scheduler_task_rules').all();
  const rulesByTask = new Map(ruleRows.map((r) => [r.task_id, parseStoredRules(r.rules)]));
  await audit(env, request, 'tasks.export', null, `${results.length} משימות`);
  return new Response(
    JSON.stringify(
      {
        format: 'cloudflare-scheduler',
        version: 1,
        exported_at: new Date().toISOString(),
        tasks: results.map((t) => ({
          ...Object.fromEntries(CONFIG_FIELDS.filter((f) => f !== 'run_at').map((f) => [f, t[f]])),
          run_dates_local: t.schedule_type === 'once' ? datesByTask.get(t.id) || [] : undefined,
          rules: rulesByTask.get(t.id),
        })),
      },
      null,
      2
    ),
    { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': 'attachment; filename="scheduler-tasks.json"' } }
  );
}

async function importTasks(env, request) {
  const body = await readJson(request);
  const tasks = Array.isArray(body) ? body : body.tasks;
  if (!Array.isArray(tasks)) return fail('קובץ לא תקין: חסר מערך tasks');
  const created = [];
  const failed = [];
  for (const [i, raw] of tasks.slice(0, 500).entries()) {
    // משימת תאריכים שחלק ממועדיה עברו מיובאת עם המועדים העתידיים בלבד, או מושבתת אם לא נשארו כאלה
    const input = { ...raw };
    let { values, errors } = normalizeTask(input);
    if (errors.run_dates?.includes('כבר עבר')) {
      const future = values.run_dates.filter((ms) => ms > Date.now()).map(formatLocalInput);
      ({ values, errors } = normalizeTask(future.length ? { ...input, run_dates_local: future } : { ...input, enabled: 0 }));
    }
    if (Object.keys(errors).length) failed.push({ index: i, name: raw?.name, errors });
    else created.push(await insertTask(env.DB, values));
  }
  await audit(env, request, 'tasks.import', null, `נוצרו ${created.length}, נכשלו ${failed.length}`);
  return json({ created: created.length, failed });
}

/**
 * "בדיקת כללים": מריץ את הכללים על תגובה לדוגמה, בלי לשלוח כלום.
 * מחזיר את התוצאה (הצלחה/כשל), ואילו פעולות היו רצות עם התוכן שהיה נשלח.
 */
async function testRules(env, request) {
  const body = await readJson(request);
  const { rules, errors } = normalizeRules(body.rules, { isUrlLike });
  if (Object.keys(errors).length) return fail('יש שגיאות בכללים', 422, { fields: errors });
  const sample = body.sample || {};
  const status = Number(sample.status) || 200;
  let headers = {};
  try {
    headers = JSON.parse(sample.headers || '{}');
  } catch {}
  const response = makeResponse({ status, body: String(sample.body ?? ''), headers });
  let error = null;
  if (!statusMatches(status, body.expect_status)) error = `קוד תגובה ${status} אינו בטווח המצופה (${body.expect_status || '200-299'})`;
  else if (body.expect_body && !response.body.includes(body.expect_body)) error = `גוף התגובה לא מכיל את הטקסט "${body.expect_body}"`;
  else error = contentError(rules, response);
  const outcome = error ? 'failure' : 'success';

  const settings = await getSettings(env.DB);
  const ctx = createContext(env, { task: { id: body.id || 0, name: body.name || '' }, runId: 'בדיקה' });
  ctx.maskSecrets = true;
  ctx.result = { outcome, response, error, attempts: 1, duration_ms: 0, run_url: settings.public_url ? `${settings.public_url}/#/runs/0` : '' };
  const actions = selectActions(rules, outcome, response).map(({ action, run, reason }) => {
    const item = { name: action.name, type: action.type, run, reason };
    if (!run) return item;
    try {
      if (action.type === 'email') {
        const e = action.email;
        item.preview = {
          to: render(e.to, ctx),
          cc: render(e.cc, ctx),
          subject: render(e.subject, ctx),
          html: render(e.html, ctx, { html: true }),
          text: render(e.text, ctx),
        };
      } else {
        item.preview = { method: action.webhook.method, url: render(action.webhook.url, ctx), body: render(action.webhook.body, ctx) };
      }
    } catch (err) {
      item.preview_error = err.message;
    }
    return item;
  });
  return json({ outcome, error, actions });
}

function rulesMeta() {
  return json({ sources: SOURCES, ops: OPS, when: WHEN, result_variables: RESULT_VARIABLES });
}

async function listAudit(env, url) {
  const before = Number(url.searchParams.get('before_id'));
  const { results } = await env.DB
    .prepare(`SELECT * FROM scheduler_audit ${before ? 'WHERE id < ?' : ''} ORDER BY id DESC LIMIT 101`)
    .bind(...(before ? [before] : []))
    .all();
  return json({ entries: results.slice(0, 100), has_more: results.length > 100 });
}

// ---------- ניתוב ----------

export async function handleApi(request, env, ctx, url, path, base = '') {
  const p = path.replace(/^\/api/, '');
  const m = request.method;
  let match;

  if (p === '/dashboard' && m === 'GET') return dashboard(env);
  if (p === '/tasks' && m === 'GET') return listTasks(env, url);
  if (p === '/tasks' && m === 'POST') return createTask(env, request);
  if (p === '/tasks/bulk' && m === 'POST') return bulk(env, request);
  if (p === '/tasks/preview' && m === 'POST') return previewRequest(env, request);
  if ((match = /^\/tasks\/(\d+)$/.exec(p))) {
    const id = Number(match[1]);
    if (m === 'GET') {
      const t = await fullTask(env.DB, id);
      return t ? json({ task: t }) : fail('המשימה לא נמצאה', 404);
    }
    if (m === 'PUT') return updateTask(env, request, id);
    if (m === 'DELETE') return deleteTask(env, request, id);
  }
  if ((match = /^\/tasks\/(\d+)\/(enable|disable|run|duplicate|unlock)$/.exec(p)) && m === 'POST') {
    const id = Number(match[1]);
    switch (match[2]) {
      case 'enable':
        return setEnabled(env, request, id, true);
      case 'disable':
        return setEnabled(env, request, id, false);
      case 'run':
        return runNow(env, request, ctx, id);
      case 'duplicate':
        return duplicateTask(env, request, id);
      case 'unlock':
        return unlockTask(env, request, id);
    }
  }
  if (p === '/cron/preview' && m === 'GET') return cronPreview(url);
  if (p === '/rules/test' && m === 'POST') return testRules(env, request);
  if (p === '/rules/meta' && m === 'GET') return rulesMeta();
  if (p === '/runs' && m === 'GET') return listRuns(env, url);
  if ((match = /^\/runs\/(\d+)$/.exec(p)) && m === 'GET') return getRun(env, Number(match[1]));
  if (p === '/emails' && m === 'GET') return listEmails(env, url);
  if (p === '/emails/send' && m === 'POST') return sendManualEmail(env, request);
  if ((match = /^\/emails\/(\d+)$/.exec(p)) && m === 'GET') return getEmail(env, Number(match[1]));
  if (p === '/settings' && m === 'GET') return settingsInfo(env, request, base);
  if (p === '/settings' && m === 'PUT') return updateSettings(env, request, base);
  if (p === '/export' && m === 'GET') return exportTasks(env, request);
  if (p === '/import' && m === 'POST') return importTasks(env, request);
  if (p === '/audit' && m === 'GET') return listAudit(env, url);
  return fail('לא נמצא', 404);
}

export { audit };
