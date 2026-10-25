-- Migration 0002: רשימת תאריכים מדויקים למשימה.
-- משימה מסוג "תאריכים מדויקים" (schedule_type = 'once') רצה בכל אחד מהמועדים ברשימה,
-- ומושבתת אוטומטית אחרי המועד האחרון.
-- נוגע רק בטבלאות scheduler_.

CREATE TABLE IF NOT EXISTS scheduler_task_dates (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id  INTEGER NOT NULL,
  run_at   INTEGER NOT NULL,   -- המועד המתוכנן (UTC במילישניות)
  ran_at   INTEGER,            -- מתי רץ בפועל; NULL = עדיין ממתין
  UNIQUE (task_id, run_at)
);

CREATE INDEX IF NOT EXISTS scheduler_task_dates_pending_idx ON scheduler_task_dates (task_id, ran_at, run_at);

-- העברת משימות חד-פעמיות קיימות (אם יש) לטבלה החדשה
INSERT OR IGNORE INTO scheduler_task_dates (task_id, run_at, ran_at)
SELECT id, run_at, CASE WHEN enabled = 0 AND last_run_at IS NOT NULL THEN last_run_at END
FROM scheduler_tasks
WHERE schedule_type = 'once' AND run_at IS NOT NULL;
