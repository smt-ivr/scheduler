// נקודת הכניסה: ממשק הניהול, ה-API ו-Cron שרץ כל דקה.

import { handleApi } from './api.js';
import { isAuthenticated, login, logout } from './auth.js';
import { tick } from './runner.js';
import page from './admin.html';
import taskFormat from './task-format.md';

const SECURITY_HEADERS = { 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin' };

async function route(request, env, ctx) {
  const url = new URL(request.url);
  // הממשק יכול לשבת תחת נתיב, למשל https://smti.uk/scheduler (BASE_PATH ב-wrangler.toml)
  const basePath = String(env.BASE_PATH || '').replace(/\/+$/, '');
  let path = url.pathname;
  let base = '';
  if (basePath && (path === basePath || path.startsWith(`${basePath}/`))) {
    if (path === basePath) return Response.redirect(`${url.origin}${basePath}/`, 301);
    base = basePath;
    path = path.slice(basePath.length);
  }

  if (path === '/health') return new Response('ok');
  // מדריך מבנה ה-JSON - פתוח לכולם (אין בו מידע רגיש), כדי שאפשר יהיה לתת את הקישור ל-AI
  if (path === '/docs.md') {
    const headers = { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-cache' };
    if (url.searchParams.has('download')) headers['Content-Disposition'] = 'attachment; filename="scheduler-task-format.md"';
    return new Response(taskFormat, { headers });
  }
  if (path === '/' || path === '/index.html') {
    return new Response(page.replace('__BASE_PATH__', base.replace(/[^A-Za-z0-9/_-]/g, '')), {
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }
  if (!path.startsWith('/api/')) return new Response('Not found', { status: 404 });

  // הגנת CSRF: בקשות שמשנות משהו חייבות להגיע מהממשק
  if (request.method !== 'GET' && request.headers.get('X-Requested-With') !== 'scheduler') {
    return Response.json({ error: 'בקשה לא מורשית' }, { status: 403 });
  }
  if (path === '/api/login' && request.method === 'POST') return login(request, env);
  if (path === '/api/logout' && request.method === 'POST') return logout();
  if (!(await isAuthenticated(request, env))) return Response.json({ error: 'נדרשת התחברות' }, { status: 401 });
  if (path === '/api/me') return Response.json({ ok: true });
  return handleApi(request, env, ctx, path);
}

export default {
  async fetch(request, env, ctx) {
    let res;
    try {
      res = await route(request, env, ctx);
    } catch (e) {
      console.error(e);
      res = Response.json({ error: `שגיאת שרת: ${e.message}` }, { status: 500 });
    }
    res = new Response(res.body, res);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.headers.set(k, v);
    return res;
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(tick(env, Date.now()));
  },
};
