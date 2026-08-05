/**
 * Stress + edge-case harness for slot algorithm v1 (lib/slot-algorithm.js).
 * Drives the real scoring code with synthetic freeBusy payloads: empty calendar,
 * jam-packed calendar, hostile input, DST boundaries, and 50k-event volume.
 *
 * Run: node tests/slot-algorithm-stress.js
 */
const assert = require('assert');
const algo = require('../lib/slot-algorithm.js');

const {
  computeScores,
  suggestPreferences,
  mergeIntervals,
  prefsAnalysisWindow,
  BUCKET_ORDER,
  WEEKDAY_KEYS,
} = algo;

const NOW = new Date(2026, 7, 5); // Wed Aug 5 2026 — same window the popup scans
const { timeMin, timeMax } = prefsAnalysisWindow(NOW);
const RANGES = [{ start: timeMin, end: timeMax }];
const WINDOW_DAYS = Math.round((timeMax - timeMin) / 86400000) + 1;

const timings = [];

function bench(label, fn, runs = 5) {
  fn(); // warm-up: exclude JIT cost from the reported number
  const samples = [];
  for (let i = 0; i < runs; i++) {
    const t0 = process.hrtime.bigint();
    fn();
    samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  samples.sort((a, b) => a - b);
  timings.push({
    label,
    median: samples[Math.floor(samples.length / 2)],
    min: samples[0],
    max: samples[samples.length - 1],
  });
}

function eachDayInWindow(fn) {
  for (let d = new Date(timeMin); d <= timeMax; d.setDate(d.getDate() + 1)) {
    fn(new Date(d));
  }
}

/** Events every `blockMin` minutes between fromHour and toHour, every day. */
function packedCalendar({ fromHour, toHour, blockMin = 30, dayFilter = () => true }) {
  const busy = [];
  eachDayInWindow(day => {
    if (!dayFilter(day)) return;
    for (let m = fromHour * 60; m < toHour * 60; m += blockMin) {
      const s = new Date(day);
      s.setHours(0, m, 0, 0);
      const e = new Date(s.getTime() + blockMin * 60000);
      busy.push({ start: s.toISOString(), end: e.toISOString() });
    }
  });
  return busy;
}

function allScoreCells(scores) {
  const out = [];
  for (let w = 0; w < 7; w++) for (const b of BUCKET_ORDER) out.push(scores[w][b]);
  return out;
}

function assertSaneGrid(scores, label) {
  for (let w = 0; w < 7; w++) {
    for (const b of BUCKET_ORDER) {
      const cell = scores[w][b];
      assert.ok(cell, `${label}: missing cell ${w}/${b}`);
      assert.ok(Number.isFinite(cell.score), `${label}: ${w}/${b} score not finite (${cell.score})`);
      assert.ok(cell.score >= 0 && cell.score <= 1, `${label}: ${w}/${b} score out of range (${cell.score})`);
      assert.ok(Number.isFinite(cell.avgFreeRatio), `${label}: ${w}/${b} avgFreeRatio not finite`);
      assert.ok(
        cell.avgFreeRatio >= 0 && cell.avgFreeRatio <= 1,
        `${label}: ${w}/${b} avgFreeRatio out of range (${cell.avgFreeRatio})`
      );
      assert.ok(Number.isInteger(cell.sampleSize) && cell.sampleSize >= 0, `${label}: ${w}/${b} bad sampleSize`);
    }
  }
}

function assertSaneSuggestion(sug, label) {
  assert.ok(sug.suggestedDays.length >= 1, `${label}: no days suggested`);
  assert.ok(sug.suggestedDays.length <= 3, `${label}: too many days`);
  assert.ok(sug.suggestedTimes.length >= 1, `${label}: no times suggested`);
  assert.ok(sug.suggestedTimes.length <= 3, `${label}: too many times`);
  for (const d of sug.suggestedDays) assert.ok(WEEKDAY_KEYS.includes(d), `${label}: bogus day ${d}`);
  for (const t of sug.suggestedTimes) assert.ok(BUCKET_ORDER.includes(t), `${label}: bogus bucket ${t}`);
  assert.strictEqual(new Set(sug.suggestedDays).size, sug.suggestedDays.length, `${label}: dup days`);
  assert.strictEqual(new Set(sug.suggestedTimes).size, sug.suggestedTimes.length, `${label}: dup times`);
}

// ── 1. Completely free calendar ───────────────────────────────────────────────
{
  const { scores, rows } = computeScores([], RANGES);
  assertSaneGrid(scores, 'free');
  assert.strictEqual(rows.length, 49);
  for (const cell of allScoreCells(scores)) {
    assert.strictEqual(cell.score, 1, 'free calendar must score 1.0 everywhere');
    assert.strictEqual(cell.confidence, 'normal');
  }
  assertSaneSuggestion(suggestPreferences(scores), 'free');
  bench(`free calendar (0 events, ${WINDOW_DAYS}d)`, () => computeScores([], RANGES));
}

// ── 2. Jam-packed: back-to-back 30-min events 00:00–24:00, every single day ───
{
  const busy = packedCalendar({ fromHour: 0, toHour: 24, blockMin: 30 });
  const { scores } = computeScores(busy, RANGES);
  assertSaneGrid(scores, 'jam-packed');
  for (const cell of allScoreCells(scores)) {
    assert.strictEqual(cell.score, 0, 'fully booked calendar must score 0 everywhere');
    assert.strictEqual(cell.avgFreeRatio, 0, 'fully booked calendar has no free time');
  }
  // Must still return a usable (if arbitrary) answer rather than crashing/empty.
  assertSaneSuggestion(suggestPreferences(scores), 'jam-packed');
  bench(`jam-packed 24/7 (${busy.length} events)`, () => computeScores(busy, RANGES));
}

// ── 3. Realistic heavy work calendar: 08:00–20:00 booked Mon–Fri ──────────────
{
  const busy = packedCalendar({
    fromHour: 8,
    toHour: 20,
    blockMin: 60,
    dayFilter: d => d.getDay() >= 1 && d.getDay() <= 5,
  });
  const { scores } = computeScores(busy, RANGES);
  assertSaneGrid(scores, 'workweek');
  // Weekends untouched → still perfectly free.
  assert.strictEqual(scores[5]['Mid-Morning (9–12)'].score, 1, 'Sat mid-morning should be free');
  assert.strictEqual(scores[6]['Mid-Morning (9–12)'].score, 1, 'Sun mid-morning should be free');
  // Weekday working hours fully consumed, evenings/nights untouched.
  assert.strictEqual(scores[0]['Mid-Morning (9–12)'].score, 0, 'Mon 9–12 is fully booked');
  assert.strictEqual(scores[0]['Night (9–12)'].score, 1, 'Mon 21–24 is free');
  const sug = suggestPreferences(scores);
  assertSaneSuggestion(sug, 'workweek');
  assert.ok(
    sug.suggestedDays.includes('sat') && sug.suggestedDays.includes('sun'),
    `workweek should surface the weekend, got ${sug.suggestedDays}`
  );
  bench(`work calendar (${busy.length} events)`, () => computeScores(busy, RANGES));
}

// ── 4. Moderately busy everywhere: binary threshold must not erase ranking ────
// Every bucket is partly busy, so nothing clears FREE_RATIO_THRESHOLD and all
// binary scores collapse to 0. The suggestion must still prefer the freest day.
{
  const busy = [];
  eachDayInWindow(day => {
    const wd = day.getDay();
    // Fri (5) 40% busy, everything else 90% busy → Fri is clearly the best day.
    const busyFraction = wd === 5 ? 0.4 : 0.9;
    for (const bucket of BUCKET_ORDER) {
      const [h0, h1] = algo.SLOT_RANGES[bucket];
      const spanH = (h1 === 24 ? 24 : h1) - h0;
      const s = new Date(day);
      s.setHours(h0, 0, 0, 0);
      const e = new Date(s.getTime() + spanH * busyFraction * 3600000);
      busy.push({ start: s.toISOString(), end: e.toISOString() });
    }
  });
  const { scores } = computeScores(busy, RANGES);
  assertSaneGrid(scores, 'moderate');
  for (const cell of allScoreCells(scores)) {
    assert.strictEqual(cell.score, 0, 'threshold should reject all these buckets');
  }
  assert.ok(
    scores[4]['Morning (6–9)'].avgFreeRatio > scores[0]['Morning (6–9)'].avgFreeRatio,
    'Fri must record more free time than Mon'
  );
  const sug = suggestPreferences(scores);
  assertSaneSuggestion(sug, 'moderate');
  assert.ok(
    sug.suggestedDays.includes('fri'),
    `all-zero grid must fall back to the freest day (fri), got ${sug.suggestedDays}`
  );
}

// ── 5. Late Night bucket maps to 00:00–03:00 of the same calendar day ─────────
{
  const busy = [];
  eachDayInWindow(day => {
    const s = new Date(day);
    s.setHours(0, 0, 0, 0);
    const e = new Date(day);
    e.setHours(3, 0, 0, 0);
    busy.push({ start: s.toISOString(), end: e.toISOString() });
  });
  const { scores } = computeScores(busy, RANGES);
  for (let w = 0; w < 7; w++) {
    assert.strictEqual(scores[w]['Late Night (12–3)'].score, 0, `late night ${w} should be busy`);
    assert.strictEqual(scores[w]['Morning (6–9)'].score, 1, `morning ${w} should be free`);
  }
}

// ── 6. Overlap / duplication is idempotent ───────────────────────────────────
{
  const one = [{
    start: new Date(2026, 7, 10, 9, 0).toISOString(),
    end: new Date(2026, 7, 10, 12, 0).toISOString(),
  }];
  const many = [];
  for (let i = 0; i < 200; i++) many.push({ ...one[0] });
  // Same 9–12 span expressed as 200 overlapping fragments of increasing length.
  const spanStart = new Date(2026, 7, 10, 9, 0).getTime();
  const spanMs = 3 * 3600000;
  const fragments = [];
  for (let i = 1; i <= 200; i++) {
    fragments.push({
      start: new Date(spanStart).toISOString(),
      end: new Date(spanStart + (spanMs * i) / 200).toISOString(),
    });
  }
  const a = computeScores(one, RANGES).scores;
  const b = computeScores(many, RANGES).scores;
  assert.deepStrictEqual(b, a, 'duplicate events must not change scores');
  const c = computeScores([...one, ...fragments], RANGES).scores;
  assert.deepStrictEqual(c, a, 'overlapping fragments inside the same span must not change scores');
}

// ── 7. Hostile / malformed freeBusy payload must not crash ───────────────────
{
  const junk = [
    { start: 'not-a-date', end: 'also-not-a-date' },
    { start: null, end: null },
    { start: undefined, end: undefined },
    {},
    { start: new Date(2026, 7, 10, 10, 0).toISOString(), end: new Date(2026, 7, 10, 9, 0).toISOString() }, // reversed
    { start: new Date(2026, 7, 10, 10, 0).toISOString(), end: new Date(2026, 7, 10, 10, 0).toISOString() }, // zero length
    { start: '2026-08-10T10:00:00Z', end: '' },
    { start: 0, end: 0 },
  ];
  const { scores } = computeScores(junk, RANGES);
  assertSaneGrid(scores, 'junk');
  for (const cell of allScoreCells(scores)) {
    assert.strictEqual(cell.score, 1, 'unusable entries must be ignored, not counted as busy');
  }
  assertSaneSuggestion(suggestPreferences(scores), 'junk');
}

// ── 8. Absurdly long events must be clamped, not expanded day-by-day ─────────
{
  const monster = [{
    start: new Date(1990, 0, 1).toISOString(),
    end: new Date(2090, 0, 1).toISOString(),
  }];
  const t0 = process.hrtime.bigint();
  const { scores } = computeScores(monster, RANGES);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assertSaneGrid(scores, 'century-event');
  for (const cell of allScoreCells(scores)) {
    assert.strictEqual(cell.score, 0, 'a century-long event covers the whole window');
  }
  assert.ok(ms < 250, `100-year event took ${ms.toFixed(1)}ms — window clamp is not working`);
  timings.push({ label: '100-year single event (clamped)', median: ms, min: ms, max: ms });

  // Same event without the clamp — this is what the splitter used to do, and it
  // is the reason the clamp exists. Kept measured so a regression is obvious.
  const t1 = process.hrtime.bigint();
  const unclamped = algo.mergeAndIndexByDate(monster);
  const unclampedMs = Number(process.hrtime.bigint() - t1) / 1e6;
  const clamped = algo.mergeAndIndexByDate(monster, +timeMin, +timeMax);
  assert.ok(
    Object.keys(unclamped).length > 30000,
    'sanity: an unclamped century event should explode into ~36.5k day buckets'
  );
  assert.ok(
    Object.keys(clamped).length <= WINDOW_DAYS + 1,
    `clamped split must stay inside the window, got ${Object.keys(clamped).length} days`
  );
  timings.push({
    label: `  ↳ same event unclamped (${Object.keys(unclamped).length} day buckets)`,
    median: unclampedMs,
    min: unclampedMs,
    max: unclampedMs,
  });
}

// ── 9. DST boundaries produce finite scores (US spring-forward / fall-back) ──
{
  const origTZ = process.env.TZ;
  for (const tz of ['America/New_York', 'Australia/Lord_Howe', 'Asia/Kolkata']) {
    process.env.TZ = tz;
    // Re-require in a fresh module registry so Date picks up TZ on platforms that cache it.
    delete require.cache[require.resolve('../lib/slot-algorithm.js')];
    const a = require('../lib/slot-algorithm.js');
    for (const [y, m] of [[2026, 2], [2026, 10]]) { // March + November
      const start = new Date(y, m, 1);
      const end = new Date(y, m + 1, 0, 23, 59, 59, 999);
      const busy = [];
      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        const s = new Date(d);
        s.setHours(1, 0, 0, 0);
        busy.push({ start: s.toISOString(), end: new Date(s.getTime() + 3 * 3600000).toISOString() });
      }
      const { scores, rows } = a.computeScores(busy, [{ start, end }]);
      for (let w = 0; w < 7; w++) {
        for (const b of a.BUCKET_ORDER) {
          const cell = scores[w][b];
          assert.ok(Number.isFinite(cell.score), `${tz} ${y}-${m + 1} ${w}/${b} NaN score`);
          assert.ok(cell.score >= 0 && cell.score <= 1, `${tz} ${y}-${m + 1} ${w}/${b} = ${cell.score}`);
        }
      }
      for (const r of rows) assert.ok(Number.isFinite(r.score), `${tz} row NaN`);
    }
  }
  if (origTZ === undefined) delete process.env.TZ;
  else process.env.TZ = origTZ;
  delete require.cache[require.resolve('../lib/slot-algorithm.js')];
  require('../lib/slot-algorithm.js');
}

// ── 10. mergeIntervals never emits holes ─────────────────────────────────────
{
  assert.deepStrictEqual(mergeIntervals([]), []);
  const allBad = mergeIntervals([
    { start: 'x', end: 'y' },
    { start: new Date(2026, 7, 1, 5).toISOString(), end: new Date(2026, 7, 1, 5).toISOString() },
  ]);
  assert.deepStrictEqual(allBad, [], 'all-unusable input must return [] and never [undefined]');
  for (const iv of mergeIntervals([{ start: 'x', end: 'y' }])) {
    assert.ok(iv && Number.isFinite(iv.start), 'merged interval must be a real object');
  }
}

// ── 11. Determinism ──────────────────────────────────────────────────────────
{
  const busy = packedCalendar({ fromHour: 7, toHour: 23, blockMin: 45 });
  const a = computeScores(busy, RANGES);
  const b = computeScores([...busy].reverse(), RANGES);
  assert.deepStrictEqual(b.scores, a.scores, 'input order must not change scores');
  assert.deepStrictEqual(suggestPreferences(b.scores), suggestPreferences(a.scores));
}

// ── 12. Volume: 50k events (pathological sync loop / shared team calendar) ───
{
  const busy = packedCalendar({ fromHour: 0, toHour: 24, blockMin: 5 });
  assert.ok(busy.length > 25000, `expected a big payload, got ${busy.length}`);
  const { scores } = computeScores(busy, RANGES);
  assertSaneGrid(scores, 'volume');
  bench(`volume (${busy.length} events, 5-min blocks)`, () => computeScores(busy, RANGES), 3);
}

// ── 13. Partial scan coverage must not treat unscanned months as free ────────
{
  // Only the middle month was fetched; the other two failed.
  const middle = [{ start: new Date(2026, 7, 1), end: new Date(2026, 7, 31, 23, 59, 59) }];
  const busy = packedCalendar({ fromHour: 0, toHour: 24, blockMin: 60 })
    .filter(b => new Date(b.start).getMonth() === 7);
  const partial = computeScores(busy, middle).scores;
  for (const cell of allScoreCells(partial)) {
    assert.strictEqual(cell.score, 0, 'covered range is fully booked, so every cell must be 0');
  }
  // Same payload scored against the full window would wrongly look half-free.
  const wrong = computeScores(busy, RANGES).scores;
  assert.ok(
    wrong[0]['Morning (6–9)'].score > 0,
    'sanity: scoring an unscanned range as free is exactly the bug popup.js must avoid'
  );
}

// ── Report ───────────────────────────────────────────────────────────────────
const pad = (s, n) => String(s).padEnd(n);
console.log(`\nScan window: ${timeMin.toDateString()} → ${timeMax.toDateString()} (${WINDOW_DAYS} days)\n`);
console.log(`${pad('scenario', 48)}${pad('median', 11)}${pad('min', 11)}max`);
console.log('-'.repeat(80));
for (const t of timings) {
  console.log(
    `${pad(t.label, 48)}${pad(t.median.toFixed(2) + ' ms', 11)}${pad(t.min.toFixed(2) + ' ms', 11)}${t.max.toFixed(2)} ms`
  );
}
console.log('\n✅ slot-algorithm-stress passed');
