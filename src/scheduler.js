// לולאת התזמון: נקראת מה-Cron Trigger פעם בדקה.

import { nextRun } from './cron.js';
import { executeTask } from './executor.js';
import { getSettings } from './settings.js';

const CONCURRENCY = 5;

/** מועד הריצה הבא של משימה, או null */
export function computeNextRun(task, now = Date.now()) {
  if (!Number(task.enabled)) return null;
  if (task.schedule_type === 'once') return task.run_at ?? null;
  try {
    return nextRun(task.cron_expr, now);
  } catch {
    return null;
  }
}

async function pool(items, limit, fn) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      try {
        await fn(item);
      } catch (e) {
        console.error('task execution crashed', item?.id, e);
      }
    }
  });
  await Promise.all(workers);
}

/** משחרר נעילות של ריצות שנתקעו (למשל אם ה-Worker נקטע באמצע) */
async function releaseStaleLocks(db, settings, now) {
  const cutoff = now - Math.max(Number(settings.lock_timeout_minutes) || 15, 2) * 60_000;
  await db.batch([
    db
      .prepare(
        `UPDATE scheduler_runs SET status = 'failure', finished_at = ?, duration_ms = ? - started_at,
           error = 'הריצה נקטעה ולא הסתיימה בזמן (הנעילה שוחררה)'
         WHERE status = 'running' AND started_at < ?`
      )
      .bind(now, now, cutoff),
    db.prepare('UPDATE scheduler_tasks SET running_since = NULL, lock_token = NULL WHERE running_since IS NOT NULL AND running_since < ?').bind(cutoff),
  ]);
}

/**
 * נעילה אטומית של משימה: רק מי שהצליח לעדכן את השורה מריץ אותה.
 * בתזמון רגיל מקדמים גם את next_run_at כדי שהדקה הבאה לא תבחר אותה שוב.
 * במשימת תאריכים מדויקים, המועד הבא הוא התאריך הממתין הקרוב שעוד לא עבר.
 */
export async function claimTask(db, task, { now, advanceSchedule }) {
  const token = crypto.randomUUID();
  let res;
  if (advanceSchedule) {
    let next;
    if (task.schedule_type === 'once') {
      const row = await db
        .prepare('SELECT MIN(run_at) AS next FROM scheduler_task_dates WHERE task_id = ? AND ran_at IS NULL AND run_at > ?')
        .bind(task.id, now + 999)
        .first();
      next = row?.next ?? null;
    } else {
      next = computeNextRun(task, now);
    }
    res = await db
      .prepare(
        `UPDATE scheduler_tasks SET running_since = ?, lock_token = ?, next_run_at = ?,
           run_at = CASE WHEN schedule_type = 'once' THEN ? ELSE run_at END
         WHERE id = ? AND enabled = 1 AND running_since IS NULL AND next_run_at = ?`
      )
      .bind(now, token, next, next, task.id, task.next_run_at)
      .run();
    if (res.meta.changes === 1 && task.schedule_type === 'once') {
      // המועד הנוכחי (וכל מועד שהוחמץ לפניו) מסומן כמבוצע; ריצה אחת מכסה את כולם
      await db
        .prepare('UPDATE scheduler_task_dates SET ran_at = ? WHERE task_id = ? AND ran_at IS NULL AND run_at <= ?')
        .bind(now, task.id, now + 999)
        .run();
      task.has_more_dates = next != null;
    }
  } else {
    res = await db
      .prepare('UPDATE scheduler_tasks SET running_since = ?, lock_token = ? WHERE id = ? AND running_since IS NULL')
      .bind(now, token, task.id)
      .run();
  }
  return res.meta.changes === 1 ? token : null;
}

export async function tick(env, now = Date.now()) {
  const db = env.DB;
  const settings = await getSettings(db);
  await releaseStaleLocks(db, settings, now);

  if (new Date(now).getUTCMinutes() === 7) {
    await maintenance(db, settings, now).catch((e) => console.error('maintenance failed', e));
  }
  if (settings.paused === '1') return { paused: true, ran: 0 };

  const limit = Math.min(Math.max(Number(settings.max_tasks_per_tick) || 25, 1), 100);
  const { results: due } = await db
    .prepare(
      `SELECT * FROM scheduler_tasks
       WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? AND running_since IS NULL
       ORDER BY next_run_at LIMIT ?`
    )
    .bind(now + 999, limit)
    .all();

  const claimed = [];
  for (const task of due) {
    const token = await claimTask(db, task, { now, advanceSchedule: true });
    if (token) claimed.push({ task, token });
  }

  await pool(claimed, CONCURRENCY, ({ task, token }) =>
    executeTask(env, task, settings, { trigger: 'schedule', lockToken: token, scheduledFor: task.next_run_at })
  );
  return { paused: false, ran: claimed.length };
}

/** מחיקת רשומות ישנות. מתבצע פעם בשעה. */
export async function maintenance(db, settings, now = Date.now()) {
  const days = Math.max(Number(settings.retention_days) || 30, 1);
  const cutoff = now - days * 86_400_000;
  const del = (table, col, before) =>
    db.prepare(`DELETE FROM ${table} WHERE id IN (SELECT id FROM ${table} WHERE ${col} < ? LIMIT 5000)`).bind(before);
  await db.batch([
    del('scheduler_runs', 'started_at', cutoff),
    del('scheduler_emails', 'created_at', cutoff),
    del('scheduler_email_events', 'received_at', cutoff),
    del('scheduler_audit', 'at', now - 90 * 86_400_000),
    del('scheduler_login_attempts', 'at', now - 86_400_000),
  ]);
}
