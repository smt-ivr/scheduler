// נקודת הכניסה של ה-Worker: ממשק ניהול, API, webhook של Resend ו-Cron Trigger.

import { handleApi, audit } from './api.js';
import { isAuthenticated, login, logout, clientIp } from './auth.js';
import { handleResendWebhook } from './resend.js';
import { tick } from './scheduler.js';
import { getSettings, saveSettings } from './settings.js';
import { renderAdminPage } from './ui.js';

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
};

function withHeaders(res, extra = {}) {
  const r = new Response(res.body, res);
  for (const [k, v] of Object.entries({ ...SECURITY_HEADERS, ...extra })) r.headers.set(k, v);
  return r;
}

async function route(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === '/health') return new Response('ok');
  if (path === '/webhooks/resend' && request.method === 'POST') return handleResendWebhook(request, env);

  if (path === '/' || path === '/index.html') {
    return new Response(renderAdminPage(), {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Security-Policy':
          "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      },
    });
  }

  if (!path.startsWith('/api/')) return new Response('Not found', { status: 404 });

  // הגנת CSRF: כל בקשה שמשנה מצב חייבת להגיע מהממשק עצמו
  if (request.method !== 'GET' && request.headers.get('X-Requested-With') !== 'scheduler') {
    return Response.json({ error: 'בקשה לא מורשית' }, { status: 403 });
  }

  if (path === '/api/login' && request.method === 'POST') {
    const res = await login(request, env);
    if (res.ok) {
      ctx.waitUntil(
        (async () => {
          await audit(env, request, 'login.success');
          const settings = await getSettings(env.DB);
          if (settings.public_url !== url.origin) await saveSettings(env.DB, { public_url: url.origin });
        })().catch((e) => console.error(e))
      );
    } else if (res.status === 401) {
      ctx.waitUntil(audit(env, request, 'login.failure', null, clientIp(request)));
    }
    return res;
  }
  if (path === '/api/logout' && request.method === 'POST') return logout();

  if (!(await isAuthenticated(request, env))) return Response.json({ error: 'נדרשת התחברות' }, { status: 401 });
  if (path === '/api/me') return Response.json({ ok: true });
  return handleApi(request, env, ctx, url);
}

export default {
  async fetch(request, env, ctx) {
    try {
      return withHeaders(await route(request, env, ctx));
    } catch (e) {
      console.error('request failed', e);
      return withHeaders(Response.json({ error: `שגיאת שרת: ${e.message}` }, { status: 500 }));
    }
  },

  async scheduled(controller, env, ctx) {
    const result = await tick(env, Date.now());
    if (result.ran) console.log(`scheduler tick: ran ${result.ran} task(s)`);
  },
};
