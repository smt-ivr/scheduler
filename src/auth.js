// התחברות לממשק: סיסמה אחת (ADMIN_PASSWORD) ועוגיית סשן חתומה ב-HMAC.
// החלפת הסיסמה מבטלת אוטומטית את כל הסשנים הקיימים.

const COOKIE = 'scheduler_session';
const SESSION_HOURS = 12;
const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 15 * 60_000;

const enc = new TextEncoder();

function b64url(bytes) {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hmac(secret, data) {
  const key = await crypto.subtle.importKey('raw', enc.encode(`scheduler-session:${secret}`), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}

/** השוואה בזמן קבוע (משווים גיבובים כדי שאורך הסיסמה לא ידלוף) */
async function safeEqual(a, b) {
  const [ha, hb] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(a)), crypto.subtle.digest('SHA-256', enc.encode(b))]);
  const x = new Uint8Array(ha);
  const y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

export const clientIp = (request) => request.headers.get('CF-Connecting-IP') || 'unknown';

export async function isAuthenticated(request, env) {
  if (!env.ADMIN_PASSWORD) return false;
  const cookie = request.headers.get('Cookie') || '';
  const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`).exec(cookie);
  if (!m) return false;
  const [exp, sig] = decodeURIComponent(m[1]).split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  return safeEqual(sig, await hmac(env.ADMIN_PASSWORD, exp));
}

function cookieHeader(value, maxAge) {
  return `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}

export async function login(request, env) {
  if (!env.ADMIN_PASSWORD) {
    return Response.json({ error: 'לא הוגדרה סיסמה. הגדר את ה-secret בשם ADMIN_PASSWORD' }, { status: 503 });
  }
  const db = env.DB;
  const ip = clientIp(request);
  const now = Date.now();
  const recent = await db
    .prepare('SELECT COUNT(*) AS n FROM scheduler_login_attempts WHERE ip = ? AND at > ?')
    .bind(ip, now - FAILURE_WINDOW_MS)
    .first();
  if ((recent?.n || 0) >= MAX_FAILURES) {
    return Response.json({ error: 'יותר מדי ניסיונות כושלים. נסה שוב בעוד 15 דקות' }, { status: 429 });
  }

  let password = '';
  try {
    ({ password = '' } = await request.json());
  } catch {}
  if (!(await safeEqual(String(password), env.ADMIN_PASSWORD))) {
    await db.prepare('INSERT INTO scheduler_login_attempts (ip, at) VALUES (?, ?)').bind(ip, now).run();
    await new Promise((r) => setTimeout(r, 400));
    return Response.json({ error: 'סיסמה שגויה' }, { status: 401 });
  }

  await db.prepare('DELETE FROM scheduler_login_attempts WHERE ip = ?').bind(ip).run();
  const exp = String(now + SESSION_HOURS * 3_600_000);
  const token = `${exp}.${await hmac(env.ADMIN_PASSWORD, exp)}`;
  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'Content-Type': 'application/json', 'Set-Cookie': cookieHeader(encodeURIComponent(token), SESSION_HOURS * 3600) },
  });
}

export function logout() {
  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'Content-Type': 'application/json', 'Set-Cookie': cookieHeader('', 0) },
  });
}
