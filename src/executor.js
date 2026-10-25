// הרצת משימה בודדת: בניית הבקשה, ניסיונות חוזרים, שמירה ביומן והתראות.

import { createContext, render, redact, TemplateError } from './templates.js';
import { sendEmail, recordEmail, splitAddresses, isValidAddress } from './resend.js';
import { formatDateTime } from './time.js';

const SNIPPET_CHARS = 1000;
const BODY_CHECK_BYTES = 64 * 1024;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class ConfigError extends Error {}

/** "200-299,304" → האם הקוד מתאים */
export function statusMatches(code, expect) {
  const spec = String(expect || '200-299').trim() || '200-299';
  return spec.split(',').some((part) => {
    const [a, b] = part.trim().split('-').map((x) => Number(x.trim()));
    if (Number.isNaN(a)) return false;
    return b === undefined || Number.isNaN(b) ? code === a : code >= a && code <= b;
  });
}

async function readBody(res, limit = BODY_CHECK_BYTES) {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  while (size < limit) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
  }
  reader.cancel().catch(() => {});
  const all = new Uint8Array(Math.min(size, limit));
  let off = 0;
  for (const c of chunks) {
    const part = c.subarray(0, Math.min(c.byteLength, all.length - off));
    all.set(part, off);
    off += part.byteLength;
    if (off >= all.length) break;
  }
  return new TextDecoder().decode(all);
}

/** בונה בקשת HTTP מוכנה לשליחה (עם ערכי הסודות) */
export function buildHttpRequest(task, ctx) {
  const url = render(task.http_url, ctx);
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new ConfigError(`כתובת URL לא תקינה: ${redact(url, ctx)}`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new ConfigError('רק כתובות http/https נתמכות');

  let rawHeaders;
  try {
    rawHeaders = JSON.parse(task.http_headers || '{}');
  } catch {
    throw new ConfigError('הכותרות אינן JSON תקין');
  }
  if (!rawHeaders || typeof rawHeaders !== 'object' || Array.isArray(rawHeaders)) {
    throw new ConfigError('הכותרות צריכות להיות אובייקט JSON, למשל {"Authorization": "Bearer ..."}');
  }
  const headers = {};
  for (const [k, v] of Object.entries(rawHeaders)) headers[k] = render(String(v), ctx);

  const method = (task.http_method || 'GET').toUpperCase();
  let body = method === 'GET' ? '' : render(task.http_body || '', ctx);
  const lower = Object.fromEntries(Object.keys(headers).map((k) => [k.toLowerCase(), k]));
  if (body && !lower['content-type']) {
    try {
      JSON.parse(body);
      headers['Content-Type'] = 'application/json';
    } catch {
      headers['Content-Type'] = 'text/plain; charset=utf-8';
    }
  }
  if (!lower['user-agent']) headers['User-Agent'] = 'Cloudflare-Scheduler/1.0';
  return { url, method, headers, body };
}

/** בונה הודעת מייל מוכנה לשליחה */
export function buildEmail(task, ctx, settings) {
  const from = render(task.email_from || settings.default_from_email || '', ctx).trim();
  const list = (s) => splitAddresses(render(s || '', ctx));
  const msg = {
    from,
    to: list(task.email_to),
    cc: list(task.email_cc),
    bcc: list(task.email_bcc),
    reply_to: list(task.email_reply_to),
    subject: render(task.email_subject || '', ctx),
    html: render(task.email_html || '', ctx),
    text: render(task.email_text || '', ctx),
    tags: [
      { name: 'source', value: 'scheduler' },
      { name: 'task_id', value: String(task.id ?? 0) },
    ],
  };
  if (!msg.from) throw new ConfigError('חסרה כתובת שולח (במשימה או בהגדרות הכלליות)');
  if (!isValidAddress(msg.from)) throw new ConfigError(`כתובת שולח לא תקינה: ${msg.from}`);
  if (!msg.to.length) throw new ConfigError('חסר נמען');
  for (const a of [...msg.to, ...msg.cc, ...msg.bcc, ...msg.reply_to]) {
    if (!isValidAddress(a)) throw new ConfigError(`כתובת לא תקינה: ${a}`);
  }
  if (msg.to.length + msg.cc.length + msg.bcc.length > 50) throw new ConfigError('Resend מגביל ל-50 נמענים בהודעה');
  if (!msg.subject) throw new ConfigError('חסר נושא למייל');
  return msg;
}

function describeError(e, timeoutMs) {
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return `תם הזמן (${Math.round(timeoutMs / 1000)} שניות) ללא תגובה`;
  return e?.message || String(e);
}

async function attemptHttp(req, task, timeoutMs) {
  const res = await fetch(req.url, {
    method: req.method,
    headers: req.headers,
    body: req.body || undefined,
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await readBody(res);
  let error = null;
  if (!statusMatches(res.status, task.expect_status)) {
    error = `קוד תגובה ${res.status} אינו בטווח המצופה (${task.expect_status || '200-299'})`;
  } else if (task.expect_body && !text.includes(task.expect_body)) {
    error = `גוף התגובה לא מכיל את הטקסט "${task.expect_body}"`;
  }
  return { ok: !error, status: res.status, text, error };
}

/**
 * מריץ משימה שכבר ננעלה (lockToken). מחזיר את רשומת הריצה הסופית.
 * trigger: 'schedule' | 'manual'
 */
export async function executeTask(env, task, settings, { trigger, lockToken, scheduledFor = null }) {
  const db = env.DB;
  const startedAt = Date.now();
  const ins = await db
    .prepare(
      `INSERT INTO scheduler_runs (task_id, task_name, trigger, status, scheduled_for, started_at)
       VALUES (?, ?, ?, 'running', ?, ?)`
    )
    .bind(task.id, task.name, trigger, scheduledFor, startedAt)
    .run();
  const runId = ins.meta.last_row_id;

  const ctx = createContext(env, { now: startedAt, task, runId });
  const timeoutMs = Math.min(Math.max(Number(task.timeout_ms) || 30000, 1000), 120000);
  const maxAttempts = Math.min(Math.max(Number(task.max_attempts) || 1, 1), 5);
  const baseDelay = Math.min(Math.max(Number(task.retry_delay_ms) || 2000, 0), 60000);

  const attempts = [];
  let final = { ok: false, status: null, text: '', error: null };
  let requestSummary = '';
  let messageId = null;
  let emailMsg = null;

  try {
    let req = null;
    if (task.task_type === 'email') {
      emailMsg = buildEmail(task, ctx, settings);
      requestSummary = `מייל אל ${emailMsg.to.join(', ')} | נושא: ${emailMsg.subject}`;
    } else {
      req = buildHttpRequest(task, ctx);
      requestSummary = `${req.method} ${req.url}`;
    }

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const t0 = Date.now();
      let r;
      try {
        if (emailMsg) {
          const sent = await sendEmail(env, emailMsg, { idempotencyKey: `scheduler-run-${runId}`, timeoutMs });
          r = { ok: sent.ok, status: sent.status, text: sent.body || '', error: sent.ok ? null : sent.error };
          if (sent.ok) messageId = sent.id;
        } else {
          r = await attemptHttp(req, task, timeoutMs);
        }
      } catch (e) {
        r = { ok: false, status: null, text: '', error: describeError(e, timeoutMs) };
      }
      attempts.push({ attempt, at: t0, duration_ms: Date.now() - t0, status: r.status, error: r.error ? redact(r.error, ctx) : null });
      final = r;
      if (r.ok) break;
      if (attempt < maxAttempts) await sleep(baseDelay * 2 ** (attempt - 1));
    }
  } catch (e) {
    // שגיאת הגדרה (תבנית/URL/כתובת) - אין טעם לנסות שוב
    final = { ok: false, status: null, text: '', error: e instanceof ConfigError || e instanceof TemplateError ? e.message : describeError(e, timeoutMs) };
    attempts.push({ attempt: 1, at: Date.now(), duration_ms: 0, status: null, error: final.error });
  }

  const finishedAt = Date.now();
  const status = final.ok ? 'success' : 'failure';
  const error = final.error ? redact(final.error, ctx) : null;
  const snippet = redact((final.text || '').slice(0, SNIPPET_CHARS), ctx);

  const stmts = [
    db
      .prepare(
        `UPDATE scheduler_runs SET status = ?, finished_at = ?, duration_ms = ?, attempts = ?, status_code = ?,
           error = ?, request_summary = ?, response_snippet = ?, attempts_detail = ?, email_message_id = ?
         WHERE id = ?`
      )
      .bind(status, finishedAt, finishedAt - startedAt, attempts.length, final.status, error, redact(requestSummary, ctx), snippet, JSON.stringify(attempts), messageId, runId),
    db
      .prepare(
        `UPDATE scheduler_tasks SET
           last_run_at = ?, last_status = ?, last_status_code = ?, last_duration_ms = ?, last_error = ?,
           consecutive_failures = CASE WHEN ? = 'success' THEN 0 ELSE consecutive_failures + 1 END,
           total_runs = total_runs + 1,
           total_failures = total_failures + ?,
           enabled = CASE WHEN ? = 1 THEN 0 ELSE enabled END,
           running_since = NULL, lock_token = NULL
         WHERE id = ? AND lock_token = ?`
      )
      .bind(
        startedAt,
        status,
        final.status,
        finishedAt - startedAt,
        error,
        status,
        final.ok ? 0 : 1,
        trigger === 'schedule' && task.schedule_type === 'once' ? 1 : 0,
        task.id,
        lockToken
      ),
  ];
  await db.batch(stmts);

  if (messageId && emailMsg) {
    await recordEmail(db, {
      messageId,
      taskId: task.id,
      runId,
      source: 'task',
      from: emailMsg.from,
      to: [...emailMsg.to, ...emailMsg.cc, ...emailMsg.bcc],
      subject: emailMsg.subject,
    }).catch((e) => console.error('recordEmail failed', e));
  }

  const run = {
    id: runId,
    task_id: task.id,
    status,
    started_at: startedAt,
    finished_at: finishedAt,
    duration_ms: finishedAt - startedAt,
    attempts: attempts.length,
    status_code: final.status,
    error,
    response_snippet: snippet,
  };

  try {
    const prevFailures = Number(task.consecutive_failures) || 0;
    if (!final.ok && (settings.notify_mode !== 'first' || prevFailures === 0)) {
      await notify(env, settings, task, run, 'failed');
    } else if (final.ok && prevFailures > 0 && settings.notify_on_recovery === '1') {
      await notify(env, settings, task, run, 'recovered');
    }
  } catch (e) {
    console.error('notification failed', e);
  }
  return run;
}

// ---------- התראות ----------

const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export async function notify(env, settings, task, run, kind) {
  const webhook = task.notify_webhook_url || settings.notify_webhook_url;
  const email = task.notify_email || settings.notify_email;
  if (!webhook && !email) return;

  const failed = kind === 'failed';
  const title = failed ? `המשימה "${task.name}" נכשלה` : `המשימה "${task.name}" חזרה לפעול`;
  const link = settings.public_url ? `${settings.public_url.replace(/\/$/, '')}/#/runs/${run.id}` : '';
  const lines = [
    title,
    `זמן: ${formatDateTime(run.started_at)} (שעון ישראל)`,
    `ניסיונות: ${run.attempts}`,
    run.status_code != null ? `קוד תגובה: ${run.status_code}` : null,
    run.error ? `שגיאה: ${run.error}` : null,
    link ? `פרטים: ${link}` : null,
  ].filter(Boolean);
  const text = lines.join('\n');
  const jobs = [];

  if (webhook) {
    const payload = {
      event: failed ? 'task.failed' : 'task.recovered',
      text, // תואם ל-Slack
      content: text.slice(0, 1900), // תואם ל-Discord
      task: { id: task.id, name: task.name, type: task.task_type },
      run: {
        id: run.id,
        status: run.status,
        attempts: run.attempts,
        status_code: run.status_code,
        error: run.error,
        started_at: new Date(run.started_at).toISOString(),
        started_at_local: formatDateTime(run.started_at),
        duration_ms: run.duration_ms,
      },
      link: link || null,
    };
    jobs.push(
      fetch(webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'Cloudflare-Scheduler/1.0' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10000),
      }).catch((e) => console.error('webhook notify failed', e))
    );
  }

  if (email && settings.default_from_email && env.RESEND_API_KEY) {
    const to = splitAddresses(email);
    const html = `<div dir="rtl" style="font-family:Arial,sans-serif;font-size:15px;line-height:1.6">
      <h2 style="color:${failed ? '#b42318' : '#067647'};margin:0 0 12px">${escapeHtml(title)}</h2>
      ${lines
        .slice(1)
        .map((l) => `<div>${escapeHtml(l)}</div>`)
        .join('')}
      ${run.response_snippet && failed ? `<pre dir="ltr" style="background:#f4f4f5;padding:10px;border-radius:6px;white-space:pre-wrap;font-size:12px">${escapeHtml(run.response_snippet.slice(0, 500))}</pre>` : ''}
    </div>`;
    jobs.push(
      (async () => {
        const subject = `[מתזמן] ${title}`;
        const r = await sendEmail(env, { from: settings.default_from_email, to, subject, html, text, tags: [{ name: 'source', value: 'scheduler_notification' }] });
        if (r.ok && r.id) {
          await recordEmail(env.DB, { messageId: r.id, taskId: task.id, runId: run.id, source: 'notification', from: settings.default_from_email, to, subject });
        } else if (!r.ok) {
          console.error('email notify failed', r.error);
        }
      })().catch((e) => console.error('email notify failed', e))
    );
  }
  await Promise.all(jobs);
}
