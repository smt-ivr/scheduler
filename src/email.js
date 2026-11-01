// הגדרות מייל ושליחה דרך Resend

const KEYS = ['resend_api_key', 'from_email', 'reply_to', 'brand_name'];

export async function getMailSettings(db) {
  const { results } = await db.prepare('SELECT key, value FROM scheduler_settings').all();
  const out = { resend_api_key: '', from_email: '', reply_to: '', brand_name: '' };
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

/**
 * טקסט רגיל → HTML: שורה ריקה = פסקה חדשה, שורות שמתחילות ב-• או - = רשימה,
 * ושורה שאחריה מגיעה רשימה = כותרת מודגשת לרשימה.
 */
export function textToBlocks(text) {
  return String(text ?? '')
    .split(/\n\s*\n/)
    .map((block) => {
      const lines = block.split('\n').filter((l) => l.trim());
      if (!lines.length) return '';
      if (lines.every((l) => /^\s*[•\-*]\s+/.test(l))) {
        return `<ul style="margin:0 0 16px;padding:0 20px 0 0">${lines.map((l) => `<li style="margin:0 0 6px">${escapeHtml(l.replace(/^\s*[•\-*]\s+/, ''))}</li>`).join('')}</ul>`;
      }
      // כותרת קטנה ואחריה רשימה ("מה כדאי לעשות:" + שורות •)
      if (lines.length > 1 && lines.slice(1).every((l) => /^\s*[•\-*]\s+/.test(l))) {
        return `<p style="margin:0 0 8px;font-weight:bold">${escapeHtml(lines[0])}</p><ul style="margin:0 0 16px;padding:0 20px 0 0">${lines
          .slice(1)
          .map((l) => `<li style="margin:0 0 6px">${escapeHtml(l.replace(/^\s*[•\-*]\s+/, ''))}</li>`)
          .join('')}</ul>`;
      }
      return `<p style="margin:0 0 16px">${lines.map(escapeHtml).join('<br>')}</p>`;
    })
    .join('');
}

/** תאימות לאחור: טקסט פשוט בתבנית המעוצבת, בלי כותרת מצב */
export function textToHtml(text) {
  return designedEmail({ title: '', bodyHtml: textToBlocks(text) });
}

const THEMES = {
  success: { color: '#0f7b4b', soft: '#e8f6ef', label: 'בוצע בהצלחה', icon: '&#10003;' },
  failure: { color: '#b42318', soft: '#fdecea', label: 'לא הצליח', icon: '&#10005;' },
  info: { color: '#2456d3', soft: '#e9effc', label: 'עדכון', icon: 'i' },
};

/**
 * מייל מעוצב, תואם לתוכנות מייל (טבלאות ו-CSS בתוך השורות), מימין לשמאל.
 * outcome: success | failure | info. details: שורות "תווית: ערך" לתיבת הפרטים.
 */
export function designedEmail({ title, bodyHtml, outcome = 'info', details = [], brand = '' }) {
  const t = THEMES[outcome] || THEMES.info;
  const brandName = escapeHtml(brand || 'מתזמן המשימות');
  const detailRows = details
    .filter(([, v]) => v)
    .map(([k, v]) => `<tr><td style="padding:4px 0;color:#667085;width:90px;vertical-align:top">${escapeHtml(k)}</td><td style="padding:4px 0;color:#1d2939">${escapeHtml(v)}</td></tr>`)
    .join('');
  return `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title></head>
<body style="margin:0;padding:0;background:#f2f4f7">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f2f4f7;padding:24px 12px"><tr><td align="center">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" dir="rtl" style="max-width:600px;background:#ffffff;border-radius:14px;overflow:hidden;font-family:Arial,Helvetica,sans-serif;text-align:right;border:1px solid #e4e7ec">
    <tr><td style="height:6px;background:${t.color};font-size:0;line-height:0">&nbsp;</td></tr>
    <tr><td style="padding:28px 32px 8px">
      ${title ? `<table role="presentation" cellpadding="0" cellspacing="0"><tr>
        <td style="background:${t.soft};color:${t.color};border-radius:999px;padding:5px 14px;font-size:13px;font-weight:bold">${t.icon}&nbsp; ${t.label}</td></tr></table>
      <h1 style="margin:16px 0 0;font-size:22px;line-height:1.4;color:#101828">${escapeHtml(title)}</h1>` : ''}
    </td></tr>
    <tr><td style="padding:16px 32px 8px;font-size:16px;line-height:1.7;color:#344054">${bodyHtml}</td></tr>
    ${detailRows ? `<tr><td style="padding:0 32px 24px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;border-radius:10px;padding:14px 18px;font-size:14px">${detailRows}</table></td></tr>` : ''}
    <tr><td style="padding:16px 32px;border-top:1px solid #eaecf0;font-size:12px;color:#98a2b3">נשלח אוטומטית על ידי ${brandName}</td></tr>
  </table>
</td></tr></table>
</body></html>`;
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
