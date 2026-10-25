-- Migration 0001: טבלאות המתזמן.
-- כל הטבלאות והאינדקסים מתחילים ב-scheduler_ ונוצרים רק אם אינם קיימים.
-- הקובץ לא נוגע באף טבלה אחרת במסד.
-- זמנים נשמרים כמילישניות UTC (INTEGER); התצוגה וחישובי ה-cron הם לפי Asia/Jerusalem.

CREATE TABLE IF NOT EXISTS scheduler_tasks (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  name                 TEXT    NOT NULL,
  description          TEXT    NOT NULL DEFAULT '',
  tags                 TEXT    NOT NULL DEFAULT '',
  task_type            TEXT    NOT NULL DEFAULT 'http' CHECK (task_type IN ('http', 'email')),
  schedule_type        TEXT    NOT NULL CHECK (schedule_type IN ('cron', 'once')),
  cron_expr            TEXT,
  run_at               INTEGER,
  -- משימת HTTP
  http_url             TEXT,
  http_method          TEXT    NOT NULL DEFAULT 'GET' CHECK (http_method IN ('GET', 'POST', 'PUT', 'PATCH', 'DELETE')),
  http_headers         TEXT    NOT NULL DEFAULT '{}',
  http_body            TEXT    NOT NULL DEFAULT '',
  expect_status        TEXT    NOT NULL DEFAULT '200-299',
  expect_body          TEXT    NOT NULL DEFAULT '',
  -- משימת מייל (Resend)
  email_from           TEXT    NOT NULL DEFAULT '',
  email_to             TEXT    NOT NULL DEFAULT '',
  email_cc             TEXT    NOT NULL DEFAULT '',
  email_bcc            TEXT    NOT NULL DEFAULT '',
  email_reply_to       TEXT    NOT NULL DEFAULT '',
  email_subject        TEXT    NOT NULL DEFAULT '',
  email_html           TEXT    NOT NULL DEFAULT '',
  email_text           TEXT    NOT NULL DEFAULT '',
  -- הרצה
  enabled              INTEGER NOT NULL DEFAULT 1,
  timeout_ms           INTEGER NOT NULL DEFAULT 30000,
  max_attempts         INTEGER NOT NULL DEFAULT 3,
  retry_delay_ms       INTEGER NOT NULL DEFAULT 2000,
  notify_webhook_url   TEXT    NOT NULL DEFAULT '',
  notify_email         TEXT    NOT NULL DEFAULT '',
  -- מצב
  last_run_at          INTEGER,
  last_status          TEXT,
  last_status_code     INTEGER,
  last_duration_ms     INTEGER,
  last_error           TEXT,
  next_run_at          INTEGER,
  running_since        INTEGER,
  lock_token           TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  total_runs           INTEGER NOT NULL DEFAULT 0,
  total_failures       INTEGER NOT NULL DEFAULT 0,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS scheduler_tasks_due_idx ON scheduler_tasks (enabled, next_run_at);

CREATE TABLE IF NOT EXISTS scheduler_runs (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id           INTEGER NOT NULL,
  task_name         TEXT    NOT NULL DEFAULT '',
  trigger           TEXT    NOT NULL DEFAULT 'schedule' CHECK (trigger IN ('schedule', 'manual')),
  status            TEXT    NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'success', 'failure')),
  scheduled_for     INTEGER,
  started_at        INTEGER NOT NULL,
  finished_at       INTEGER,
  duration_ms       INTEGER,
  attempts          INTEGER NOT NULL DEFAULT 0,
  status_code       INTEGER,
  error             TEXT,
  request_summary   TEXT,
  response_snippet  TEXT,
  attempts_detail   TEXT    NOT NULL DEFAULT '[]',
  email_message_id  TEXT
);

CREATE INDEX IF NOT EXISTS scheduler_runs_task_idx    ON scheduler_runs (task_id, id);
CREATE INDEX IF NOT EXISTS scheduler_runs_started_idx ON scheduler_runs (started_at);
CREATE INDEX IF NOT EXISTS scheduler_runs_status_idx  ON scheduler_runs (status, id);

-- כל מייל שנשלח (ממשימה, מבדיקה ידנית או מהתראה) ומצב המסירה שלו
CREATE TABLE IF NOT EXISTS scheduler_emails (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id       TEXT    UNIQUE,
  task_id          INTEGER,
  run_id           INTEGER,
  source           TEXT    NOT NULL DEFAULT 'task' CHECK (source IN ('task', 'manual', 'notification')),
  from_addr        TEXT    NOT NULL DEFAULT '',
  to_addr          TEXT    NOT NULL DEFAULT '',
  subject          TEXT    NOT NULL DEFAULT '',
  status           TEXT    NOT NULL DEFAULT 'sent',
  error            TEXT,
  open_count       INTEGER NOT NULL DEFAULT 0,
  click_count      INTEGER NOT NULL DEFAULT 0,
  delivered_at     INTEGER,
  first_opened_at  INTEGER,
  last_event_at    INTEGER,
  created_at       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS scheduler_emails_created_idx ON scheduler_emails (created_at);
CREATE INDEX IF NOT EXISTS scheduler_emails_task_idx    ON scheduler_emails (task_id, id);
CREATE INDEX IF NOT EXISTS scheduler_emails_status_idx  ON scheduler_emails (status, id);

-- אירועים שמגיעים מה-webhook של Resend (נמסר, נפתח, נלחץ, חזר...)
CREATE TABLE IF NOT EXISTS scheduler_email_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  svix_id      TEXT    UNIQUE,
  message_id   TEXT    NOT NULL,
  event_type   TEXT    NOT NULL,
  detail       TEXT,
  occurred_at  INTEGER NOT NULL,
  received_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS scheduler_email_events_msg_idx      ON scheduler_email_events (message_id, occurred_at);
CREATE INDEX IF NOT EXISTS scheduler_email_events_received_idx ON scheduler_email_events (received_at);

CREATE TABLE IF NOT EXISTS scheduler_settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- יומן פעולות ניהול
CREATE TABLE IF NOT EXISTS scheduler_audit (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  at       INTEGER NOT NULL,
  action   TEXT    NOT NULL,
  task_id  INTEGER,
  ip       TEXT,
  details  TEXT
);

CREATE INDEX IF NOT EXISTS scheduler_audit_at_idx ON scheduler_audit (at);

-- הגנה מניחוש סיסמה
CREATE TABLE IF NOT EXISTS scheduler_login_attempts (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  ip   TEXT    NOT NULL,
  at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS scheduler_login_attempts_ip_idx ON scheduler_login_attempts (ip, at);
