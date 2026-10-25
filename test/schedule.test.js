import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSchedule, nextRun, upcoming, describeSchedule } from '../src/schedule.js';
import { hebrewToGregorian, formatHebrewDate, gematria, hebrewMonthKey } from '../src/hebrew.js';
import { parseLocalDateTime, formatDateTime } from '../src/time.js';

const at = (s) => parseLocalDateTime(s);
const sched = (s) => {
  const errors = [];
  const out = normalizeSchedule(s, errors);
  assert.deepEqual(errors, []);
  return out;
};
const next = (s, from, n = 3) => upcoming(sched(s), at(from), n).map((x) => x.local);

test('gematria and hebrew dates', () => {
  assert.equal(gematria(15), 'ט״ו');
  assert.equal(gematria(16), 'ט״ז');
  assert.equal(gematria(1), 'א׳');
  assert.equal(gematria(5787), 'תשפ״ז');
  assert.equal(formatHebrewDate(2026, 10, 25), 'י״ד חשוון תשפ״ז');
  assert.equal(hebrewMonthKey('אדר ב׳'), 'adar2');
  assert.equal(hebrewMonthKey('אדר ב'), 'adar2');
  assert.equal(hebrewMonthKey("אדר א'"), 'adar1');
  assert.equal(hebrewMonthKey('ניסן'), 'nisan');
});

test('hebrew → gregorian', () => {
  assert.equal(hebrewToGregorian(5787, 'nisan', 15), '2027-04-22');
  assert.equal(hebrewToGregorian(5787, 'tishrei', 1), '2026-09-12');
  // 5787 שנה מעוברת: "אדר" = אדר ב'
  assert.equal(hebrewToGregorian(5787, 'adar', 14), '2027-03-23');
  // 5786 שנה פשוטה: "אדר ב" = אדר
  assert.equal(hebrewToGregorian(5786, 'adar2', 14), '2026-03-03');
});

test('specific dates', () => {
  assert.deepEqual(next({ type: 'dates', dates: ['2026-11-05 18:00', '2026-11-03T10:30', '2026-01-01 09:00'] }, '2026-10-25 12:00'), ['2026-11-03 10:30', '2026-11-05 18:00']);
});

test('daily with days and several times', () => {
  // 25.10.2026 = יום ראשון
  assert.deepEqual(next({ type: 'daily', times: ['20:00', '08:00'], days: [0, 1, 2, 3, 4] }, '2026-10-29 21:00', 3), ['2026-11-01 08:00', '2026-11-01 20:00', '2026-11-02 08:00']);
});

test('monthly gregorian: day 31 falls on last day', () => {
  assert.deepEqual(next({ type: 'monthly', calendar: 'gregorian', day: 31, times: ['09:00'] }, '2026-10-31 10:00', 2), ['2026-11-30 09:00', '2026-12-31 09:00']);
});

test('monthly hebrew: rosh chodesh (1)', () => {
  const r = next({ type: 'monthly', calendar: 'hebrew', day: 1, times: ['07:00'] }, '2026-10-25 12:00', 2);
  assert.deepEqual(r, ['2026-11-11 07:00', '2026-12-11 07:00']);
});

test('yearly hebrew and gregorian', () => {
  assert.deepEqual(next({ type: 'yearly', calendar: 'hebrew', month: 'שבט', day: 15, times: ['10:00'] }, '2026-10-25 12:00', 2), ['2027-01-23 10:00', '2028-02-12 10:00']);
  assert.deepEqual(next({ type: 'yearly', calendar: 'gregorian', month: 2, day: 29, times: ['10:00'] }, '2026-10-25 12:00', 2), ['2027-02-28 10:00', '2028-02-29 10:00']);
});

test('interval within hours', () => {
  assert.deepEqual(next({ type: 'interval', minutes: 30, from: '08:00', to: '09:00' }, '2026-10-25 08:10', 4), ['2026-10-25 08:30', '2026-10-25 09:00', '2026-10-26 08:00', '2026-10-26 08:30']);
});

test('start/end range', () => {
  const s = { type: 'daily', times: ['09:00'], start_date: '2026-12-01', end_date: '2026-12-02' };
  assert.deepEqual(next(s, '2026-10-25 12:00', 5), ['2026-12-01 09:00', '2026-12-02 09:00']);
});

test('validation errors are in hebrew', () => {
  const errors = [];
  normalizeSchedule({ type: 'yearly', calendar: 'hebrew', month: 'xyz', day: 31, times: ['25:00'] }, errors);
  assert.equal(errors.length, 3);
  const e2 = [];
  normalizeSchedule({ type: 'nope' }, e2);
  assert.match(e2[0], /סוג תזמון/);
});

test('descriptions', () => {
  assert.equal(describeSchedule(sched({ type: 'daily', times: ['08:00'], days: [0, 1, 2, 3, 4] })), "בימים א'-ה' בשעה 08:00");
  assert.equal(describeSchedule(sched({ type: 'yearly', calendar: 'hebrew', month: 'nisan', day: 15, times: ['09:00'] })), 'כל שנה ב-ט״ו בניסן, בשעה 09:00');
  assert.equal(describeSchedule(sched({ type: 'interval', minutes: 15, from: '08:00', to: '18:00' })), 'כל 15 דקות בין 08:00 ל-18:00');
});

test('DST: daily 02:30 on spring-forward day still runs once', () => {
  const r = next({ type: 'daily', times: ['02:30'] }, '2026-03-26 12:00', 2);
  assert.equal(r.length, 2);
  assert.ok(at(r[0]) < at(r[1]));
});
