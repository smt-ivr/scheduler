// שליחת מיילים דרך Resend ומעקב אחרי מצב המסירה דרך ה-webhook שלהם.

const STATUS_FOR_EVENT = {
  'email.sent': 'sent',
  'email.delivery_delayed': 'delayed',
  'email.delivered': 'delivered',
  'email.opened': 'opened',
  'email.clicked': 'clicked',
  'email.bounced': 'bounced',
  'email.complained': 'complained',
  'email.failed': 'failed',
};

// מצב "גבוה" לא נדרס על ידי אירוע מאוחר של מצב "נמוך" (אירועים יכולים להגיע שלא לפי הסדר)
const STATUS_RANK = { sent: 1, delayed: 2, delivered: 3, opened: 4, clicked: 5, bounced: 10, complained: 10, failed: 10 };

export const splitAddresses = (s) =>
  String(s || '')
    .split(/[,;\n]/)
    .map((x) => x.trim())
    .filter(Boolean);

const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
/** תומך גם ב-"שם <a@b.com>" */
export function isValidAddress(addr) {
  const m = /<([^>]+)>\s*$/.exec(addr);
  return EMAIL_RE.test(m ? m[1].trim() : addr.trim());
}

/**
 * שולח מייל. מחזיר { ok, status, id, error, body }.
 * idempotencyKey מבטיח שניסיון חוזר אחרי timeout לא ישלח את המייל פעמיים.
 */
export async function sendEmail(env, message, { idempotencyKey, timeoutMs = 30000 } = {}) {
  if (!env.RESEND_API_KEY) return { ok: false, status: 0, error: 'RESEND_API_KEY לא מוגדר ב-Worker' };
  const base = env.RESEND_API_URL || 'https://api.resend.com';
  const headers = {
    Authorization: `Bearer ${env.RESEND_API_KEY}`,
    'Content-Type': 'application/json',
  };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const payload = { from: message.from, to: message.to, subject: message.subject };
  if (message.cc?.length) payload.cc = message.cc;
  if (message.bcc?.length) payload.bcc = message.bcc;
  if (message.reply_to?.length) payload.reply_to = message.reply_to;
  if (message.html) payload.html = message.html;
  if (message.text) payload.text = message.text;
  if (!payload.html && !payload.text) payload.text = ' ';
  if (message.tags?.length) payload.tags = message.tags;

  const res = await fetch(`${base}/emails`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await res.text();
  let json = null;
  try {
    json = JSON.parse(body);
  } catch {}
  if (!res.ok) {
    return { ok: false, status: res.status, error: json?.message || `Resend החזיר ${res.status}`, body };
  }
  return { ok: true, status: res.status, id: json?.id || null, body };
}

/** שומר רשומת מייל שנשלח למעקב */
export async function recordEmail(db, { messageId, taskId = null, runId = null, source, from, to, subject, status = 'sent', error = null }) {
  await db
    .prepare(
      `INSERT INTO scheduler_emails (message_id, task_id, run_id, source, from_addr, to_addr, subject, status, error, created_at, last_event_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(messageId, taskId, runId, source, from, [].concat(to).join(', '), subject, status, error, Date.now(), Date.now())
    .run();
}

// ---------- webhook ----------

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(bytes) {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s);
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** אימות חתימת svix (המנגנון ש-Resend משתמש בו) */
export async function verifyWebhook(secret, headers, rawBody) {
  const id = headers.get('svix-id');
  const ts = headers.get('svix-timestamp');
  const sigHeader = headers.get('svix-signature');
  if (!id || !ts || !sigHeader) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    b64ToBytes(secret.replace(/^whsec_/, '')),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = bytesToB64(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${ts}.${rawBody}`)));
  return sigHeader.split(' ').some((part) => {
    const [version, value] = part.split(',');
    return version === 'v1' && value && timingSafeEqual(value, sig);
  });
}

export async function handleResendWebhook(request, env) {
  if (!env.RESEND_WEBHOOK_SECRET) return new Response('webhook secret not configured', { status: 503 });
  const raw = await request.text();
  if (!(await verifyWebhook(env.RESEND_WEBHOOK_SECRET, request.headers, raw))) {
    return new Response('invalid signature', { status: 401 });
  }
  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    return new Response('bad json', { status: 400 });
  }
  const messageId = event?.data?.email_id;
  const newStatus = STATUS_FOR_EVENT[event?.type];
  if (!messageId || !newStatus) return new Response('ignored');

  const db = env.DB;
  // ה-webhook של Resend הוא לכל החשבון; מתעלמים ממיילים שלא נשלחו מהמתזמן
  const email = await db.prepare('SELECT id, status FROM scheduler_emails WHERE message_id = ?').bind(messageId).first();
  if (!email) return new Response('unknown email');

  const occurred = Date.parse(event.created_at) || Date.now();
  const detail = event.data.click?.link || event.data.bounce?.message || event.data.failed?.reason || null;
  const ins = await db
    .prepare(
      `INSERT OR IGNORE INTO scheduler_email_events (svix_id, message_id, event_type, detail, occurred_at, received_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(request.headers.get('svix-id'), messageId, event.type, detail, occurred, Date.now())
    .run();
  if (!ins.meta.changes) return new Response('duplicate');

  const rankOld = STATUS_RANK[email.status] || 0;
  const status = STATUS_RANK[newStatus] >= rankOld ? newStatus : email.status;
  await db
    .prepare(
      `UPDATE scheduler_emails SET
         status = ?,
         error = CASE WHEN ? IN ('bounced', 'complained', 'failed') THEN ? ELSE error END,
         open_count = open_count + ?,
         click_count = click_count + ?,
         delivered_at = CASE WHEN ? = 'delivered' AND delivered_at IS NULL THEN ? ELSE delivered_at END,
         first_opened_at = CASE WHEN ? = 'opened' AND first_opened_at IS NULL THEN ? ELSE first_opened_at END,
         last_event_at = ?
       WHERE id = ?`
    )
    .bind(
      status,
      newStatus,
      detail,
      newStatus === 'opened' ? 1 : 0,
      newStatus === 'clicked' ? 1 : 0,
      newStatus,
      occurred,
      newStatus,
      occurred,
      occurred,
      email.id
    )
    .run();
  return new Response('ok');
}
