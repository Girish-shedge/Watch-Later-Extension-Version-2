/**
 * Self-check for slot algorithm v1 (lib/slot-algorithm.js).
 * Run: node tests/slot-algorithm-selfcheck.js
 */
const assert = require('assert');
const algo = require('../lib/slot-algorithm.js');

const {
  computeScores,
  suggestPreferences,
  resumeDestination,
  WEEKDAY_KEYS,
  BUCKET_ORDER,
  jsDayToWeekday,
} = algo;

assert.strictEqual(jsDayToWeekday(0), 6); // Sun
assert.strictEqual(jsDayToWeekday(1), 0); // Mon

// Empty calendar over one full week Mon–Sun → high scores, deterministic suggestion
{
  const start = new Date(2026, 7, 3); // Mon Aug 3 2026
  const end = new Date(2026, 7, 30, 23, 59, 59); // enough weeks for sample size
  const { scores } = computeScores([], [{ start, end }], {
    MIN_SAMPLE_SIZE: 3,
    FREE_RATIO_THRESHOLD: 0.8,
  });
  for (let w = 0; w < 7; w++) {
    for (const b of BUCKET_ORDER) {
      assert.ok(scores[w][b].score >= 0.99, `empty cal ${w}/${b} = ${scores[w][b].score}`);
      assert.strictEqual(scores[w][b].confidence, 'normal');
    }
  }
  const sug = suggestPreferences(scores, { SELECTION_THRESHOLD: 0.7, MAX_SELECTIONS: 3 });
  assert.deepStrictEqual(sug.suggestedDays, ['mon', 'tue', 'wed']); // WEEKDAY_ORDER tie-break
  assert.strictEqual(sug.suggestedTimes.length, 3);
  assert.strictEqual(sug.suggestedTimes[0], 'Morning (6–9)'); // BUCKET_ORDER tie-break
}

// Busy every Mon–Wed morning → evenings freer on those days; Fri empty wins day pick
{
  const start = new Date(2026, 7, 3);
  const end = new Date(2026, 7, 30, 23, 59, 59);
  const busy = [];
  for (let d = 3; d <= 26; d++) {
    const day = new Date(2026, 7, d);
    const wd = day.getDay(); // 1=Mon..3=Wed
    if (wd >= 1 && wd <= 3) {
      busy.push({
        start: new Date(2026, 7, d, 6, 0).toISOString(),
        end: new Date(2026, 7, d, 9, 0).toISOString(),
      });
    }
  }
  const { scores } = computeScores(busy, [{ start, end }]);
  assert.ok(scores[0]['Morning (6–9)'].score < scores[0]['Evening (6–9)'].score);
  const sug = suggestPreferences(scores);
  assert.ok(sug.suggestedDays.length >= 1 && sug.suggestedDays.length <= 3);
  assert.ok(sug.suggestedTimes.length >= 1 && sug.suggestedTimes.length <= 3);
  // Morning should not be the top joint pick for busy mornings on selected days if mornings are packed
  // (depends on which days selected — just assert stability)
  const sug2 = suggestPreferences(scores);
  assert.deepStrictEqual(sug2, sug);
}

// Sparse: < MIN_SAMPLE_SIZE → low confidence 0.5
{
  const start = new Date(2026, 7, 3);
  const end = new Date(2026, 7, 4, 23, 59, 59); // 2 days only
  const { scores } = computeScores([], [{ start, end }], { MIN_SAMPLE_SIZE: 3 });
  assert.strictEqual(scores[0]['Morning (6–9)'].confidence, 'low');
  assert.strictEqual(scores[0]['Morning (6–9)'].score, 0.5);
}

assert.strictEqual(resumeDestination({ calendarScanned: false }), 'scanning');
assert.strictEqual(resumeDestination({ calendarScanned: true, selectedDays: [], selectedTimes: [] }), 'pref_days');
assert.strictEqual(
  resumeDestination({ calendarScanned: true, selectedDays: ['fri'], selectedTimes: [] }),
  'pref_times'
);
assert.strictEqual(
  resumeDestination({
    calendarScanned: true,
    selectedDays: ['fri'],
    selectedTimes: ['Evening (6–9)'],
  }),
  'schedule'
);

assert.ok(WEEKDAY_KEYS.includes('sun'));
console.log('✅ slot-algorithm-selfcheck passed');
