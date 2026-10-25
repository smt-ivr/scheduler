// הגדרות מייל ושליחה דרך Resend

const KEYS = ['resend_api_key', 'from_email', 'reply_to'];

export async function getMailSettings(db) {
  const { results } = await db.prepare('SELECT key, value FROM scheduler_settings').all();
  const out = { resend_api_key: '', from_email: '', reply_to: '' };
  for (const r of results) if (KEYS.includes(r.key)) out[r.key] = r.value;
  return out;
}

export async function saveMailSettings(db, values) {
  const now = Date.now();
  const stmts = Object.entries(values)
    .filter(([k]) => KEYS.includes(k))
    .map(([k, v]) =>
      db
        .prepare('INSERT INTO scheduler_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
        .bind(k, String(v ?? ''), now)
    );
  if (stmts.length) await db.batch(stmts);
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** טקסט רגיל → HTML מימין לשמאל, עם שמירה על שורות */
export function textToHtml(text) {
  return `<div dir="rtl" style="font-family:Arial,sans-serif;font-size:15px;line-height:1.6;white-space:pre-wrap">${escapeHtml(text)}</div>`;
}

/**
 * שולח מייל. message: { to: [], cc: [], subject, text, html }
 * מחזיר { ok, id, error }
 */
export async function sendEmail(env, settings, message, idempotencyKey) {
  const key = settings.resend_api_key || env.RESEND_API_KEY;
  if (!key) return { ok: false, error: 'לא הוגדר מפתח Resend (בהגדרות המייל)' };
  if (!settings.from_email) return { ok: false, error: 'לא הוגדרה כתובת שולח (בהגדרות המייל)' };
  const payload = {
    from: settings.from_email,
    to: message.to,
    subject: message.subject,
    html: message.html,
    text: message.text,
  };
  if (message.cc?.length) payload.cc = message.cc;
  if (settings.reply_to) payload.reply_to = settings.reply_to;
  const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  try {
    const res = await fetch(`${env.RESEND_API_URL || 'https://api.resend.com'}/emails`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: data.message || `Resend החזיר ${res.status}` };
    return { ok: true, id: data.id };
  } catch (e) {
    return { ok: false, error: e.name === 'TimeoutError' ? 'Resend לא ענה בזמן' : e.message };
  }
}
