/**
 * Self-check for the scanAndScore timezone helpers.
 *
 * The Edge Function runs in UTC while slot buckets are wall-clock ranges in the
 * user's zone. If these helpers drift, every score row silently lands in the
 * wrong bucket, so this is the one thing worth asserting.
 *
 * Run: node tests/scanandscore-tz-selfcheck.mjs
 */
import assert from 'node:assert/strict';
import {
  civilNow,
  isValidTimeZone,
  zonedToUtcMs,
} from '../supabase/functions/scanAndScore/tz.mjs';

const HOUR = 3600000;
let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

console.log('scanAndScore timezone self-check\n');

check('UTC is the identity case', () => {
  assert.equal(zonedToUtcMs(2026, 7, 5, 6, 'UTC'), Date.UTC(2026, 7, 5, 6));
});

check('IST bucket start is not the naive UTC hour', () => {
  // 06:00 in Asia/Kolkata (UTC+5:30) is 00:30 UTC the same day.
  const got = zonedToUtcMs(2026, 7, 5, 6, 'Asia/Kolkata');
  assert.equal(new Date(got).toISOString(), '2026-08-05T00:30:00.000Z');
  assert.notEqual(got, Date.UTC(2026, 7, 5, 6), 'would mean setHours() was used');
});

check('every bucket keeps its nominal width on a normal day', () => {
  const buckets = [[6, 9], [9, 12], [12, 15], [15, 18], [18, 21], [21, 24], [0, 3]];
  for (const [h0, h1] of buckets) {
    const s0 = zonedToUtcMs(2026, 7, 5, h0, 'Asia/Kolkata');
    const s1 = h1 === 24
      ? zonedToUtcMs(2026, 7, 6, 0, 'Asia/Kolkata')
      : zonedToUtcMs(2026, 7, 5, h1, 'Asia/Kolkata');
    assert.equal(s1 - s0, (h1 - h0) * HOUR, `bucket ${h0}-${h1}`);
  }
});

check('spring-forward shortens the Late Night bucket to 2h', () => {
  // 2026-03-08, America/New_York: 02:00 never happens.
  const s0 = zonedToUtcMs(2026, 2, 8, 0, 'America/New_York');
  const s1 = zonedToUtcMs(2026, 2, 8, 3, 'America/New_York');
  assert.equal(s1 - s0, 2 * HOUR);
});

check('fall-back stretches the Late Night bucket to 4h', () => {
  // 2026-11-01, America/New_York: 01:00 happens twice.
  const s0 = zonedToUtcMs(2026, 10, 1, 0, 'America/New_York');
  const s1 = zonedToUtcMs(2026, 10, 1, 3, 'America/New_York');
  assert.equal(s1 - s0, 4 * HOUR);
});

check('Night bucket crossing spring-forward midnight stays 3h', () => {
  const s0 = zonedToUtcMs(2026, 2, 7, 21, 'America/New_York');
  const s1 = zonedToUtcMs(2026, 2, 8, 0, 'America/New_York');
  assert.equal(s1 - s0, 3 * HOUR);
});

check('month rollover normalises via civil arithmetic', () => {
  // monthIdx 12 == January of the next year; day 32 == the 1st of the next month.
  assert.equal(
    zonedToUtcMs(2026, 12, 1, 0, 'UTC'),
    zonedToUtcMs(2027, 0, 1, 0, 'UTC'),
  );
  assert.equal(
    zonedToUtcMs(2026, 7, 32, 0, 'UTC'),
    zonedToUtcMs(2026, 8, 1, 0, 'UTC'),
  );
});

check('civilNow respects the zone across the dateline', () => {
  const at = Date.UTC(2026, 7, 5, 20);
  assert.deepEqual(civilNow('UTC', at), { y: 2026, monthIdx: 7, day: 5 });
  assert.deepEqual(civilNow('Pacific/Auckland', at), { y: 2026, monthIdx: 7, day: 6 });
  assert.deepEqual(civilNow('America/Los_Angeles', at), { y: 2026, monthIdx: 7, day: 5 });
});

check('civilNow handles the UTC-midnight edge', () => {
  const at = Date.UTC(2026, 7, 5, 0, 30);
  assert.deepEqual(civilNow('America/New_York', at), { y: 2026, monthIdx: 7, day: 4 });
});

check('invalid timezones are rejected at the trust boundary', () => {
  assert.equal(isValidTimeZone('Asia/Kolkata'), true);
  assert.equal(isValidTimeZone('UTC'), true);
  assert.equal(isValidTimeZone('Not/AZone'), false);
  assert.equal(isValidTimeZone(''), false);
  assert.equal(isValidTimeZone(undefined), false);
});

console.log(`\n${passed} checks passed.`);
