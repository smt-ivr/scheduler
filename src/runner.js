// הרצת משימות: לולאת ה-Cron, נעילה נגד ריצה כפולה, ביצוע הבקשה, ומיילים לפי הכללים.

import { normalizeTask, makeResponse, evaluateResponse, matchingRules } from './task.js';
import { nextRun } from './schedule.js';
import { render } from './template.js';
import { getMailSettings, sendEmail, textToHtml } from './email.js';

const STALE_MS = 15 * 60_000; // ריצה שלא הסתיימה תוך 15 דקות נחשבת תקועה
const RETENTION_MS = 30 * 86_400_000;
const MAX_BODY = 64 * 1024;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function parseConfig(row) {
  try {
    return normalizeTask(JSON.parse(row.config)).config;
  } catch {
    return null;
  }
}

async function readBody(res) {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  while (size < MAX_BODY) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
  }
  reader.cancel().catch(() => {});
  const all = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) {
    all.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(all.subarray(0, MAX_BODY));
}

/**
 * גוף בקשה: אם הוא JSON, המשתנים מוחלפים בתוך כל ערך בנפרד, כך שגרשיים או שורה חדשה
 * בערך (למשל בשם המשימה) לא שוברים את ה-JSON. אחרת - החלפה רגילה.
 */
export function renderBody(body, ctx) {
  if (!body) return body;
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return render(body, ctx);
  }
  const walk = (v) => (typeof v === 'string' ? render(v, ctx) : Array.isArray(v) ? v.map(walk) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)])) : v);
  return JSON.stringify(walk(parsed));
}

/** מבצע את הבקשה עם ניסיונות חוזרים. לא נוגע במסד. */
export async function performRequest(cfg, ctx, { retries = cfg.request.retries } = {}) {
  const r = cfg.request;
  const url = render(r.url, ctx);
  const headers = {};
  for (const [k, v] of Object.entries(r.headers)) headers[k] = render(v, ctx);
  const body = r.method === 'GET' ? undefined : renderBody(r.body, ctx) || undefined;
  if (body && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
    try {
      JSON.parse(body);
      headers['Content-Type'] = 'application/json';
    } catch {
      headers['Content-Type'] = 'text/plain; charset=utf-8';
    }
  }
  let summary = `${r.method} ${url}`;
  try {
    const u = new URL(url);
    summary = `${r.method} ${u.origin}${u.pathname}`; // בלי פרמטרים, שעלולים להכיל מפתחות
  } catch {}

  let resp = makeResponse({ status: null, body: '' });
  let result = { ok: false, error: null };
  let attempts = 0;
  for (let i = 0; i <= retries; i++) {
    attempts++;
    try {
      const res = await fetch(url, { method: r.method, headers, body, redirect: 'follow', signal: AbortSignal.timeout(r.timeout_seconds * 1000) });
      resp = makeResponse({ status: res.status, body: await readBody(res), headers: Object.fromEntries(res.headers) });
      const ev = evaluateResponse(cfg.success, resp);
      result = ev;
      if (ev.ok || !ev.retry) break;
    } catch (e) {
      resp = makeResponse({ status: null, body: '' });
      result = {
        ok: false,
        error: e.name === 'TimeoutError' ? `אין תגובה אחרי ${r.timeout_seconds} שניות` : `הבקשה נכשלה: ${e.message}`,
      };
    }
    if (i < retries) await sleep(2000 * 2 ** i);
  }
  return { resp, outcome: result.ok ? 'success' : 'failure', error: result.error, attempts, summary };
}

/** המיילים שצריך לשלוח לפי הכללים, עם התוכן הסופי */
export function planEmails(cfg, ctx) {
  return matchingRules(cfg.rules, ctx.outcome, ctx.resp).map((rule) => {
    const addrs = (arr) => arr.flatMap((a) => render(a, ctx).split(/[,;]/)).map((a) => a.trim()).filter(Boolean);
    const subject = render(rule.email.subject, ctx);
    const text = render(rule.email.body, ctx);
    return {
      rule: rule.name,
      to: addrs(rule.email.to),
      cc: addrs(rule.email.cc),
      subject,
      text: rule.email.html ? undefined : text,
      html: rule.email.html ? render(rule.email.body, ctx, { html: true }) : textToHtml(text),
    };
  });
}

/**
 * מריץ משימה שכבר ננעלה ושומר את הריצה.
 * trigger: 'schedule' | 'manual'. lastRun: זו הריצה האחרונה (אחריה המשימה תושבת).
 */
export async function executeTask(env, row, cfg, { trigger, token, scheduledFor = null, lastRun = false }) {
  const db = env.DB;
  const startedAt = Date.now();
  const ins = await db
    .prepare("INSERT INTO scheduler_runs (task_id, task_name, trigger, status, scheduled_for, started_at) VALUES (?, ?, ?, 'running', ?, ?)")
    .bind(row.id, cfg.name, trigger, scheduledFor, startedAt)
    .run();
  const runId = ins.meta.last_row_id;
  const ctx = { env, now: startedAt, task: { id: row.id, name: cfg.name }, runId };

  let res;
  try {
    res = await performRequest(cfg, ctx);
  } catch (e) {
    res = { resp: makeResponse(), outcome: 'failure', error: e.message, attempts: 1, summary: '' };
  }
  Object.assign(ctx, { resp: res.resp, outcome: res.outcome, error: res.error });

  const emails = [];
  const planned = planEmails(cfg, ctx);
  if (planned.length) {
    const settings = await getMailSettings(db);
    for (const [i, m] of planned.entries()) {
      const sent = await sendEmail(env, settings, m, `scheduler-run-${runId}-${i}`);
      emails.push({ rule: m.rule, to: m.to, cc: m.cc, subject: m.subject, ok: sent.ok, error: sent.error || null });
    }
  }

  const finishedAt = Date.now();
  await db.batch([
    db
      .prepare(
        `UPDATE scheduler_runs SET status = ?, finished_at = ?, duration_ms = ?, attempts = ?, status_code = ?, error = ?,
           request_summary = ?, response_snippet = ?, emails = ? WHERE id = ?`
      )
      .bind(res.outcome, finishedAt, finishedAt - startedAt, res.attempts, res.resp.status, res.error, res.summary, res.resp.body.slice(0, 2000), JSON.stringify(emails), runId),
    db
      .prepare(
        `UPDATE scheduler_tasks SET last_run_at = ?, last_status = ?, last_error = ?, running_since = NULL, lock_token = NULL,
           enabled = CASE WHEN ? = 1 THEN 0 ELSE enabled END
         WHERE id = ? AND lock_token = ?`
      )
      .bind(startedAt, res.outcome, res.error, lastRun && trigger === 'schedule' ? 1 : 0, row.id, token),
  ]);
  return { id: runId, status: res.outcome, status_code: res.resp.status, error: res.error, duration_ms: finishedAt - startedAt, emails };
}

/**
 * נעילה אטומית: רק מי שעדכן את השורה מריץ. בריצה מתוזמנת מקדמים מיד את next_run_at,
 * כך שגם אם ה-Cron רץ פעמיים באותה דקה, המשימה לא תרוץ פעמיים.
 */
export async function claimTask(db, row, cfg, { now, scheduled }) {
  const token = crypto.randomUUID();
  if (scheduled) {
    const next = nextRun(cfg.schedule, now);
    const r = await db
      .prepare(
        `UPDATE scheduler_tasks SET running_since = ?, lock_token = ?, next_run_at = ?
         WHERE id = ? AND enabled = 1 AND next_run_at = ? AND (running_since IS NULL OR running_since < ?)`
      )
      .bind(now, token, next, row.id, row.next_run_at, now - STALE_MS)
      .run();
    return r.meta.changes === 1 ? { token, lastRun: next == null } : null;
  }
  const r = await db
    .prepare('UPDATE scheduler_tasks SET running_since = ?, lock_token = ? WHERE id = ? AND (running_since IS NULL OR running_since < ?)')
    .bind(now, token, row.id, now - STALE_MS)
    .run();
  return r.meta.changes === 1 ? { token, lastRun: false } : null;
}

export async function tick(env, now = Date.now()) {
  const db = env.DB;
  await db
    .prepare("UPDATE scheduler_runs SET status = 'failure', finished_at = ?, error = 'הריצה נקטעה ולא הסתיימה' WHERE status = 'running' AND started_at < ?")
    .bind(now, now - STALE_MS)
    .run();

  const { results: due } = await db
    .prepare(
      `SELECT * FROM scheduler_tasks
       WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? AND (running_since IS NULL OR running_since < ?)
       ORDER BY next_run_at LIMIT 25`
    )
    .bind(now + 999, now - STALE_MS)
    .all();

  const jobs = [];
  for (const row of due) {
    const cfg = parseConfig(row);
    if (!cfg) continue;
    const claim = await claimTask(db, row, cfg, { now, scheduled: true });
    if (claim) jobs.push({ row, cfg, claim });
  }

  // עד 5 משימות במקביל
  const queue = [...jobs];
  await Promise.all(
    Array.from({ length: Math.min(5, queue.length) }, async () => {
      while (queue.length) {
        const { row, cfg, claim } = queue.shift();
        await executeTask(env, row, cfg, { trigger: 'schedule', token: claim.token, scheduledFor: row.next_run_at, lastRun: claim.lastRun }).catch((e) =>
          console.error('task failed', row.id, e)
        );
      }
    })
  );

  // ניקוי פעם בשעה
  if (new Date(now).getUTCMinutes() === 7) {
    await db.batch([
      db.prepare('DELETE FROM scheduler_runs WHERE id IN (SELECT id FROM scheduler_runs WHERE started_at < ? LIMIT 5000)').bind(now - RETENTION_MS),
      db.prepare('DELETE FROM scheduler_login_attempts WHERE at < ?').bind(now - 86_400_000),
    ]);
  }
  return jobs.length;
}
