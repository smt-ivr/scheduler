// הגדרות כלליות שנשמרות בטבלה scheduler_settings

export const DEFAULT_SETTINGS = {
  paused: '0', // השהיה כללית של כל הריצות המתוזמנות
  notify_webhook_url: '', // webhook ברירת מחדל להתראות כשל
  notify_email: '', // כתובת ברירת מחדל להתראות כשל
  notify_mode: 'every', // every = על כל כשל סופי, first = רק על הכשל הראשון ברצף
  notify_on_recovery: '1', // הודעה כשמשימה שנכשלה חוזרת לעבוד
  default_from_email: '', // כתובת השולח ב-Resend, למשל "מערכת <noreply@example.com>"
  retention_days: '30', // מחיקת יומן ריצות ומיילים ישנים
  max_tasks_per_tick: '25', // מספר המשימות המרבי שמתחילות באותה דקה
  lock_timeout_minutes: '15', // אחרי כמה זמן נעילה של ריצה נחשבת תקועה
  public_url: '', // כתובת הממשק, לקישורים בהתראות (מתעדכן אוטומטית בכניסה)
};

export async function getSettings(db) {
  const { results } = await db.prepare('SELECT key, value FROM scheduler_settings').all();
  const out = { ...DEFAULT_SETTINGS };
  for (const r of results) if (r.key in DEFAULT_SETTINGS) out[r.key] = r.value;
  return out;
}

export async function saveSettings(db, values) {
  const now = Date.now();
  const stmts = [];
  for (const [key, value] of Object.entries(values)) {
    if (!(key in DEFAULT_SETTINGS)) continue;
    stmts.push(
      db
        .prepare(
          `INSERT INTO scheduler_settings (key, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
        )
        .bind(key, String(value ?? ''), now)
    );
  }
  if (stmts.length) await db.batch(stmts);
}
