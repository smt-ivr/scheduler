import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCron, nextRuns, describeCron, validateCron } from '../src/cron.js';
import { formatDateTime, parseLocalDateTime, zonedToUtc } from '../src/time.js';

const fmt = (list) => list.map(formatDateTime);
const at = (s) => parseLocalDateTime(s);

test('parse basic fields', () => {
  const c = parseCron('*/15 8-17 * * 0-4');
  assert.deepEqual(c.minutes, [0, 15, 30, 45]);
  assert.deepEqual(c.hours, [8, 9, 10, 11, 12, 13, 14, 15, 16, 17]);
  assert.deepEqual([...c.dows], [0, 1, 2, 3, 4]);
});

test('names, 7 = sunday, macros', () => {
  assert.deepEqual([...parseCron('0 0 * jan,MAR sun-tue').months], [1, 3]);
  assert.deepEqual([...parseCron('0 0 * * 7').dows], [0]);
  assert.equal(parseCron('@daily').source, '0 0 * * *');
});

test('invalid expressions', () => {
  assert.match(validateCron('* * *'), /5 שדות/);
  assert.match(validateCron('60 * * * *'), /מחוץ לטווח/);
  assert.match(validateCron('0 0 30 2 *'), /לעולם/);
  assert.equal(validateCron('0 9 * * 1-5'), null);
});

test('every minute is strictly after', () => {
  const t = at('2026-01-10 10:00');
  assert.deepEqual(fmt(nextRuns('* * * * *', t, 3)), ['2026-01-10 10:01:00', '2026-01-10 10:02:00', '2026-01-10 10:03:00']);
});

test('daily at 09:00 Jerusalem in winter and summer', () => {
  const winter = nextRuns('0 9 * * *', at('2026-01-10 10:00'), 1)[0];
  assert.equal(new Date(winter).toISOString(), '2026-01-11T07:00:00.000Z');
  const summer = nextRuns('0 9 * * *', at('2026-07-10 10:00'), 1)[0];
  assert.equal(new Date(summer).toISOString(), '2026-07-11T06:00:00.000Z');
});

test('spring forward: 02:30 does not exist, shifted to 03:30', () => {
  // 2026: שעון קיץ מתחיל ביום שישי 27.3 בשעה 02:00 → 03:00
  const runs = nextRuns('30 2 * * *', at('2026-03-26 12:00'), 3);
  assert.deepEqual(fmt(runs), ['2026-03-27 03:30:00', '2026-03-28 02:30:00', '2026-03-29 02:30:00']);
});

test('fall back: 01:30 occurs twice but runs once', () => {
  // 2026: שעון חורף מתחיל ביום ראשון 25.10 בשעה 02:00 → 01:00
  const runs = nextRuns('30 1 * * *', at('2026-10-24 12:00'), 2);
  assert.equal(runs.length, 2);
  assert.equal(new Date(runs[0]).toISOString(), '2026-10-24T22:30:00.000Z');
  assert.equal(formatDateTime(runs[1]), '2026-10-26 01:30:00');
});

test('every 30 minutes across fall back has no duplicates and is increasing', () => {
  const runs = nextRuns('*/30 * * * *', at('2026-10-25 00:00'), 8);
  for (let i = 1; i < runs.length; i++) assert.ok(runs[i] > runs[i - 1]);
});

test('dom OR dow semantics', () => {
  const runs = nextRuns('0 12 1 * 5', at('2026-05-01 13:00'), 3);
  // 1.5.2026 הוא יום שישי; הבאים: שישי 8.5, שישי 15.5
  assert.deepEqual(fmt(runs), ['2026-05-08 12:00:00', '2026-05-15 12:00:00', '2026-05-22 12:00:00']);
  const runs2 = nextRuns('0 12 1 * 5', at('2026-05-23 13:00'), 2);
  assert.deepEqual(fmt(runs2), ['2026-05-29 12:00:00', '2026-06-01 12:00:00']);
});

test('feb 29 is found years ahead', () => {
  const r = nextRuns('0 0 29 2 *', at('2026-03-01 00:00'), 1);
  assert.equal(formatDateTime(r[0]), '2028-02-29 00:00:00');
});

test('zonedToUtc round trip', () => {
  assert.equal(new Date(zonedToUtc(2026, 6, 1, 0, 0)).toISOString(), '2026-05-31T21:00:00.000Z');
});

test('hebrew description', () => {
  assert.equal(describeCron('* * * * *'), 'כל דקה');
  assert.equal(describeCron('*/5 * * * *'), 'כל 5 דקות');
  assert.equal(describeCron('0 9 * * *'), 'כל יום, בשעה 09:00');
  assert.equal(describeCron('30 8 * * 0-4'), 'בימים ראשון עד חמישי, בשעה 08:30');
  assert.equal(describeCron('0 10 1 * *'), 'ב-1 בכל חודש, בשעה 10:00');
});

test('performance: every-minute preview is fast', () => {
  const t0 = performance.now();
  for (let i = 0; i < 50; i++) nextRuns('* * * * *', Date.now() + i * 3_600_000, 5);
  assert.ok(performance.now() - t0 < 1000);
});
