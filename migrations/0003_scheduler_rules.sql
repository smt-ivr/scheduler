-- Migration 0003: כללי תגובה ופעולות מותנות.
-- נוגע רק בטבלאות scheduler_.

-- הכללים של כל משימה, כ-JSON: מילים שמעידות על שגיאה, תנאי שגיאה ורשימת פעולות
CREATE TABLE IF NOT EXISTS scheduler_task_rules (
  task_id     INTEGER PRIMARY KEY,
  rules       TEXT    NOT NULL DEFAULT '{}',
  updated_at  INTEGER NOT NULL
);

-- יומן הפעולות שבוצעו בכל ריצה (מייל שנשלח, webhook שנקרא)
CREATE TABLE IF NOT EXISTS scheduler_action_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id       INTEGER NOT NULL,
  task_id      INTEGER NOT NULL,
  action_name  TEXT    NOT NULL DEFAULT '',
  action_type  TEXT    NOT NULL,
  status       TEXT    NOT NULL,
  detail       TEXT,
  created_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS scheduler_action_log_run_idx     ON scheduler_action_log (run_id);
CREATE INDEX IF NOT EXISTS scheduler_action_log_created_idx ON scheduler_action_log (created_at);
