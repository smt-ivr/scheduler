import test from 'node:test';
import assert from 'node:assert/strict';
import { contentError, makeResponse, selectActions, normalizeRules, testCondition, getPath } from '../src/rules.js';
import { createContext, render } from '../src/templates.js';

const resp = (body, status = 200, headers = {}) => makeResponse({ status, body, headers });

test('keywords mark a 200 response as failure (case-insensitive by default)', () => {
  const rules = { fail_keywords: ['ERROR', 'שגיאה'], fail_conditions: [] };
  assert.match(contentError(rules, resp('{"result":"error: bad token"}')), /ERROR/);
  assert.match(contentError(rules, resp('אירעה שגיאה בשרת')), /שגיאה/);
  assert.equal(contentError(rules, resp('{"result":"ok"}')), null);
  assert.equal(contentError({ ...rules, keywords_case_sensitive: true }, resp('error')), null);
});

test('json conditions', () => {
  const r = resp('{"data":{"items":[{"status":"failed"}],"count":3},"ok":false}');
  assert.equal(getPath(r.json, 'data.items[0].status'), 'failed');
  assert.ok(testCondition({ source: 'json', path: 'ok', op: 'equals', value: 'false' }, r));
  assert.ok(testCondition({ source: 'json', path: 'data.count', op: 'gt', value: '2' }, r));
  assert.ok(testCondition({ source: 'json', path: 'missing', op: 'not_exists' }, r));
  assert.ok(testCondition({ source: 'body', op: 'regex', value: 'fail(ed)?' }, r));
  assert.match(contentError({ fail_conditions: [{ source: 'json', path: 'ok', op: 'equals', value: 'false' }] }, r), /שדה JSON "ok"/);
  assert.ok(!testCondition({ source: 'json', path: 'x', op: 'equals', value: '1' }, resp('not json')));
});

test('action selection: when, conditions, stop', () => {
  const rules = {
    actions: [
      { name: 'only vip', enabled: true, when: 'success', match: 'all', conditions: [{ source: 'json', path: 'type', op: 'equals', value: 'vip' }], stop: true },
      { name: 'everyone on success', enabled: true, when: 'success', conditions: [] },
      { name: 'on failure', enabled: true, when: 'failure', conditions: [] },
      { name: 'disabled', enabled: false, when: 'always', conditions: [] },
    ],
  };
  const pick = (outcome, body) => selectActions(rules, outcome, resp(body)).filter((s) => s.run).map((s) => s.action.name);
  assert.deepEqual(pick('success', '{"type":"vip"}'), ['only vip']);
  assert.deepEqual(pick('success', '{"type":"regular"}'), ['everyone on success']);
  assert.deepEqual(pick('failure', '{}'), ['on failure']);
});

test('normalizeRules validates', () => {
  const { errors } = normalizeRules({
    fail_keywords: 'error\n\n שגיאה ',
    fail_conditions: [{ source: 'json', op: 'equals', value: 'x' }, { source: 'body', op: 'regex', value: '(' }],
    actions: [{ type: 'email', email: { to: '', subject: '' } }, { type: 'webhook', webhook: { url: '', headers: '[' } }],
  });
  assert.ok(errors['rules.fail_conditions.0']);
  assert.ok(errors['rules.fail_conditions.1']);
  assert.ok(errors['rules.actions.0.email.to']);
  assert.ok(errors['rules.actions.1.webhook.url']);
  assert.ok(errors['rules.actions.1.webhook.headers']);
  const { rules } = normalizeRules({ fail_keywords: 'error\n\n שגיאה ' });
  assert.deepEqual(rules.fail_keywords, ['error', 'שגיאה']);
});

test('result variables in templates, html-escaped in emails', () => {
  const ctx = createContext({}, { task: { id: 1, name: 't' }, runId: 5 });
  ctx.result = { outcome: 'failure', response: resp('{"msg":"<b>x</b>","n":2}', 200), error: 'oops', attempts: 2, duration_ms: 10 };
  assert.equal(render('{{result}} {{status_code}} {{json:n}} {{error}}', ctx), 'נכשלה 200 2 oops');
  assert.equal(render('{{json:msg}}', ctx, { html: true }), '&lt;b&gt;x&lt;/b&gt;');
  assert.equal(render('{{json:msg}}', ctx), '<b>x</b>');
});
