-- Migration 0004: בנייה מחדש של המתזמן (גרסה 2).
-- מוחק את כל טבלאות המתזמן הקודמות ויוצר מבנה חדש ופשוט.
-- נוגע רק בטבלאות שמתחילות ב-scheduler_. הטבלה scheduler_migrations (המעקב של wrangler) נשארת.

DROP TABLE IF EXISTS scheduler_tasks;
DROP TABLE IF EXISTS scheduler_runs;
DROP TABLE IF EXISTS scheduler_emails;
DROP TABLE IF EXISTS scheduler_email_events;
DROP TABLE IF EXISTS scheduler_settings;
DROP TABLE IF EXISTS scheduler_audit;
DROP TABLE IF EXISTS scheduler_login_attempts;
DROP TABLE IF EXISTS scheduler_task_dates;
DROP TABLE IF EXISTS scheduler_task_rules;
DROP TABLE IF EXISTS scheduler_action_log;

-- כל משימה נשמרת כ-JSON אחד (config); שאר העמודות הן המצב בזמן ריצה
CREATE TABLE IF NOT EXISTS scheduler_tasks (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT    NOT NULL,
  enabled        INTEGER NOT NULL DEFAULT 1,
  config         TEXT    NOT NULL,
  next_run_at    INTEGER,
  last_run_at    INTEGER,
  last_status    TEXT,
  last_error     TEXT,
  running_since  INTEGER,
  lock_token     TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS scheduler_tasks_due_idx ON scheduler_tasks (enabled, next_run_at);

CREATE TABLE IF NOT EXISTS scheduler_runs (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id           INTEGER NOT NULL,
  task_name         TEXT    NOT NULL DEFAULT '',
  trigger           TEXT    NOT NULL DEFAULT 'schedule',
  status            TEXT    NOT NULL DEFAULT 'running',
  scheduled_for     INTEGER,
  started_at        INTEGER NOT NULL,
  finished_at       INTEGER,
  duration_ms       INTEGER,
  attempts          INTEGER NOT NULL DEFAULT 0,
  status_code       INTEGER,
  error             TEXT,
  request_summary   TEXT,
  response_snippet  TEXT,
  emails            TEXT    NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS scheduler_runs_task_idx    ON scheduler_runs (task_id, id);
CREATE INDEX IF NOT EXISTS scheduler_runs_started_idx ON scheduler_runs (started_at);

-- הגדרות מייל: resend_api_key, from_email, reply_to
CREATE TABLE IF NOT EXISTS scheduler_settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- הגנה מניחוש סיסמה
CREATE TABLE IF NOT EXISTS scheduler_login_attempts (
  id  INTEGER PRIMARY KEY AUTOINCREMENT,
  ip  TEXT    NOT NULL,
  at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS scheduler_login_attempts_ip_idx ON scheduler_login_attempts (ip, at);
