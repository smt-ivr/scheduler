// משתנים בתוכן: {{date}}, {{hebrew_date}}, {{json:data.status}} וכו'.
// משתנה לא מוכר נשאר כמו שהוא.

import { formatDateTime, localParts } from './time.js';
import { formatHebrewDate } from './hebrew.js';
import { getPath } from './task.js';

export const VARIABLES = [
  ['{{date}}', 'תאריך היום (2026-11-03)'],
  ['{{time}}', 'השעה (10:30)'],
  ['{{hebrew_date}}', 'התאריך העברי (ב\' חשוון תשפ"ז)'],
  ['{{timestamp}}', 'Unix timestamp בשניות'],
  ['{{task}}', 'שם המשימה'],
  ['{{result}}', 'הצליח / נכשל'],
  ['{{status}}', 'קוד התגובה (200)'],
  ['{{json:data.status}}', 'שדה מתוך תגובת JSON'],
  ['{{response}}', 'תחילת התגובה'],
  ['{{error}}', 'סיבת הכשל'],
  ['{{secret:NAME}}', 'ערך של Worker secret (רשות)'],
];

const RESERVED = new Set(['ADMIN_PASSWORD']);
const PATTERN = /\{\{\s*([a-z_]+)(?::([^{}]+?))?\s*\}\}/g;
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const asText = (v) => (v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));

/**
 * ctx: { env, now, task, runId, resp?, outcome?, error? }
 * opts.html: הערכים עוברים escape (לתוכן מייל ב-HTML)
 */
export function render(text, ctx, opts = {}) {
  if (!text) return text ?? '';
  const out = (v) => (opts.html ? escapeHtml(asText(v)) : asText(v));
  return String(text).replace(PATTERN, (whole, name, arg) => {
    const dt = formatDateTime(ctx.now);
    switch (name) {
      case 'date':
        return dt.slice(0, 10);
      case 'time':
        return dt.slice(11, 16);
      case 'datetime':
        return dt.slice(0, 16);
      case 'hebrew_date': {
        const p = localParts(ctx.now);
        return formatHebrewDate(p.year, p.month, p.day);
      }
      case 'timestamp':
        return String(Math.floor(ctx.now / 1000));
      case 'task':
        return out(ctx.task?.name ?? '');
      case 'run_id':
        return String(ctx.runId ?? '');
      case 'secret': {
        const v = ctx.env?.[arg];
        if (!arg || RESERVED.has(arg) || typeof v !== 'string') return whole;
        return v;
      }
    }
    if (!ctx.resp) return whole;
    switch (name) {
      case 'result':
        return ctx.outcome === 'success' ? 'הצליח' : 'נכשל';
      case 'status':
        return out(ctx.resp.status ?? '');
      case 'response':
        return out(ctx.resp.body.slice(0, 2000));
      case 'error':
        return out(ctx.error ?? '');
      case 'json':
        return out(getPath(ctx.resp.json, arg || ''));
      case 'header':
        return out(ctx.resp.headers[String(arg || '').toLowerCase()]);
      default:
        return whole;
    }
  });
}
