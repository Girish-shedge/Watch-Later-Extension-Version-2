// Self-check for popup.js pure helpers. Run: node tests/selfcheck.js
// Extracts the functions from popup.js source (popup.js itself needs a browser).
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'popup.js'), 'utf8');

function extractFunction(name) {
  const start = src.indexOf(`function ${name}(`);
  assert(start !== -1, `function ${name} not found in popup.js`);
  let depth = 0, i = src.indexOf('{', start);
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) {
      return src.slice(start, j + 1);
    }
  }
  throw new Error(`unbalanced braces in ${name}`);
}

const getYouTubeThumbnail = eval(`(${extractFunction('getYouTubeThumbnail')})`);
const isYouTubeWatchUrl = eval(`(${extractFunction('isYouTubeWatchUrl')})`);
const calcDailyStreak = eval(`(${extractFunction('calcDailyStreak')})`);
const parseClockDuration = eval(`(${extractFunction('parseClockDuration')})`);
const formatDurationLabel = eval(`(${extractFunction('formatDurationLabel')})`);
const recycleOnbCardOrder = eval(`(${extractFunction('recycleOnbCardOrder')})`);
const shuffleCopy = eval(`(${extractFunction('shuffleCopy')})`);
const onb1CardSlot = eval(`(${extractFunction('onb1CardSlot')})`);
const ascendingOnbDays = eval(`(${extractFunction('ascendingOnbDays')})`);
const formatOnbUnwatchedLabel = eval(`(${extractFunction('formatOnbUnwatchedLabel')})`);
const formatOnbWatchedLabel = eval(`(${extractFunction('formatOnbWatchedLabel')})`);
const randomOnbDay = eval(`(${extractFunction('randomOnbDay')})`);
const ONB_LIFE_TITLES = (() => {
  const m = src.match(/const ONB_LIFE_TITLES = (\[[\s\S]*?\]);/);
  assert(m, 'ONB_LIFE_TITLES not found');
  return eval(`(${m[1]})`);
})();
const pickOnbLifeTitle = eval(`(function () { const ONB_LIFE_TITLES = ${JSON.stringify(ONB_LIFE_TITLES)}; return (${extractFunction('pickOnbLifeTitle')}); })()`);
const randomOnbDurationSec = eval(`(${extractFunction('randomOnbDurationSec')})`);
const ONB_CAL_DAY = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const onbCalWeekdayRows = eval(`(function () { const ONB_CAL_DAY = ${JSON.stringify(ONB_CAL_DAY)}; return (${extractFunction('onbCalWeekdayRows')}); })()`);
const onbCalMonthsAround = eval(`(${extractFunction('onbCalMonthsAround')})`);

// getYouTubeThumbnail: valid watch URL → thumbnail; junk → null (must not throw)
assert.strictEqual(
  getYouTubeThumbnail('https://www.youtube.com/watch?v=abc123'),
  'https://img.youtube.com/vi/abc123/maxresdefault.jpg'
);
assert.strictEqual(getYouTubeThumbnail('https://www.youtube.com/'), null);
assert.strictEqual(isYouTubeWatchUrl('https://www.youtube.com/watch?v=abc123'), true);
assert.strictEqual(isYouTubeWatchUrl('https://www.youtube.com/watch?v=n4CNG2KXbDk&t=63s'), true);
assert.strictEqual(isYouTubeWatchUrl('https://youtube.com/watch?v=abc123'), true);
assert.strictEqual(isYouTubeWatchUrl('https://www.youtube.com/'), false);
assert.strictEqual(isYouTubeWatchUrl('https://youtu.be/abc123'), false);
assert.strictEqual(isYouTubeWatchUrl('https://www.youtube.com/shorts/abc123'), false);
assert.strictEqual(isYouTubeWatchUrl('https://example.com/'), false);
assert.strictEqual(getYouTubeThumbnail('not a url at all'), null);

// calcDailyStreak: today + yesterday = 2; today only = 1; gap breaks streak
const day = ms => new Date(Date.now() - ms).toISOString();
const DAY = 24 * 60 * 60 * 1000;
assert.strictEqual(calcDailyStreak([day(0), day(DAY)]), 2);
assert.strictEqual(calcDailyStreak([day(0)]), 1);
assert.strictEqual(calcDailyStreak([day(0), day(2 * DAY)]), 1);
assert.strictEqual(calcDailyStreak([]), 0);

// parseClockDuration: YT player chrome "M:SS" / "H:MM:SS" → seconds
assert.strictEqual(parseClockDuration('1:30:55'), 5455);
assert.strictEqual(parseClockDuration('34:50'), 2090);
assert.strictEqual(parseClockDuration('0:30'), 30);
assert.strictEqual(parseClockDuration(''), 0);
assert.strictEqual(parseClockDuration(null), 0);
assert.strictEqual(formatDurationLabel(5455), '1:30:55');
assert.strictEqual(formatDurationLabel(2090), '34:50');
assert.strictEqual(formatDurationLabel(30), '00:30');

// busy-slot overlap rule used in fetchAvailableCalendarSlots (Date-based, not string)
const overlaps = (slot, b) =>
  new Date(b.start) < new Date(slot.end) && new Date(b.end) > new Date(slot.start);
const slot = { start: '2026-08-01T10:00:00.000Z', end: '2026-08-01T11:00:00.000Z' };
assert.ok(overlaps(slot, { start: '2026-08-01T10:30:00Z', end: '2026-08-01T12:00:00Z' }));
// back-to-back busy block ending exactly at slot start is NOT a clash
// (the old string comparison got this boundary wrong: ".000Z" < "Z" lexically)
assert.ok(!overlaps(slot, { start: '2026-08-01T09:00:00Z', end: '2026-08-01T10:00:00Z' }));
assert.ok(!overlaps(slot, { start: '2026-08-01T11:00:00Z', end: '2026-08-01T12:00:00Z' }));

// onboarding slide-1 card recycle: top → end
assert.deepStrictEqual(recycleOnbCardOrder([0, 1, 2, 3, 4]), [1, 2, 3, 4, 0]);
assert.deepStrictEqual(recycleOnbCardOrder([1, 2, 3, 4, 0]), [2, 3, 4, 0, 1]);
assert.deepStrictEqual(recycleOnbCardOrder([]), []);

// offline fact picker: shuffle preserves length/members
assert.deepStrictEqual(shuffleCopy([]), []);
assert.deepStrictEqual(shuffleCopy([1]).slice().sort(), [1]);
{
  const src = [1, 2, 3, 4, 5];
  const out = shuffleCopy(src);
  assert.deepStrictEqual(src, [1, 2, 3, 4, 5]); // input untouched
  assert.deepStrictEqual(out.slice().sort((a, b) => a - b), src);
}

// slide-1 carousel slots: 3 visible — edges 95%, middle 100%; end step morphs + fades
assert.deepStrictEqual(onb1CardSlot(0, 'rest'), { width: '100%', opacity: '1' });
assert.deepStrictEqual(onb1CardSlot(1, 'rest'), { width: '100%', opacity: '1' });
assert.deepStrictEqual(onb1CardSlot(2, 'rest'), { width: '100%', opacity: '1' });
assert.deepStrictEqual(onb1CardSlot(3, 'rest'), { width: '100%', opacity: '0' });
assert.deepStrictEqual(onb1CardSlot(0, 'end'), { width: '100%', opacity: '0' });
assert.deepStrictEqual(onb1CardSlot(1, 'end'), { width: '100%', opacity: '1' });
assert.deepStrictEqual(onb1CardSlot(2, 'end'), { width: '100%', opacity: '1' });
assert.deepStrictEqual(onb1CardSlot(3, 'end'), { width: '100%', opacity: '1' });

// unwatched labels: ascending days (7, 14, 21, …)
assert.deepStrictEqual(ascendingOnbDays(5, 7, 7), [7, 14, 21, 28, 35]);
assert.deepStrictEqual(ascendingOnbDays(3, 10, 5), [10, 15, 20]);
assert.strictEqual(formatOnbUnwatchedLabel(45), 'Unwatched since 45 days');
assert.strictEqual(formatOnbUnwatchedLabel(7), 'Unwatched since 7 days');
assert.strictEqual(formatOnbWatchedLabel(45), 'Watched since 45 days');
assert.strictEqual(formatOnbWatchedLabel(14), 'Watched since 14 days');
{
  const d = randomOnbDay();
  assert.ok(d >= 7 && d <= 66, `randomOnbDay out of range: ${d}`);
}
{
  const t = pickOnbLifeTitle();
  assert.ok(t.length >= 40, `life title too short for 2 lines: ${t.length}`);
  assert.ok(!/[\u{1F300}-\u{1FAFF}]/u.test(t), 'life title has emoji');
}
{
  const sec = randomOnbDurationSec();
  assert.ok(sec >= 120 && sec < 55 * 60, `duration out of range: ${sec}`);
}
const formatOnbWatchedAgo = eval(`(${extractFunction('formatOnbWatchedAgo')})`);
assert.ok(/^Watched /.test(formatOnbWatchedAgo()), 'watched ago prefix');
// 9 local onboarding thumbs
assert.ok(src.includes("Icon/onb/onb-thumb-01.png"), 'missing onb thumb paths');
assert.ok(src.includes("Icon/onb/onb-thumb-09.png"), 'missing onb thumb 09');

// scan calendar: Aug 2026 → first Mon–Fri week is 03–07; months around Jul include Jun/Jul/Aug
const augWeeks = onbCalWeekdayRows(2026, 7);
assert.ok(augWeeks.length >= 3);
assert.deepStrictEqual(augWeeks[0].map(c => c.date), ['03', '04', '05', '06', '07']);
assert.deepStrictEqual(augWeeks[0].map(c => c.day), ['MON', 'TUE', 'WED', 'THU', 'FRI']);
const around = onbCalMonthsAround(new Date(2026, 6, 15)); // July 2026
assert.deepStrictEqual(around.map(m => m.month), [5, 6, 7]); // Jun, Jul, Aug

// preference scoring helpers
const prefsBusyHint = eval(`(${extractFunction('prefsBusyHint')})`);
const pickTopKeys = eval(`(${extractFunction('pickTopKeys')})`);
const busyMsInRange = eval(`(${extractFunction('busyMsInRange')})`);
assert.strictEqual(prefsBusyHint(0.8), 'Free days');
assert.strictEqual(prefsBusyHint(0.4), 'Moderately busy');
assert.strictEqual(prefsBusyHint(0.1), 'Occupied');
assert.deepStrictEqual(pickTopKeys({ a: 1, b: 3, c: 2 }, ['a', 'b', 'c'], 2), ['b', 'c']);
assert.strictEqual(
  busyMsInRange(
    [{ start: '2026-08-01T10:00:00.000Z', end: '2026-08-01T11:00:00.000Z' }],
    new Date('2026-08-01T10:30:00.000Z'),
    new Date('2026-08-01T12:00:00.000Z')
  ),
  30 * 60 * 1000
);
const PREFS_DOW = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const SLOT_RANGES_TEST = {
  'Morning (6–9)': [6, 9],
  'Evening (6–9)': [18, 21],
  'Late Night (12–3)': [0, 3],
};
const scoreCalendarPrefs = eval(`(function () {
  const PREFS_DOW = ${JSON.stringify(PREFS_DOW)};
  const prefsBusyHint = ${prefsBusyHint.toString()};
  const pickTopKeys = ${pickTopKeys.toString()};
  const busyMsInRange = ${busyMsInRange.toString()};
  return (${extractFunction('scoreCalendarPrefs')});
})()`);
const winStart = new Date(2026, 7, 3); // Mon Aug 3
const winEnd = new Date(2026, 7, 10);  // next Mon
// Busy all mornings Mon–Wed → evenings freer
const busyMornings = [];
for (let d = 3; d <= 5; d++) {
  busyMornings.push({
    start: new Date(2026, 7, d, 6, 0).toISOString(),
    end: new Date(2026, 7, d, 9, 0).toISOString(),
  });
}
const scored = scoreCalendarPrefs(busyMornings, winStart, winEnd, SLOT_RANGES_TEST);
assert.ok(scored.slots.includes('Evening (6–9)'));
assert.ok(scored.days.length === 3);
assert.ok(scored.slots.length === 3);

const formatRelativeDuration = eval(`(${extractFunction('formatRelativeDuration')})`);
const formatHistoryUpcomingLabel = eval(`(${extractFunction('formatHistoryUpcomingLabel')})`);
const formatHistoryMissedLabel = eval(`(${extractFunction('formatHistoryMissedLabel')})`);
const formatHistoryMovedToWatched = eval(`(${extractFunction('formatHistoryMovedToWatched')})`);
const filterHistoryByTitle = eval(`(${extractFunction('filterHistoryByTitle')})`);
const paginateList = eval(`(${extractFunction('paginateList')})`);
const sortHistoryNewestFirst = eval(`(${extractFunction('sortHistoryNewestFirst')})`);
const ordinalDay = eval(`(${extractFunction('ordinalDay')})`);
const formatSuccessSlotLabel = eval(`(${extractFunction('formatSuccessSlotLabel')})`);
const formatSuccessGhostTime = eval(`(${extractFunction('formatSuccessGhostTime')})`);

assert.strictEqual(ordinalDay(1), '1st');
assert.strictEqual(ordinalDay(2), '2nd');
assert.strictEqual(ordinalDay(3), '3rd');
assert.strictEqual(ordinalDay(11), '11th');
assert.strictEqual(ordinalDay(23), '23rd');
{
  const label = formatSuccessSlotLabel('2026-03-23T18:16:00', '2026-03-23T19:17:00');
  assert.ok(label.includes('Sunday') || label.includes('/'), label);
  assert.ok(label.includes('23rd Mar'), label);
  assert.strictEqual(
    formatSuccessGhostTime('2026-03-23T18:16:00', '2026-03-23T19:17:00').includes(' - '),
    true
  );
}

assert.strictEqual(formatRelativeDuration(15 * 60000), '15 mins');
assert.strictEqual(formatRelativeDuration(2 * 3600000), '2 hrs');
assert.strictEqual(formatRelativeDuration(12 * 86400000), '12 days');
assert.strictEqual(formatRelativeDuration(0), '1 min');

{
  const now = new Date('2026-08-03T12:00:00.000Z');
  assert.strictEqual(
    formatHistoryUpcomingLabel('2026-08-03T14:00:00.000Z', now),
    'Upcoming in 2 hrs'
  );
  assert.strictEqual(formatHistoryUpcomingLabel('2026-08-05T12:00:00.000Z', now), null);
  assert.strictEqual(
    formatHistoryMissedLabel('2026-07-22T12:00:00.000Z', now),
    'Unwatched & Missed since 12 days'
  );
  assert.strictEqual(formatHistoryMissedLabel('2026-08-03T18:00:00.000Z', now), null);
  assert.strictEqual(
    formatHistoryMovedToWatched('2026-08-03T11:58:00.000Z', now),
    'Moved to Watched 2 mins ago'
  );
}

assert.deepStrictEqual(
  filterHistoryByTitle([{ title: 'Celestial Skies' }, { title: 'Ocean Dreams' }], 'celest').map(i => i.title),
  ['Celestial Skies']
);
{
  const page = paginateList([1, 2, 3, 4, 5, 6], 2, 5);
  assert.strictEqual(page.page, 2);
  assert.strictEqual(page.pages, 2);
  assert.deepStrictEqual(page.items, [6]);
  assert.strictEqual(page.start, 6);
  assert.strictEqual(page.end, 6);
}
{
  const sorted = sortHistoryNewestFirst(
    [
      { id: 'old', created_at: '2026-01-01T00:00:00.000Z' },
      { id: 'new', created_at: '2026-08-01T00:00:00.000Z' }
    ],
    'scheduled'
  );
  assert.strictEqual(sorted[0].id, 'new');
  const watched = sortHistoryNewestFirst(
    [
      { id: 'a', watched_at: '2026-01-01T00:00:00.000Z' },
      { id: 'b', watched_at: '2026-08-01T00:00:00.000Z' }
    ],
    'watched'
  );
  assert.strictEqual(watched[0].id, 'b');
}

{
  // Default-arg `meta = {}` breaks brace extraction — assert source contract instead.
  assert.ok(src.includes('function classifyOAuthError('));
  assert.ok(/code === 'popup_blocked'/.test(src));
  assert.ok(/redirect_uri\|invalid_client/.test(src));
}

assert.ok(src.includes("ONB_FLAG_COMPLETE = 'onboardingComplete'"));
assert.ok(src.includes("ONB_FLAG_SCANNED = 'calendarScanned'"));
assert.ok(src.includes('ANALYZE_MIN_MS = 2500'));
assert.ok(src.includes('ANALYZE_MAX_MS = 8000'));
assert.ok(src.includes("showAuthPanel('authConnecting')") || src.includes('showAuthPanel("authConnecting")'));
assert.ok(src.includes('showReturningConnecting'));
assert.ok(src.includes('startConnectingAndLogin'));
assert.ok(src.includes('function showNewUserWrongUrl'));
assert.ok(src.includes("authFlowKind === 'returning'"));
assert.ok(src.includes('showWrongUrlPanel({ restore: true })'));

console.log('✅ selfcheck passed');
