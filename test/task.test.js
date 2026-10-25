import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTask, evaluateResponse, makeResponse, matchingRules } from '../src/task.js';
import { planEmails, renderBody } from '../src/runner.js';

const base = {
  name: 'בדיקה',
  schedule: { type: 'daily', times: ['09:00'] },
  request: { method: 'POST', url: 'https://api.example.com/run', headers: { Authorization: 'Bearer KEY' }, body: { a: 1 } },
  success: { status: '200-299', error_words: ['error', 'שגיאה'] },
  rules: [
    { name: 'VIP', when: 'success', if: [{ field: 'json:type', op: 'equals', value: 'vip' }], email: { to: 'boss@x.com', subject: 'VIP {{json:status}}', body: 'שלום {{json:name}}' }, stop: true },
    { name: 'כולם', when: 'success', email: { to: ['a@x.com', 'b@x.com'], subject: '{{task}} {{result}}', body: 'קוד {{status}}' } },
    { name: 'כשל', when: 'failure', email: { to: 'ops@x.com', subject: 'נכשל', body: '{{error}}' } },
  ],
};

test('valid task normalizes', () => {
  const { config, errors } = normalizeTask(base);
  assert.deepEqual(errors, []);
  assert.equal(config.request.body, '{\n  "a": 1\n}');
  assert.deepEqual(config.rules[0].email.to, ['boss@x.com']);
  assert.equal(config.request.retries, 2);
});

test('errors are listed in hebrew with paths', () => {
  const { errors } = normalizeTask({ schedule: { type: 'dates', dates: ['bad'] }, request: { url: 'ftp://x' }, rules: [{ email: { to: 'nope' } }] });
  const text = errors.join('\n');
  assert.match(text, /name: חסר שם/);
  assert.match(text, /schedule.dates\[0\]/);
  assert.match(text, /request.url/);
  assert.match(text, /rules\[0\].email: כתובת לא תקינה "nope"/);
  assert.match(text, /rules\[0\].email.subject/);
});

test('200 with error word is a failure without retry', () => {
  const s = normalizeTask(base).config.success;
  assert.deepEqual(evaluateResponse(s, makeResponse({ status: 200, body: '{"result":"ERROR: bad"}' })), { ok: false, retry: false, error: 'התגובה מכילה "error"' });
  assert.equal(evaluateResponse(s, makeResponse({ status: 503, body: '' })).retry, true);
  assert.equal(evaluateResponse(s, makeResponse({ status: 200, body: '{"ok":1}' })).ok, true);
});

test('rules choose who gets what', () => {
  const { config } = normalizeTask(base);
  const pick = (outcome, body) => matchingRules(config.rules, outcome, makeResponse({ status: 200, body })).map((r) => r.name);
  assert.deepEqual(pick('success', '{"type":"vip"}'), ['VIP']);
  assert.deepEqual(pick('success', '{"type":"x"}'), ['כולם']);
  assert.deepEqual(pick('failure', '{}'), ['כשל']);
});

test('planned emails render variables and escape html', () => {
  const { config } = normalizeTask(base);
  const ctx = { env: {}, now: Date.now(), task: { name: 'בדיקה' }, resp: makeResponse({ status: 200, body: '{"type":"vip","status":"done","name":"<b>דוד</b>"}' }), outcome: 'success' };
  const [m] = planEmails(config, ctx);
  assert.deepEqual(m.to, ['boss@x.com']);
  assert.equal(m.subject, 'VIP done');
  assert.equal(m.text, 'שלום <b>דוד</b>');
  assert.match(m.html, /&lt;b&gt;דוד/);
});

test('JSON body stays valid with quotes and hebrew dates', () => {
  const ctx = { env: {}, now: Date.parse('2026-10-25T10:00:00Z'), task: { name: 'משימה "מיוחדת"\nשורה' } };
  const out = renderBody('{"name": "{{task}}", "heb": "{{hebrew_date}}", "n": 5}', ctx);
  const parsed = JSON.parse(out);
  assert.equal(parsed.name, 'משימה "מיוחדת"\nשורה');
  assert.equal(parsed.heb, 'י״ד חשוון תשפ״ז');
  assert.equal(parsed.n, 5);
  assert.equal(renderBody('a={{date}}', ctx), 'a=2026-10-25');
});
