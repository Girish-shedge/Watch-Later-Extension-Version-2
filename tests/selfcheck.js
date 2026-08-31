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
const ONB_YT_CATALOG = (() => {
  const m = src.match(/const ONB_YT_CATALOG = (\[[\s\S]*?\]);/);
  assert(m, 'ONB_YT_CATALOG not found');
  return eval(`(${m[1]})`);
})();
const ONB_CAL_DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const onbCalWeekdayRows = eval(`(function () { const ONB_CAL_DAY = ${JSON.stringify(ONB_CAL_DAY)}; return (${extractFunction('onbCalWeekdayRows')}); })()`);
const onbCalMonthsAround = eval(`(${extractFunction('onbCalMonthsAround')})`);
const ONB_CAL_ROWS = 3;
const onbCalChunks = eval(`(function () { const ONB_CAL_ROWS = ${ONB_CAL_ROWS}; return (${extractFunction('onbCalChunks')}); })()`);

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
const OFFLINE_FACTS = (() => {
  const m = src.match(/const OFFLINE_FACTS = (\[[\s\S]*?\]);/);
  assert(m, 'OFFLINE_FACTS not found in popup.js');
  return eval(`(${m[1]})`);
})();
assert.ok(OFFLINE_FACTS.length >= 13, 'offline facts pool must hold at least 13 entries');

// slide-1/2 carousel slots: 3 visible at full size; the leaving card (0) and the
// arriving card (3) swap between 100%/opaque and 90%/transparent.
const onbShow = { width: '100%', opacity: '1', transform: 'scale(1)' };
const onbHide = { width: '100%', opacity: '0', transform: 'scale(0.9)' };
assert.deepStrictEqual(onb1CardSlot(0, 'rest'), onbShow);
assert.deepStrictEqual(onb1CardSlot(1, 'rest'), onbShow);
assert.deepStrictEqual(onb1CardSlot(2, 'rest'), onbShow);
assert.deepStrictEqual(onb1CardSlot(3, 'rest'), onbHide);
assert.deepStrictEqual(onb1CardSlot(0, 'end'), onbHide);
assert.deepStrictEqual(onb1CardSlot(1, 'end'), onbShow);
assert.deepStrictEqual(onb1CardSlot(2, 'end'), onbShow);
assert.deepStrictEqual(onb1CardSlot(3, 'end'), onbShow);
// The card that scrolls off must be the same one that comes back in at 90%, or
// the recycled card pops in at full size.
assert.deepStrictEqual(onb1CardSlot(0, 'end'), onb1CardSlot(3, 'rest'));
{
  // No easing with an overshoot anywhere in the card loop — the bounce was removed.
  const loop = src.slice(src.indexOf('function paintOnbCardSlots'), src.indexOf('async function enterOnbCardsThenPlay'));
  assert.ok(!/cubic-bezier\([^)]*\b1\.\d/.test(loop), 'onboarding card loop must not bounce');
  assert.ok(/transform \$\{durationMs\}ms ease-in-out/.test(loop), 'card scale must be eased');
}
{
  // Pain↔Promise copy morph.
  const copy = src.slice(src.indexOf('function paintOnbCopySlots'), src.indexOf('const ONB3_YT_ID'));
  // Both screens must reach the same button geometry. Morphing only the incoming
  // one leaves the outgoing label beside it — a doubled "Next" mid-crossfade.
  assert.ok(/const collapsed = phase === 'enter' \|\| phase === 'exit'/.test(copy),
    'exit must share the collapsed button geometry with enter');
  // A round 50% target desyncs the two primaries by a few px: one is interpolated
  // directly, the other is whatever flex has left over.
  assert.ok(/onb-modal-cta/.test(copy) && /cta\.style\.transform/.test(copy),
    'Pain/Promise CTA slides with heading on crossfade');
  assert.ok(!/flex-end/.test(copy), 'solo Next must not pin right on exit');
  assert.ok(/ease-in-out/.test(copy) && !/cubic-bezier/.test(copy), 'copy morph must be plain ease-in-out');
  const goToSrc = src.slice(src.indexOf('const goTo = async (i'), src.indexOf('onboardingGoTo = goTo'));
  assert.ok(/paintOnbCopySlots\(to, 'enter'/.test(goToSrc), 'incoming copy must be parked before the fade');
  assert.ok(/paintOnbCopySlots\(from, 'exit'/.test(goToSrc) && /paintOnbCopySlots\(to, 'settle'/.test(goToSrc),
    'both screens animate the copy morph');
  assert.ok(/morphCopy && forward && i === 1\) playOnbModalEnter\(to\)/.test(goToSrc),
    'Promise must replay modal entry after Pain crossfade');
  assert.ok(/promiseShellOnly/.test(goToSrc) && /is-modal-shell-only/.test(goToSrc),
    'Promise crossfade must hide copy until modal entry runs');
}
{
  // The secondary is squeezed to zero width, so its label has to clip.
  const css = fs.readFileSync(path.join(__dirname, '..', 'style.css'), 'utf8');
  const btn = css.slice(css.indexOf('.onb-btn {'), css.indexOf('.onb-btn:hover'));
  assert.ok(/overflow: hidden/.test(btn), '.onb-btn must clip its label');
  assert.ok(/white-space: nowrap/.test(btn), '.onb-btn-inner must not reflow while narrow');
}
{
  // Both tickers animate the step change; the incoming one is rewound first,
  // otherwise its markup already has the destination dot wide and nothing moves.
  const goTo = src.slice(src.indexOf('const goTo = async (i'), src.indexOf('onboardingGoTo = goTo'));
  assert.ok(/setOnbTickerActive\(to, Math\.min\(current, 1\), \{ instant: true \}\)/.test(goTo));
  assert.ok(/tickIndex = Math\.min\(i, 1\)/.test(goTo));
  assert.ok(/setOnbTickerActive\(to, tickIndex\)/.test(goTo) && /setOnbTickerActive\(from, tickIndex\)/.test(goTo));
  assert.ok(goTo.indexOf('setOnbTickerActive(to, tickIndex)') < goTo.indexOf('await wait(TRANS_MS)'),
    'dots must animate during the crossfade, not after it');
}

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
  assert.strictEqual(ONB_YT_CATALOG.length, 6, 'onboarding catalog has 6 YouTube videos');
  assert.ok(ONB_YT_CATALOG.every(v => v.id && v.title && v.thumb && v.durationSec > 0),
    'each catalog entry needs id, title, thumb, durationSec');
}
const formatOnbPainLabel = eval(`(function () {
  const ONB_YT_CATALOG = ${JSON.stringify(ONB_YT_CATALOG)};
  return (${extractFunction('formatOnbPainLabel')});
})()`);
assert.ok(/^Unwatched since \d+ days$/.test(formatOnbPainLabel(ONB_YT_CATALOG[0])), 'pain label uses catalog days');

// scan calendar: Aug 2026 starts Saturday → first week Mon–Fri blank, Sat 01 Sun 02
const augWeeks = onbCalWeekdayRows(2026, 7);
assert.ok(augWeeks.length >= 3);
assert.deepStrictEqual(augWeeks[0].map(c => c.date), ['', '', '', '', '', '01', '02']);
assert.deepStrictEqual(augWeeks[0].map(c => c.inMonth), [false, false, false, false, false, true, true]);
assert.deepStrictEqual(augWeeks[0].map(c => c.day), ['', '', '', '', '', 'Sat', 'Sun']);
const augLast = augWeeks[augWeeks.length - 1];
assert.deepStrictEqual(augLast.map(c => c.date), ['31', '', '', '', '', '', '']);
assert.ok(augLast[0].inMonth && augLast.slice(1).every(c => c.empty && !c.inMonth));
const around = onbCalMonthsAround(new Date(2026, 6, 15)); // July 2026
assert.deepStrictEqual(around.map(m => m.month), [5, 6, 7]); // Jun, Jul, Aug
const augChunks = onbCalChunks(augWeeks);
assert.strictEqual(augChunks.length, 2, 'Aug 2026 has 6 weeks → 2×3-row pages');
assert.deepStrictEqual(augChunks[0][0].map(c => c.date), ['', '', '', '', '', '01', '02']);
assert.ok(augChunks[1].some(row => row.some(c => c.inMonth && c.date === '31')), 'second page still scans Aug 31');
assert.ok(src.includes('CAL_FADE_MS = 400'), 'calendar fade must pair with --cal-fade-ms');
assert.ok(src.includes('CAL_CELL_MS = 260'), 'calendar cell hold must pair with --cal-cell-ms');
assert.ok(!src.includes('onbCalScanPromise'), 'decorative scan must not gate the real analyze Promise.all');
assert.ok(!src.includes('is-no-month'), 'out-of-month cells are empty chips, not overflow-date no-month');
assert.ok(src.includes('is-empty'), 'out-of-month cells render as empty chips');
{
  const css = fs.readFileSync(path.join(__dirname, '..', 'style.css'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'popup.html'), 'utf8');
  assert.ok(css.includes('--blur-cal-month-fade: 1px'), 'side month labels LAYER_BLUR is 1px');
  assert.ok(css.includes('--shadow-cal-scanned: 0 2px 0 0 #eddbff, 0 4px 6px 0 rgba(102, 71, 240, 0.35)'),
    'scanned cell drop shadows must match Figma 418:976');
  assert.ok(css.includes('--shadow-cal-cell: 0 2px 0 0 #d9d9d9, 0 4px 6px 0 rgba(102, 71, 240, 0)'),
    'not-scanned ledge shadow (transparent glow so box-shadow can interpolate)');
  assert.ok(!css.includes('--shadow-cal-date-inset'), 'cal date inner shadow removed');
  assert.ok(css.includes('--cal-fade-ms: 400ms'), '--cal-fade-ms must pair with CAL_FADE_MS');
  assert.ok(css.includes('--cal-cell-ms: 260ms'), '--cal-cell-ms must pair with CAL_CELL_MS');
  assert.ok(css.includes('--cal-cell-scan-scale'), 'active scan cell scales up');
  assert.ok(css.includes('calCellIn'), 'cell label swap fades in');
  assert.ok(css.includes('.cal-cell-inner'), 'day cells swap inner content only');
  assert.ok(!css.includes('calGridOut'), 'white grid shell must not fade out');
  assert.ok(css.includes('--gradient-auth-warn-banner'), 'shared auth warn banner fill gradient');
  assert.ok(css.includes('.auth-warn-banner::before'), 'auth banner gradient inner stroke (643:10880)');
  assert.ok(css.includes('cal-month-track'), 'month slider is a translating carousel track');
  assert.ok(css.includes('--type-cal-date: 800 16px/20px'), 'cal day date is 16/20 Extrabold (643:10849)');
  assert.ok(css.includes('#onbAnalyzeSheet .auth-heading-row') && css.includes('flex-wrap: nowrap'),
    'scan sheet heading stays one row like Figma headingLine3');
  assert.ok(!/^\s*border:\s*1px solid white/m.test(css.slice(css.indexOf('.cal-day-cell {'), css.indexOf('.cal-day-cell .cal-date'))),
    'day cells use tokenized white border');
  assert.ok(html.includes('calMonthTrack'), 'carousel track lives in the analyzing sheet');
  assert.ok(html.includes('cal-grid-stack'), 'date crossfade clones into .cal-grid-stack');
  assert.ok(!html.includes('cal-test'), 'calendar lives in the analyzing modal, not a separate test page');
}

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
  assert.ok(label.includes('•'), label);
  assert.ok(/23\/03/.test(label), label);
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
  // Figma 116:4021 — 5 rows/page, and the list slot must reserve exactly that many.
  assert.ok(/HISTORY_PAGE_SIZE = 5\b/.test(src), 'history page size must be 5');
  assert.ok(
    src.includes('rows | Page ${page.page} of ${page.pages}'),
    'pager label must carry the page counter'
  );
  const css = fs.readFileSync(path.join(__dirname, '..', 'style.css'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'popup.html'), 'utf8');
  assert.ok(
    /--history-list-h:\s*calc\(\s*\(5 \* var\(--history-row-h\)\)/.test(css),
    'list slot must reserve 5 rows so the panel height never jumps'
  );
  assert.ok(css.includes('--history-panel-h: 436px'), 'history panel height locked to Figma 436');
  assert.ok(html.includes('id="historyTabs"'), 'history uses segmented tabs');
  assert.ok(!html.includes('historySearchInput'), 'history search must be removed');
  assert.ok(!html.includes('historyFilterMenu'), 'history dropdown filter must be removed');
  assert.ok(html.includes('Forced (0)'), 'forced tab label must be Forced');
  assert.ok(!html.includes('Needs Attention'), 'Needs Attention label must not return');
  // Modals and bottom sheets are 12 on all four sides. The 12/12/8 variant kept
  // reappearing from Figma frames that still carry the old bottom inset.
  assert.ok(
    !/padding:\s*var\(--space-3\)\s+var\(--space-3\)\s+var\(--space-2\)/.test(css),
    'modal padding must be 12 all sides, not 12/12/8'
  );
  assert.ok(!css.includes('--pad-modal-'), 'per-side modal padding tokens must stay removed');
  // Sheet padding contract: every bottom sheet / modal panel uses --space-3 (12).
  for (const sel of [
    '\n.onb-modal {',
    '\n.sched-sheet {',
    '\n.prefs-sheet {',
    '\n.wrong-url-panel {',
    '\n.offline-panel {',
    '\n.history-panel {',
    '\n.success-panel {',
    '\n.profile-panel,',
    '\n.auth-sheet-body {',
  ]) {
    const i = css.indexOf(sel);
    assert.ok(i >= 0, `missing sheet rule ${sel}`);
    const block = css.slice(i, css.indexOf('}', i) + 1);
    assert.ok(
      /padding:\s*var\(--space-3\)/.test(block),
      `${sel.trim()} must force padding: var(--space-3) (12 all sides)`
    );
  }

  // Offline modal · Figma 645:13974 — burgundy fact card, secondary CTA, 13-fact pool.
  assert.ok(css.includes('--offline-hero-h: 170.5px'), 'offline hero height token');
  assert.ok(css.includes('--offline-fact-fade-ms: 550ms'), 'offline fact fade token');
  assert.ok(css.includes('--color-offline-fact-start: #9f5750'), 'offline burgundy fact gradient start');
  assert.ok(css.includes('--color-offline-fact-end: #663833'), 'offline brown fact gradient end');
  assert.ok(css.includes('--color-offline-fact-green-start: #a5bfb1'), 'offline green fact gradient start');
  assert.ok(css.includes('.offline-fact-shell.is-green'), 'offline green fact shell variant');
  assert.ok(src.includes('function setOfflineFactTheme'), 'offline fact theme alternates');
  assert.ok(css.includes('--type-offline-badge: 600 13px/18px'), 'offline badge Sub-Text 13/18 token');
  assert.ok(html.includes('DO YOU KNOW ?'), 'offline badge copy');
  assert.ok(!html.includes('<img class="offline-hero-bg"'), 'offline hero must not use baked PNG (grid only)');
  assert.ok(html.includes('class="offline-hero-bg"'), 'offline hero grid layer');
  assert.ok(/OFFLINE_FACT_MS = 5000/.test(src), 'offline fact hold must be 5s');
  assert.ok(/OFFLINE_FACT_FADE_MS = 550/.test(src), 'offline fact fade ms must pair with CSS');
  assert.ok(src.includes('function probeNetworkOnline'), 'offline connectivity probe');
  assert.ok(src.includes('function wireOfflineNetworkOnce'), 'offline network wiring');
  {
    const tryBtn = html.indexOf('id="tryAgainBtn"');
    assert.ok(tryBtn > 0, 'offline Try again button');
    assert.ok(
      html.slice(Math.max(0, tryBtn - 80), tryBtn + 40).includes('onb-btn-secondary'),
      'offline Try again uses secondary button'
    );
  }
  assert.ok(/\.offline-panel[\s\S]*box-shadow:\s*var\(--shadow-modal\)/.test(css), 'offline panel modal shadow');

  // Typography: Figma set via tokens; old Be Vietnam Pro must not return.
  assert.ok(
    !/Be\+Vietnam|Be Vietnam Pro|Be Vitenam/i.test(css),
    'Be Vietnam Pro must stay removed — use Proxima Nova'
  );
  for (const tok of [
    '--type-heading: 700 26px/32px',
    '--type-highlight:',
    '--type-button: 700 14px/16px',
    '--type-subtext:',
    '--type-label:',
    '--tracking-heading: -0.02em',
    '--tracking-highlight: -0.02em',
    '--tracking-button: -0.004em',
    '--tracking-body: -0.008em',
    '--tracking-subtext: -0.01em',
    '--tracking-label: -0.014em',
    "--font-condensed: 'Proxima Nova'",
  ]) {
    assert.ok(css.includes(tok), `missing type token ${tok}`);
  }
  assert.ok(css.includes('--type-body: 600 16px/22px'), 'Body Text is 16/22 per Figma');
  assert.ok(css.includes('--type-subtext: 600 13px/18px'), 'Sub-Text is 13/18 per Figma text style');
  assert.ok(css.includes("@font-face"), 'Proxima Nova must be bundled via @font-face');
  assert.ok(css.includes('fonts/Proxima-Nova-Regular.ttf'), 'Proxima Nova Regular font file referenced');
  assert.ok(!css.includes('Barlow Semi Condensed'), 'Barlow fallback removed after Proxima Nova bundle');
  assert.ok(css.includes('.text-date {') || css.includes('.text-date,'), 'text-date utility for calendar numbers');
  assert.ok(css.includes('.text-sm {'), 'text-sm utility class');
  assert.ok(css.includes('.text-body {') || css.includes('.text-body,'), 'text-body utility class');
  assert.ok(css.includes('--heading-line-h: 32px'), 'Pain/Promise heading line is 32px');
  assert.ok(css.includes('--onb-modal-enter-ms'), 'onboarding modal entry motion token must exist');
  assert.ok(src.includes('function playOnbModalEnter'), 'Pain/Promise lines must enter via playOnbModalEnter');
  assert.ok(css.includes('onbChipLand'), 'pink chip must land 0°→-2°');
  assert.ok(css.includes('onbModalCtaIn'), 'modal CTA must slide in after lines');
  assert.ok(html.includes('onb-text-frame'), 'onbTextFrame maps to onb-text-frame');
  assert.ok(html.includes('Stop saving everything and start watching what</p>'), 'Promise copy matches Figma 546:16896');
  assert.ok(html.includes('>unwatched</p>') && !html.includes('>of unwatched</p>'), 'Pain copy matches Figma 531:958');
  assert.ok(!html.includes('id="onbPromiseBack"'), 'Promise screen is Next-only per Figma 546:16896');
  assert.ok(css.includes('--onb-heading-row-gap: 6px'), 'Pain/Promise heading chip gap is 6');
  assert.ok(css.includes('--onb-chip-rot: -2deg'), 'pink in-text chip rotation is -2deg');
  assert.ok(css.includes('--type-onb-duration: 600 4px/4px'), 'duration chip is Semibold 4/4');
  assert.ok(css.includes('--color-btn-sheen-end: rgba(255, 255, 255, 0)'),
    'inner fill fades white@20% to transparent');
  assert.ok(css.includes('--color-btn-inner-border: rgba(255, 255, 255, 0.9)'),
    'primary inner stroke starts at white@90%');
  assert.ok(css.includes('--color-btn-inner-border-secondary: #ffffff'),
    'secondary inner stroke starts at white (541:15814)');
  assert.ok(css.includes('--pad-btn-shell: 4px'), 'primary shell pad is 4px');
  assert.ok(css.includes('--pad-btn-shell-secondary: 4px'), 'secondary shell pad is 4px (541:15814)');
  assert.ok(css.includes('--btn-stroke-w: 1.5px'), 'primary stroke is 1.5px');
  assert.ok(css.includes('--btn-stroke-w-secondary: 1.5px'), 'secondary stroke is 1.5px (541:15814)');
  assert.ok(/\.onb-btn-secondary \.onb-btn-inner[\s\S]*background:\s*linear-gradient/.test(css),
    'secondary inner uses sheen gradient like primary (541:15814)');
  assert.ok(css.includes('.onb-btn-secondary:hover'), 'secondary hover matches primary');
  assert.ok(css.includes('--auth-warn-banner-stroke-w: 1.6px'), 'auth banner border 1.6px (643:10880)');
  assert.ok(css.includes('--type-auth-banner'), 'auth banner Sub-Text 13/18 token');
  assert.ok(css.includes('--auth-warn-banner-grad-stop'), 'auth banner fill gradient stop (643:10880)');
  assert.ok(css.includes('.auth-warn-banner::before'), 'auth banner gradient inner stroke');
  assert.ok(css.includes('.delete-heading[hidden]'), 'multi delete must hide single heading');
  assert.ok(/\.profile-stats\s*\{[^}]*margin-bottom:\s*-20px/.test(css),
    'stats card overlaps journey banner');
  assert.ok(css.includes('--icon-stroke-w: 1.2px'), 'global icon stroke token');
  assert.ok(css.includes('auth-warn-banner--video'), 'video title banner variant (545:16510)');
  assert.ok(css.includes('--btn-h: 40px'), 'button outer height is 40px');
  assert.ok(css.includes('fonts/Proxima-Nova-Bold.ttf'), 'Proxima Nova Bold bundled for weight 700');
  assert.ok(css.includes('.history-row-actions .onb-btn.icon-only'), 'history hover uses onb-btn icon-only at --btn-h');
  assert.ok(css.includes('.onb-btn-inner::before'),
    'primary inner stroke uses outside pseudo ring');
  const typoUtils = css.slice(css.indexOf('/* Typography utilities'), css.indexOf('.onb-duration,'));
  assert.ok(
    typoUtils.includes('.onb-title {') && typoUtils.includes('font: var(--type-highlight)'),
    'card title is Highlight 18/22 via .text-highlight utility group'
  );
  assert.ok(
    typoUtils.includes('.onb-label,') && typoUtils.includes('font: var(--type-subtext)'),
    'card stamp is Sub-Text 13/18 via .text-subtext utility group'
  );
  assert.ok(html.includes('your time'), 'Promise chip copy is “your time”');
  assert.ok(html.includes('>matters,</p>') && html.includes('>on</p>'), 'Promise row splits matters/on per Figma 546:16896');
  assert.ok(!html.includes('data-onb-goto="2"'), 'onboarding ticker must not have a third dot');
  assert.ok(html.includes('Revoke anytime from permission page'), 'permissions revoke copy matches Figma 532:2514');
  assert.ok(!html.includes('onbPermsClose'), 'permissions must not use schedule close chrome');
  assert.ok(/id="onboardingPermissions"[\s\S]*?class="onb-cards"/.test(html), 'permissions uses card stack not schedule chrome');
  assert.ok(css.includes('--radius-screen: 0'), 'main popup screen radius is 0');
  assert.ok(css.includes('--radius-modal: 12px'), 'modal/sheet radius is 12px per Figma 499+');
  assert.ok(css.includes('--radius-sched-video-title: 16px'), 'sched video title frame bottom radius is 16px');
  assert.ok(css.includes('--sched-title-frame-h-1: 46px'), 'sched 1-line title band height');
  assert.ok(css.includes('--sched-title-frame-h-2: 68px'), 'sched 2-line title band height');
  assert.ok(html.includes('sched-title-frame-bg-1'), 'sched 1-line Figma SVG band');
  assert.ok(html.includes('sched-title-frame-bg-2'), 'sched 2-line Figma SVG band');
  assert.ok(!html.includes('sched-title-scrim'), 'legacy CSS blur scrim removed');
  assert.ok(!css.includes('sched-title-scrim'), 'legacy scrim CSS removed');
  assert.ok(/function paintSchedTitleFrame/.test(src), 'paintSchedTitleFrame picks 1- vs 2-line band');
  assert.ok(/function schedTitleFitsOneLine/.test(src), 'nowrap width probe for 1-line band');
  assert.ok(/function schedulePaintSchedTitleFrame/.test(src), 'defer title band until layout/fonts');
  assert.ok(css.includes('.sched-video-title') && css.includes('min-width: 0'), 'title wraps inside flex band');
  assert.ok(!/function schedTitleTruncateToLines/.test(src), 'JS must not drop whole words for title truncate');
  assert.ok(/-webkit-line-clamp:\s*2/.test(css) && /text-overflow:\s*ellipsis/.test(css),
    'sched title uses CSS ellipsis / line-clamp');
  assert.ok(/function schedTitleCanMeasure/.test(src), 'sched title must not rAF-loop while hidden');
  assert.ok(/function bailInitPopupSkeleton/.test(src), 'initPopup must escape skeleton on auth failure');
  assert.ok(/\.sched-video-title\s*\{[\s\S]*?word-break:\s*normal/.test(css), 'sched title wraps at word boundaries only');
  assert.ok(/class="sched-video"[\s\S]*?sched-title-frame/.test(html), 'title band sits on sched-video card');
  {
    const durStart = css.indexOf('.sched-duration {');
    const durEnd = css.indexOf('.sched-duration span {', durStart);
    const durBlock = css.slice(durStart, durEnd);
    assert.ok(!durBlock.includes('backdrop-filter'), 'sched duration pill is flat white, no glass');
  }
  assert.ok(css.includes('--color-onb-unwatched: #fa463d'), 'Pain stamp uses Figma Alert #FA463D');
  assert.ok(css.includes('--color-onb-watched: #029431'), 'Promise stamp uses Figma Success #029431');
  assert.ok(css.includes('--radius-onb-modal: 16px'), 'Pain/Promise modal radius is 16px per Figma radius-4');
  assert.ok(html.includes('onb-screen-bg'), 'Pain/Promise per-screen background layers');
  assert.ok(html.includes('onb-pain-grid.png'), 'Pain screen uses exported onbGrid PNG');
  assert.ok(html.includes('onb-promise-grid.png'), 'Promise screen uses exported onbGrid PNG');
  assert.ok(html.includes('onb-pain-vignette.png') && html.includes('onb-pain-ellipse.png'),
    'Pain screen uses exported vignette + ellipse PNGs');
  assert.ok(html.includes('onb-promise-vignette.png') && html.includes('onb-promise-ellipse.png'),
    'Promise screen uses exported vignette + ellipse PNGs');
  assert.ok(!html.includes('onb-grid-wash--pain') && !html.includes('onb-grid-wash--promise'),
    'Pain/Promise must not use CSS gradient wash layers');
  assert.ok(html.includes('Revoke anytime from permission page'), 'perms revoke note matches Figma 532:2514');
  assert.ok(html.includes('Icon/auth-koala-sprite.png'), 'perms cards use Figma authKoala sprite');
  assert.ok(html.includes('Icon/perms-num1.png'), 'perms cards use exported num PNGs');
  assert.ok(html.includes('onb-sheet-overlay'), 'onboarding child sheets use slide overlay wrapper');
  assert.ok(/id="onboardingPromise"[\s\S]*?id="onbPermsOverlay"/.test(html),
    'calendar permissions sheet stacks on Promise screen');
  assert.ok(src.includes('function openPromisePermsSheet'), 'Promise Next opens permissions overlay');
  assert.ok(src.includes('PERMS_CARD_ENTER_MS') && src.includes('PERMS_CARD_STAGGER_MS'),
    'permissions card cascade has JS timing constants');
  assert.ok(css.includes('--onb-perm-enter-ms: 450ms') && css.includes('--onb-perm-stagger-ms: 140ms'),
    'permissions card cascade CSS tokens');
  assert.ok(css.includes('is-perms-entering'), 'permissions cards stagger in after sheet lands');
  assert.ok(src.includes('QUEUE_CARD_ENTER_MS') && src.includes('QUEUE_CARD_STAGGER_MS'),
    'queue intercept card cascade has JS timing constants');
  assert.ok(css.includes('--queue-card-enter-ms: 450ms') && css.includes('--queue-card-stagger-ms: 140ms'),
    'queue intercept card cascade CSS tokens');
  assert.ok(css.includes('is-cards-entering'), 'queue cards stagger in after sheet lands');
  assert.ok(css.includes('--queue-grad-now') && css.includes('--queue-grad-adding'),
    'queue card gradients from Figma 645:14322 / 645:14327');
  assert.ok(css.includes('--queue-cal-now-left') && css.includes('--queue-cal-add-top'),
    'queue calendar placement tokens from Figma');
  assert.ok(css.includes('queueCardSlideIn'), 'queue cards slide in with ease-in-out');
  assert.ok(html.includes('onb-info-icon') && html.includes('stroke="currentColor"'),
    'permissions info icon matches revoke subtext color');
  assert.ok(css.includes('#onbPermsSheet.auth-sheet'), 'permissions sheet uses Figma 532:2481 layout');
  assert.ok(html.includes('onb-perm-label text-sm'), 'permission cards use Label 12/16 type');
  assert.ok(/\.onb-perm-label b[\s\S]*?font-weight:\s*700/.test(css),
    'permission card keywords (FIND TIME / SCHEDULE / REMIND) must be Bold');
  assert.ok(css.includes('--gradient-sheet-backdrop'), 'all sheets share #3A3A3A→#fff @75% blur');
  {
    const allowBlock = src.slice(src.indexOf('if (permsAllow)'), src.indexOf("document.querySelectorAll('[data-onb-goto]')"));
    const realAllow = allowBlock.slice(allowBlock.indexOf('if (transitioning)'));
    assert.ok(/await startConnectingAndLogin\(\)/.test(realAllow),
      'Allow opens connecting over permissions sheet');
    assert.ok(!/closeOnbSheet/.test(realAllow),
      'Allow must not close permissions before connecting');
  }
  assert.ok(css.includes('.onb-sheet-overlay.is-open .onb-sheet-slot'), 'onboarding sheets slide in like other modals');
  assert.ok(/revealPostAuthScheduleSkeleton/.test(src),
    'post-auth watch path shows schedule skeleton before calendar scan');
  assert.ok(/finishPostAuthScan[\s\S]{0,3200}await initPopup\(\)/.test(src),
    'post-auth loads schedule after scan sheet closes');
  assert.ok(src.includes('function mountAnalyzeOverlay'), 'analyze sheet stacks on schedule frame');
  assert.ok(css.includes('.auth-flow-host.is-open .auth-panel'), 'auth panels slide in on open');
  assert.ok(css.includes('border-radius: var(--radius-onb-modal) var(--radius-onb-modal) 0 0'), 'auth video uses 16px top radius');
  assert.ok(html.includes('onb-grid-bg'), 'onboarding grid overlay per Figma 432:528');
  assert.ok(html.includes('wrong-url-browser-mock.png'), 'wrong URL uses Figma 533:9884 browser mock');
  assert.ok(html.includes('class="wua-sheet"') || html.includes("class='wua-sheet'"), 'wrong URL end is one sheet (browser + body)');
  assert.ok(html.includes('class="wua-fall"'), 'wrong URL fall cards bg (533:9884)');
  assert.ok(!html.includes('class="wua-bg"'), 'wrong URL must not use legacy wua-bg class');
  assert.ok(css.includes('height: 194.4px'), 'wrong URL browser height 194.4');
  assert.ok(css.includes('gap: var(--space-2); /* 8 — Figma 533:10013'), 'wrong URL copy gap 8');
  assert.ok(/\.wua-panel\s*\{[\s\S]*?align-items:\s*center/.test(css), 'wrong URL panel content centered');
  assert.ok(/\.wrong-url-copy\s*\{[\s\S]*?align-items:\s*center/.test(css), 'wrong URL copy column centered');
  assert.ok(html.includes('lib/translate.js'), 'popup loads shared translate helper');
  assert.ok(src.includes('function translateToEnglish'), 'non-Latin titles translate to English');
  assert.ok(src.includes('textNeedsTranslation'), 'translate skips Latin-only text');
  assert.ok(src.includes('fetchCurrentYouTubeDescription'), 'calendar event can include translated description');
  assert.ok(
    fs.readFileSync(path.join(__dirname, '..', 'lib', 'translate.js'), 'utf8').includes('translate.googleapis.com'),
    'uses free Google translate endpoint'
  );
  assert.ok(html.includes('>Scheduled</span>') && html.includes('>successfully</span>'),
    'success heading is Scheduled + successfully (541:15067)');
  assert.ok(html.includes('>Scheduling</span>') && html.includes('>failed</span>'),
    'fail heading is Scheduling + failed (541:15659)');
  assert.ok(!html.includes('to your Google Calendar</span>'), 'outcome headings dropped second line');
  assert.ok(!html.includes("Couldn't"), 'fail heading no longer uses Couldn\'t schedule…');
  assert.ok(
    css.includes('#onboardingPermissions > .auth-sheet .auth-copy'),
    'perms gap:0 must not leak onto remounted auth error panels'
  );
  assert.ok(html.includes('prefs-slot-column'), 'prefs chips live in slot column per Figma 499');
  assert.ok(!html.includes('prefs-status'), 'prefs status banner removed per Figma 499');
  assert.ok(css.includes('--color-sched-prefs-bg'), 'schedule prefs lavender chip token (532:2764)');
  assert.ok(css.includes('--color-sched-prefs-btn-bg'), 'Change Preferences btn fill (533:6011)');
  assert.ok(css.includes('--pad-screen-t: var(--space-2)'), 'schedule screen top pad 8');
  assert.ok(css.includes('--pad-screen-x: var(--space-2)'), 'schedule/modal L/R inset 8');
  assert.ok(css.includes('--pad-screen-b: var(--space-2)'), 'schedule/modal bottom inset 8');
  assert.ok(css.includes('--frame-h: 499px'), 'single-session frame for 8/8/8 pad');
  assert.ok(src.includes('8 + 44 + 16 + 172.514'), 'multi frame height uses 8px top pad');
  assert.ok(css.includes('--blur-sheet-backdrop: 2px'), 'sheet backdrop blur is 2px');
  assert.ok(css.includes('var(--gradient-sheet-backdrop)'), 'sheet backdrop uses gradient overlay');
  assert.ok(css.includes('--prefs-nav-icon-size: 28px'), 'prefs header icons 28');
  assert.ok(css.includes('#prefsDayHeader .prefs-header-back'), 'day prefs back stays at 0% opacity');
  assert.ok(html.includes('prefsTimeHeaderBackBtn'), 'time prefs uses header back');
  assert.ok(!html.includes('prefsTimeBackBtn'), 'time prefs bottom Back removed');
  assert.ok(css.includes('--sched-slot-selected-stroke-w: 1.6px'), 'selected slot inner stroke');
  assert.ok(css.includes('.nav-icon-btn'), 'shared nav icon decor (575:199)');
  const schedSheetRule = css.slice(css.indexOf('#schedSheet.sched-sheet {'), css.indexOf('#schedSheet.sched-sheet {') + 200);
  assert.ok(!schedSheetRule.includes('position: absolute'), 'schedule sheet is flex-flow per Figma 434:1153');

  // Hover controls animate, so they cannot go back to display:none, and the
  // row must not keep a static gap that a collapsed actions column would eat.
  const actions = css.slice(css.indexOf('.history-row-actions {'));
  assert.ok(
    !/^\s*display:\s*none/m.test(actions.slice(0, actions.indexOf('}'))),
    'history row actions must stay displayed so the slide can transition'
  );

  // Both cross-fades are driven by a JS timeout that has to outlast the CSS.
  const cssMs = (re, label) => {
    const m = css.match(re);
    assert.ok(m, `${label} duration not found in style.css`);
    return Math.round(parseFloat(m[1]) * 1000);
  };
  const jsMs = (re, label) => {
    const m = src.match(re);
    assert.ok(m, `${label} not found in popup.js`);
    return Number(m[1]);
  };
  assert.ok(
    jsMs(/HISTORY_SWAP_MS = (\d+)/, 'HISTORY_SWAP_MS') >=
      cssMs(/\.history-list\s*\{[^}]*transition:\s*opacity ([\d.]+)s/, 'list fade'),
    'page-turn repaint must wait for the list fade-out to finish'
  );
  assert.ok(/MODAL_ANIM_MS = SHEET_SLIDE_MS/.test(src), 'MODAL_ANIM_MS must alias SHEET_SLIDE_MS');
  assert.ok(
    jsMs(/SHEET_SLIDE_MS = (\d+)/, 'SHEET_SLIDE_MS') >=
      Number((css.match(/--sheet-slide-ms:\s*([\d.]+)ms/) || [])[1]),
    'closeOverlay must hold the node until the shared sheet slide-out ends'
  );
  // All bottom sheets share sheetSlide* — no scale+fade, no same-sheet prefs morph.
  assert.ok(css.includes('sheetSlideIn'), 'sheets must slide in from bottom');
  assert.ok(css.includes('sheetSlideOut'), 'sheets must slide out on close');
  assert.ok(!css.includes('modalPanelIn'), 'scale+fade modal panel must stay removed');
  assert.ok(!src.includes('fadeSheetChildren'), 'same-sheet morph fade helpers must be gone');
  assert.ok(!src.includes('schedSuccessSkel'), 'success skeleton bridge must be gone');
  assert.ok(!src.includes('prefsCollapsedBox'), 'prefs morph box helpers must be gone');
  assert.ok(!src.includes('applyPrefsSheetBox'), 'prefs must not morph #schedSheet');
  assert.ok(
    jsMs(/ONB_MODAL_ENTER_MS = (\d+)/, 'ONB_MODAL_ENTER_MS') ===
      Math.round(parseFloat((css.match(/--onb-modal-enter-ms:\s*([\d.]+)ms/) || [])[1])),
    'ONB_MODAL_ENTER_MS must match --onb-modal-enter-ms'
  );
  assert.ok(
    jsMs(/ONB_MODAL_STAGGER_MS = (\d+)/, 'ONB_MODAL_STAGGER_MS') ===
      Math.round(parseFloat((css.match(/--onb-modal-enter-stagger:\s*([\d.]+)ms/) || [])[1])),
    'ONB_MODAL_STAGGER_MS must match --onb-modal-enter-stagger'
  );
  assert.ok(
    jsMs(/QUEUE_CARD_ENTER_MS = (\d+)/, 'QUEUE_CARD_ENTER_MS') ===
      Math.round(parseFloat((css.match(/--queue-card-enter-ms:\s*([\d.]+)ms/) || [])[1])),
    'QUEUE_CARD_ENTER_MS must match --queue-card-enter-ms'
  );
  assert.ok(
    jsMs(/QUEUE_CARD_STAGGER_MS = (\d+)/, 'QUEUE_CARD_STAGGER_MS') ===
      Math.round(parseFloat((css.match(/--queue-card-stagger-ms:\s*([\d.]+)ms/) || [])[1])),
    'QUEUE_CARD_STAGGER_MS must match --queue-card-stagger-ms'
  );
  {
    const html = fs.readFileSync(path.join(__dirname, '..', 'popup.html'), 'utf8');
    assert.ok(/id="schedPrefsOverlay"/.test(html), 'prefs must be a separate overlay sheet');
    assert.ok(
      /id="schedPrefsOverlay"[\s\S]*?id="schedPrefsPanel"/.test(html),
      'prefs panels must live inside #schedPrefsOverlay'
    );
  }
  {
    const tok = css.match(/--sheet-slide-ms:\s*([\d.]+)ms/);
    assert.ok(tok, 'shared sheet slide token not found');
    assert.ok(css.includes('--motion-ease: ease-in-out'), 'global motion easing token');
    assert.ok(
      /sheetSlideIn var\(--sheet-slide-ms\) var\(--motion-ease\)/.test(css),
      'sheet slide must use --motion-ease'
    );
    assert.ok(
      jsMs(/SHEET_SLIDE_MS = (\d+)/, 'SHEET_SLIDE_MS') >= Number(tok[1]),
      'SHEET_SLIDE_MS must match --sheet-slide-ms'
    );
    assert.ok(/PROFILE_SLIDE_MS = PROFILE_ENTER_MS/.test(src), 'profile uses success-style enter timing');
    assert.ok(/PROFILE_ENTER_MS = SUCCESS_ENTER_MS/.test(src), 'profile enter matches success enter');
    assert.ok(/MODAL_ANIM_MS = SHEET_SLIDE_MS/.test(src), 'modals must use shared sheet slide');
    assert.ok(
      !/SUCCESS_SLIDE_MS = SHEET_SLIDE_MS/.test(src),
      'success/fail outcome sheets use --success-enter-ms, not shared sheet slide'
    );
    assert.ok(css.includes('--sched-thumb-enter-ms: 300ms'), 'schedule thumb enter token');
    assert.ok(/SCHED_THUMB_ENTER_MS = 300/.test(src), 'schedule thumb enter JS constant');
    assert.ok(css.includes('schedThumbSweep'), 'schedule thumb sweep keyframes');
    assert.ok(css.includes('.is-sched-entering .sched-thumb'), 'schedule enter targets thumb');
    assert.ok(css.includes('.is-sched-entering .multi-session-card'), 'schedule enter animates multi session cards');
    assert.ok(/function revealScheduleScreen/.test(src), 'revealScheduleScreen helper');
  }
  assert.ok(
    /function animateProfileStatCount/.test(src),
    'profile stats must count 0→N with ease-in-out'
  );
  assert.ok(/PROFILE_COUNT_MS = SUCCESS_STAR_MS/.test(src), 'profile count ms pairs with star ms');
  assert.ok(
    /is-entering:not\(\.is-stacked-under\) \.profile-star/.test(css),
    'profile enter animates stars'
  );
  assert.ok(!/is-entering[^\n]*profile-stat-value/.test(css), 'stat numbers use JS count-up, not CSS fade');
  assert.ok(!css.includes('profileCardIn'), 'profile must not cascade section fades');
  assert.ok(css.includes('--profile-grad-cover: 75%'), 'profile gradient cover ends at 75%');
  assert.ok(html.includes('id="profileCloseBtn"') && html.includes('profile-close-icon'), 'profile close is Figma 643:3336 grey glass btn + inline X');
  assert.ok(css.includes('--color-profile-close-bg: #e6e6e6'), 'profile close fill token');
  assert.ok(css.includes('--blur-profile-close: 40px'), 'profile close backdrop blur token');
  assert.ok(!/\.profile-row:hover\s*\{/.test(css), 'profile rows must not hover wash — Figma 643:3311');
  assert.ok(/\.profile-row-icon[\s\S]*?background:\s*transparent/.test(css), 'profile row icons have no bg');
  assert.ok(css.includes('#historyBackBtn') && /#historyBackBtn[\s\S]{0,80}opacity:\s*0/.test(css), 'history back is layout-only at 0% opacity');
  assert.ok(src.includes('function paintSlotGridSkeleton'), 'prefs save must skeletonize single-session slots');
  assert.ok(css.includes('--sched-sheet-h-compact: 234px'), '1-slot / no-slot sheet height token');
  assert.ok(css.includes('--sched-slot-area-h: 116px'), 'compact slot list height');
  assert.ok(css.includes('.is-slots-stack-2'), '2-slot compact sheet height');
  assert.ok(css.includes('.sched-slots.is-stack'), '1–2 slot stack layout');
  assert.ok(css.includes('.sched-slot--empty'), 'no-slot empty card chrome');
  assert.ok(src.includes('function resolveSlotEmptyCopy'), 'context-specific no-slot copy');
  assert.ok(!/greet\},\\nPlease/.test(src), 'empty slot body must not force line break after greeting');
  assert.ok(src.includes("params.get('slots')"), 'preview slots=0|1|2|4 flag');
  assert.ok(css.includes('--btn-stroke-w-gift'), 'gift outside stroke token');
  assert.ok(css.includes('profile-gift'), 'profile gift button styles');
  assert.ok(css.includes('--blur-profile-backdrop'), 'profile black blur backdrop token');
  assert.ok(src.includes('Referrals coming soon!'), 'gift toast copy');
  assert.ok(src.includes('function startProfilePreviewLoop'), 'profile preview loop');
  assert.ok(src.includes('function startOfflinePreviewLoop'), 'offline preview loop');
  {
    const html = fs.readFileSync(path.join(__dirname, '..', 'popup.html'), 'utf8');
    assert.ok(!/id="profileOverlay"\s+class="[^"]*\bwl-modal\b/.test(html), 'profile must not use .wl-modal');
    assert.ok(html.includes('id="profileGiftBtn"'), 'profile gift button markup');
    assert.ok(html.includes('profile-grid'), 'profile uses CSS grid wash');
    assert.ok(!html.includes('menu-effect.svg'), 'legacy profile effect SVG must be gone');
  }
  // Toast · 380:7845 — top-right slide; hold then exit.
  assert.ok(css.includes('--toast-bottom-inset: 40px'), 'toast sits 40px above bottom');
  assert.ok(css.includes('bottom: var(--toast-bottom-inset)'), 'toast anchored bottom center');
  assert.ok(css.includes('toastSlideIn'), 'toast must slide in');
  assert.ok(css.includes('toastSlideOut'), 'toast must slide out on dismiss');
  assert.ok(
    /@keyframes toastSlideIn[\s\S]*translate\(-50%,\s*var\(--toast-slide-travel\)\)/.test(css),
    'toast slides up from below'
  );
  {
    const hold = css.match(/--toast-hold-ms:\s*([\d.]+)ms/);
    const slide = css.match(/--toast-slide-ms:\s*([\d.]+)ms/);
    assert.ok(hold, 'toast hold token not found');
    assert.ok(slide, 'toast slide token not found');
    assert.ok(
      jsMs(/TOAST_MS = (\d+)/, 'TOAST_MS') >= Number(hold[1]),
      'showToast hold must match --toast-hold-ms'
    );
    assert.ok(
      jsMs(/TOAST_SLIDE_MS = (\d+)/, 'TOAST_SLIDE_MS') >= Number(slide[1]),
      'showToast exit hold must match --toast-slide-ms'
    );
  }
  assert.ok(
    /showToast\([^)]+,\s*'(success|error|info)'\)/.test(src),
    'toasts must pass an explicit success|error|info type'
  );
  assert.ok(!/showToast\(['"][^'"]*[✅❌⚠️🔒]/.test(src), 'toast copy must not carry emoji prefixes');
}
{
  const css = fs.readFileSync(path.join(__dirname, '..', 'style.css'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'popup.html'), 'utf8');
  const src = fs.readFileSync(path.join(__dirname, '..', 'popup.js'), 'utf8');
  const pairMs = (jsRe, cssRe, label) => {
    const js = src.match(jsRe);
    const tok = css.match(cssRe);
    assert.ok(js, `${label} not found in popup.js`);
    assert.ok(tok, `${label} token not found in style.css`);
    assert.strictEqual(Number(js[1]), Math.round(parseFloat(tok[1])), `${label} must match CSS token`);
  };
  // Figma 541:15067 — front card rim is green; enter cascade tokens pair with JS.
  assert.ok(/--color-success-card-border:\s*#9bff9d/i.test(css), 'success card border must be green #9bff9d');
  assert.ok(css.includes('successCardGhost'), 'success ghost card must rotate from 0');
  assert.ok(css.includes('successCopyIn'), 'success copy must slide in');
  assert.ok(css.includes('successStarIn'), 'success stars must scale+rotate in');
  assert.ok(css.includes('--success-grad-cover'), 'success grad must end mid-panel per Figma');
  assert.ok(/background-size:\s*100%\s*var\(--success-grad-cover\)/.test(css), 'success grad uses cover token');
  assert.ok(/successCardGhost[\s\S]*rotate\(2deg\)/.test(css), 'ghost card rest +2°');
  assert.ok(/successCardFront[\s\S]*rotate\(-2deg\)/.test(css), 'front card rest -2°');
  assert.ok(css.includes('.success-overlay.is-open.is-closing .success-card--ghost'), 'exit must hold card state');
  pairMs(/SUCCESS_ENTER_MS = (\d+)/, /--success-enter-ms:\s*([\d.]+)ms/, 'SUCCESS_ENTER_MS');
  assert.ok(/SUCCESS_SLIDE_MS = SUCCESS_ENTER_MS/.test(src), 'SUCCESS_SLIDE_MS must match SUCCESS_ENTER_MS');
  pairMs(/SUCCESS_COPY_MS = (\d+)/, /--success-copy-ms:\s*([\d.]+)ms/, 'SUCCESS_COPY_MS');
  pairMs(/SUCCESS_COPY_STAGGER_MS = (\d+)/, /--success-copy-stagger:\s*([\d.]+)ms/, 'SUCCESS_COPY_STAGGER_MS');
  assert.ok(css.includes('successCardTextIn'), 'card text must fade in after shell');
  pairMs(/SUCCESS_CARD_TEXT_MS = (\d+)/, /--success-card-text-ms:\s*([\d.]+)ms/, 'SUCCESS_CARD_TEXT_MS');
  pairMs(/SUCCESS_CARD_MS = (\d+)/, /--success-card-ms:\s*([\d.]+)ms/, 'SUCCESS_CARD_MS');
  pairMs(/SUCCESS_STAR_MS = (\d+)/, /--success-star-ms:\s*([\d.]+)ms/, 'SUCCESS_STAR_MS');
  assert.ok(!html.includes('success-topo.png'), 'topo BG must stay deleted from success/fail HTML');
  assert.ok(!html.includes('success-sparkle'), 'legacy sparkles must stay deleted');
  assert.ok(
    html.includes('Google Calendar will remind you 15 minutes before the scheduled time.'),
    'success body copy must match Figma 541:15067'
  );
  assert.ok(
    !html.includes('Scheduled. Google Calendar will remind you 15 minutes before.'),
    'legacy success body copy must be gone'
  );
}
{
  // Figma 380:5204 — schedule failure gets its own v2 sheet, not the dead v1 inline screen.
  const css = fs.readFileSync(path.join(__dirname, '..', 'style.css'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'popup.html'), 'utf8');
  assert.ok(html.includes('id="failOverlay"'), 'fail overlay must exist');
  assert.ok(html.includes('id="failPanel"'), 'fail panel must exist');
  assert.ok(!/#failOverlay[\s\S]*success-star/.test(html), 'fail overlay must not include stars');
  assert.ok(!html.includes('id="failureScreen"'), 'legacy v1 failure screen must be gone');
  assert.ok(!html.includes('id="retryLink"'), 'legacy v1 retry link must be gone');
  assert.ok(src.includes('function showScheduleFailModal'), 'showScheduleFailModal must exist');
  assert.ok(src.includes('function closeScheduleFailModal'), 'closeScheduleFailModal must exist');
  assert.ok(css.includes('#failPanel'), 'fail panel styling must exist');
  assert.ok(css.includes('.fail-card-error'), 'fail card error text styling must exist');
}
{
  // History empty states — Figma two-line heading+subtext, not the old one-liner.
  const css = fs.readFileSync(path.join(__dirname, '..', 'style.css'), 'utf8');
  assert.ok(css.includes('.history-empty-heading'), 'history empty heading style must exist');
  assert.ok(css.includes('.history-empty-sub'), 'history empty subtext style must exist');
  assert.ok(src.includes('history-empty-heading'), 'paintHistoryPage must render the two-line empty state');
  // .history-pager sets display: flex unconditionally, which beats the hidden attribute
  // the same way .profile-persona[hidden] did — needs its own override.
  assert.ok(
    /\.history-pager\[hidden\]\s*\{[^}]*display:\s*none/.test(css),
    'history pager must have a [hidden] override or an empty tab keeps showing "0-0 of 0 rows"'
  );
}
{
  // Profile journey banner — Figma 643:3182 / 643:3790 / 671:18962 / 671:19188 (replaces completion-rate trend).
  const html = fs.readFileSync(path.join(__dirname, '..', 'popup.html'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '..', 'style.css'), 'utf8');
  const qSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'queue-projection.js'), 'utf8');
  assert.ok(html.includes('id="profileScheduled"') && html.includes('id="profileBannerText"'),
    'profile stats use Scheduled + journey banner');
  assert.ok(!html.includes('id="profileWaiting"') && !html.includes('id="profileTrendShell"'),
    'old Waiting / completion-trend banner must stay gone');
  assert.ok(css.includes('.profile-banner.is-green'), 'cleared queue uses green celebration banner');
  assert.ok(css.includes('--profile-trend-shell-end'), 'trend banner outer shell matches Figma 671:18895');
  assert.ok(html.includes('id="profileBannerText"') && html.includes('text-sm'), 'trend banner copy uses Label 12/16');
  assert.ok(css.includes('--profile-stats-w: 300px'), 'stats card width from Figma');
  assert.ok(!src.includes('function completionTrend'), 'completion-rate trend removed from profile');
  assert.ok(qSrc.includes('function resolveProfileCardState'), 'profile card state lives in WLQueue');
  assert.ok(qSrc.includes('function profileCardCopy'), 'profile card copy lives in WLQueue');
  assert.ok(src.includes('PROFILE_PREVIEW_STATES'), 'profile preview cycles journey states');
}
{
  // Feedback modal stacks over profile; writes to existing public.feedback table.
  const html = fs.readFileSync(path.join(__dirname, '..', 'popup.html'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '..', 'style.css'), 'utf8');
  assert.ok(css.includes('.feedback-count.is-over'), 'feedback over-limit count turns red');
  assert.ok(css.includes('--feedback-field-h: 240px'), 'feedback field wrap height');
  assert.ok(src.includes('FEEDBACK_MAX = 250'), 'feedback max 250 characters');
  assert.ok(src.includes('function finishFeedbackSend'), 'feedback send closes modal before toast');
  assert.ok(css.includes('feedback-heading-block'), 'feedback heading block per Figma 533:4985');
  assert.ok(!html.includes('maxlength="200"'), 'feedback cap enforced in JS so over-limit toast can fire');
  assert.ok(
    /id="feedbackOverlay"\s+class="feedback-overlay/.test(html) &&
      !/id="feedbackOverlay"[^>]*\bwl-modal\b/.test(html),
    'feedback must use its own overlay path, not shared .wl-modal'
  );
  assert.ok(src.includes('setProfileStackedUnder(true)'), 'openFeedbackModal must freeze profile before opening');
  assert.ok(
    /function openFeedbackModal[\s\S]*?setTimeout\(\s*\(\)\s*=>\s*input\?\.focus\(\)/.test(src),
    'feedback must focus the textarea after the slide lands'
  );
  assert.ok(css.includes('.profile-overlay.is-stacked-under .profile-backdrop'), 'stacked modals must keep profile backdrop under child');
  assert.ok(
    /\.profile-overlay\.is-stacked-under \.profile-backdrop[\s\S]{0,280}opacity:\s*1/.test(css),
    'stacked profile backdrop must stay visible (no schedule flash)'
  );
  assert.ok(css.includes('.profile-overlay.is-stacked-under .profile-content'), 'stacked profile must freeze content cascade');
  assert.ok(css.includes('.profile-overlay.is-entering:not(.is-stacked-under)'), 'profile cascade must only run during entry');
  assert.ok(
    /profile-overlay\.is-open:not\(\.is-closing\) \.profile-panel[\s\S]{0,80}transform:\s*translateY\(0\)/.test(css),
    'open profile panel must stay at translateY(0) after is-entering ends'
  );
  assert.ok(
    /profile-overlay\.is-open:not\(\.is-closing\) \.profile-backdrop[\s\S]{0,80}opacity:\s*1/.test(css),
    'open profile backdrop must hold opacity after is-entering ends'
  );
  assert.ok(!src.includes("row.id === 'feedbackBtn' || row.id === 'logoutBtn'"), 'profile rows must not dismiss profile before opening child sheets');
  for (const openFn of ['openFeedbackModal', 'openLogoutModal', 'openHistoryModal']) {
    const start = src.indexOf(`function ${openFn}`);
    const block = src.slice(start, src.indexOf('\n}', start) + 2);
    assert.ok(block.includes('setProfileStackedUnder(true)'), `${openFn} must stack over profile`);
  }
  assert.ok(
    /async function openSchedPrefs[\s\S]{0,250}setProfileStackedUnder\(true\)/.test(src),
    'openSchedPrefs must stack over profile'
  );
  assert.ok(src.includes('function releaseProfileStackAfterSlide'), 'child close must delay profile unstack');
  for (const closeFn of ['closeFeedbackModal', 'closeLogoutModal', 'closeHistoryModal', 'closeSchedPrefs']) {
    const start = src.indexOf(`function ${closeFn}`);
    assert.ok(start >= 0, `${closeFn} missing`);
    let depth = 0;
    let end = src.indexOf('{', start);
    for (let j = end; j < src.length; j++) {
      if (src[j] === '{') depth++;
      else if (src[j] === '}' && --depth === 0) { end = j + 1; break; }
    }
    const block = src.slice(start, end);
    assert.ok(block.includes('releaseProfileStackAfterSlide()'), `${closeFn} must delay profile unstack through slide-out`);
    assert.ok(!block.includes('setProfileStackedUnder(false)'), `${closeFn} must not unstack profile mid-slide`);
  }
  assert.ok(
    !/function closeSchedPrefs[\s\S]*?schedPrefsPanel[\s\S]*?classList\.add\('hidden'\)/.test(src),
    'closeSchedPrefs must not hide day/time panels before the slide-out finishes'
  );
  assert.ok(/type:\s*'text'/.test(src), 'feedback modal insert must set type text');
  assert.ok(!css.includes('top: 58px'), 'prefs sheet must bottom-anchor without a top pin');
  assert.ok(css.includes('--prefs-chip-rot: -1deg'), 'prefs day/time chip rotation is -1deg');
  assert.ok(css.includes('--color-prefs-banner-bg:'), 'prefs sunday/night-owl banner bg token');
  assert.ok(css.includes('--shadow-prefs-banner:'), 'prefs banner shadow token');
  assert.ok(!src.includes("hint.textContent = 'Occupied'"), 'prefs busy hints must not flip on selection');
  assert.ok(html.includes('prefs-day-chip">Day</'), 'day prefs uses pink Day chip');
  assert.ok(html.includes('prefs-day-chip">Time</'), 'time prefs uses pink Time chip');
  assert.ok(css.includes('--prefs-day-name-w: 80px'), 'prefs chip label width token');
  assert.ok(css.includes('width: var(--prefs-day-name-w)'), 'prefs chip label uses 80px token');
  assert.ok(css.includes('--prefs-banner-check-size: 32px'), 'prefs banner toggle is 32px');
  assert.ok(css.includes('min-height: 24px'), 'sched sheet header is 24px');
  assert.ok(css.includes('width: 78.755px'), 'sched logo matches Figma 628:1314');
  assert.ok(css.includes('justify-content: center'), 'prefs slot label inner is centered');
  assert.ok(css.includes('--color-history-tabs-bg-start: #f2f2f2'), 'history tabs gradient start');
  assert.ok(css.includes('--shadow-history-tab:'), 'history active tab shadow');
  assert.ok(css.includes('--history-nav-icon-size: 28px'), 'history nav icons 28');
  assert.ok(css.includes('--color-history-row-sub: #808080'), 'history row sub Text-Secondary');
  assert.ok(!src.includes('setPrefsHeaderBackVisible'), 'prefs no longer hide back from schedule');
  assert.ok(src.includes('PREFS_CHECK_SVG_SPACER'), 'prefs chip has invisible right check spacer');
  assert.ok(css.includes('.prefs-day-check--spacer'), 'prefs chip spacer check is hidden');
  assert.ok(!css.includes('.prefs-banner-inner'), 'prefs banner is a single row shell');
  assert.ok(html.includes('Save &amp; Next'), 'day prefs CTA is Save & Next');
  assert.ok(html.includes('prefs-scan-banner'), 'prefs calendar scan banner on day/time steps');
  assert.ok(html.includes('Auto fetch slots via calendar scan'), 'prefs scan banner copy');
  assert.ok(html.includes('prefs-scan-trigger'), 'prefs scan banner click target');
  assert.ok(src.includes("triggeredBy: 'prefs-banner'"), 'prefs banner scan applies algorithm suggestions');
  assert.ok(src.includes("'At least select one day'"), 'day prefs validation toast');
  assert.ok(src.includes("'At least select one time slot'"), 'time prefs validation toast');
  assert.ok(src.includes('startPrefsCalendarScan'), 'prefs banner opens calendar scan flow');
  assert.ok(css.includes('--prefs-panel-h: 428px'), 'prefs sheet height matches Figma 643:9532');
  assert.ok(src.includes("finishFeedbackSend('Feedback sent'"), 'feedback success closes modal then toasts Feedback sent');
  assert.ok(html.includes('girishshedge54@gmail.com'), 'feedback placeholder must include support email');
  assert.ok(src.includes('feedbackState.overLimitToasted'), 'over-limit toast fires once per overflow');
  assert.ok(src.includes("count.classList.toggle('is-over', over)"), 'feedback count shows real length when over');
}
{
  // Forced tab must also catch a still-live video whose title changed, not just time-drift/removal.
  // Compare English forms so HI/MR titles stored as EN don't false-flag as renamed.
  assert.ok(
    /liveEn\s*!==\s*storedEn/.test(src) && src.includes('translateToEnglish(meta.title)'),
    'oEmbed check must compare English live vs stored titles to catch renames'
  );
  assert.ok(src.includes('were renamed'), 'empty-state copy must mention renamed videos now that detection exists');
}
{
  // Auth warn banners — Figma 418:1083 / 171:800 / 171:934 built in CSS (icon + Sub-Text), not PNG exports.
  const html = fs.readFileSync(path.join(__dirname, '..', 'popup.html'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '..', 'style.css'), 'utf8');
  for (const png of ['auth-warn-banner-privacy.png', 'auth-warn-banner.png', 'auth-warn-banner-why.png']) {
    assert.ok(!html.includes(png), `auth warn banner must not reference ${png}`);
  }
  assert.ok(html.includes('auth-warn-banner-icon'), 'auth warn banners must inline the info icon');
  assert.ok(html.includes('auth-warn-banner-text'), 'auth warn banners must use built text');
  assert.ok(css.includes('.auth-warn-banner-text'), 'auth warn banner text style must exist');
  assert.ok(src.includes("setAnalyzeBanner('default')"), 'analyzing banner must use default built chrome');
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

// Untrusted strings reaching innerHTML in the privileged popup page.
const escapeHistoryHtml = eval(`(${extractFunction('escapeHistoryHtml')})`);
const safeExternalUrl = eval(`(${extractFunction('safeExternalUrl')})`);
assert.strictEqual(
  escapeHistoryHtml('<img src=x onerror="alert(1)">'),
  '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;'
);
assert.strictEqual(escapeHistoryHtml(null), '');
assert.ok(!/[<>]/.test(escapeHistoryHtml('</span><script>evil()</script>')));
// The referral UI (the only place another user's display name reached innerHTML)
// is gone; keep it gone rather than re-escaping it later.
assert.ok(!/openEnterReferralModal|openReferFriendModal/.test(src), 'referral UI must stay deleted');
// History row hrefs: escaping alone still lets a javascript: URL fire on click.
assert.strictEqual(
  safeExternalUrl('https://www.youtube.com/watch?v=abc123'),
  'https://www.youtube.com/watch?v=abc123'
);
assert.strictEqual(safeExternalUrl('javascript:alert(1)'), '#');
assert.strictEqual(safeExternalUrl('data:text/html,<script>alert(1)</script>'), '#');
assert.strictEqual(safeExternalUrl('  javascript:alert(1)'), '#');
assert.strictEqual(safeExternalUrl(''), '#');
assert.strictEqual(safeExternalUrl(null), '#');
assert.ok(src.includes('escapeHistoryHtml(safeExternalUrl(item.video_url))'), 'href must be scheme-checked');

{
  const bgSrc = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
  // Other installed extensions can message us; 'login' opens a Google consent window.
  assert.ok(bgSrc.includes('sender.id !== chrome.runtime.id'), 'background must reject foreign senders');
  assert.ok(bgSrc.includes('interactive_in_popup'), 'background login must reject non-silent (popup owns interactive OAuth)');
  assert.ok(bgSrc.includes('enqueueOAuthFlow'), 'background Google refresh must serialize OAuth');
  assert.ok(bgSrc.includes("'completeLogin'") || bgSrc.includes('"completeLogin"'), 'background must accept popup OAuth completion');

  const oauthSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'google-oauth.js'), 'utf8');
  assert.ok(oauthSrc.includes('auth_oauth_lock'), 'OAuth flows must share auth_oauth_lock across popup + background');

  const html = fs.readFileSync(path.join(__dirname, '..', 'popup.html'), 'utf8');
  assert.ok(html.includes('lib/google-oauth.js'), 'popup must load google-oauth for interactive login');
  assert.ok(src.includes('function runGoogleOAuthFlow'), 'popup must run silent vs interactive OAuth');
  assert.ok(src.includes('completeLoginWithGoogleTokens'), 'interactive OAuth must complete via background');
  assert.ok(bgSrc.includes('crypto.randomUUID()'), 'OAuth nonce must be cryptographic');
  assert.ok(!/Math\.random\(\)/.test(bgSrc), 'Math.random must not build auth params');

  const mf = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'manifest.json'), 'utf8'));
  // Any web-accessible resource lets every site fingerprint the extension.
  assert.ok(!mf.web_accessible_resources, 'no web_accessible_resources expected');
  assert.ok(mf.key, 'extension id must stay pinned (OAuth redirect URI + CORS origin)');
  assert.ok(
    !mf.host_permissions.some(h => h.includes('/auth/')),
    'host_permissions must be URL patterns, not OAuth scopes'
  );
  assert.ok(
    mf.host_permissions.some(h => h.includes('translate.googleapis.com')),
    'host_permissions must allow free Google Translate for non-Latin titles'
  );
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
assert.ok(src.includes('showWrongUrlFallAnim()'), 'logged-in wrong URL uses 533:9884 fall modal');
assert.ok(!/showWrongUrlPanel\(\{\s*restore:\s*true\s*\}\)/.test(src), 'logged-in wrong URL must not restore schedule snapshot overlay');
// Full erase ("remember" unchecked) must not resurrect onboardingComplete — that
// flag is what skips Pain/Promise and opens Connecting for returning users.
assert.ok(
  !/storage\.local\.clear[\s\S]{0,200}ONB_FLAG_COMPLETE[\s\S]{0,80}true/.test(src),
  'full logout wipe must not re-set onboardingComplete after clear'
);

// ── Profile menu (218:1834 / 116:4508) ───────────────────────────────────────
{
  const css = fs.readFileSync(path.join(__dirname, '..', 'style.css'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'popup.html'), 'utf8');
  // Every SLOT_RANGES bucket needs badge copy. Keying personas off the bucket
  // LABEL silently missed, because those labels use en dashes.
  const ranges = {};
  src.replace(/const SLOT_RANGES = \{([\s\S]*?)\};/, (_, body) => {
    body.replace(/"([^"]+)":\s*\[(\d+),\s*(\d+)\]/g, (__, name, start) => {
      ranges[name] = Number(start);
      return '';
    });
    return '';
  });
  const personas = {};
  src.replace(/const SLOT_PERSONAS = \{([\s\S]*?)\};/, (_, body) => {
    body.replace(/(\d+):\s*'([^']+)'/g, (__, hour, label) => {
      personas[Number(hour)] = label;
      return '';
    });
    return '';
  });
  assert.strictEqual(Object.keys(ranges).length, 7, 'expected 7 slot buckets');
  Object.entries(ranges).forEach(([name, start]) => {
    assert.ok(personas[start], `no persona badge for bucket ${name} (start ${start})`);
  });

  // The pink chip is .onb-chip { display: inline-flex }, which beats [hidden].
  assert.ok(
    css.includes('.profile-persona[hidden]'),
    'empty persona chip must be explicitly hidden'
  );
  assert.ok(
    css.includes('.profile-close') && /\.profile-close[\s\S]{0,120}z-index:\s*3/.test(css),
    'profile close must sit above head/stats so it stays clickable'
  );
  assert.ok(html.includes('id="logoutOverlay"'), 'logout confirm overlay missing');
  assert.ok(html.includes('logout-koala-hero.png'), 'logout hero image missing');
  assert.ok(
    css.includes('.logout-overlay') && css.includes('z-index: 59'),
    'logout overlay must stack above profile menu'
  );
  assert.ok(
    !/function openLogoutModal[\s\S]{0,400}favourite-modal/.test(src),
    'openLogoutModal must not use the legacy favourite-modal builder'
  );
  assert.ok(
    !/profilePanel[\s\S]{0,400}closeProfileMenu\(\)/.test(src),
    'profile child rows must not dismiss the profile menu'
  );
  // Menu rows reuse the ids the schedule screen already wires up.
  ['viewHistory', 'slotPreferences', 'feedbackBtn', 'logoutBtn'].forEach(id => {
    assert.ok(html.includes(`id="${id}"`), `profile menu row ${id} missing`);
  });
  // Requirement 1: flat black 25%, no glass.
  assert.ok(!css.includes('schedGlassRefract'), 'top-nav glass filter must be gone');
  assert.ok(!html.includes('schedGlassRefract'), 'glass SVG filter must be removed from popup.html');
  assert.ok(html.includes('id="navAvatar"'), 'top-nav must carry the Google avatar');
  // Deleting a video is confirmed first, on every history tab.
  assert.ok(src.includes('function deleteHistoryItem'), 'delete entry point missing');
  assert.ok(
    /function deleteHistoryItem[\s\S]{0,400}deleteConfirmOverlay/.test(src),
    'deleteHistoryItem must open the confirm sheet before removing anything'
  );
}

{
  const algoSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'slot-algorithm.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'popup.html'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '..', 'style.css'), 'utf8');
  assert.ok(algoSrc.includes('function computeSessionPlan'), 'multi-session plan helper must exist in slot-algorithm.js');
  assert.ok(src.includes('function fetchMultiSessionSlots'), 'multi-session slot fetch must exist');
  assert.ok(algoSrc.includes('validateSessionPlan'), 'duplicate slot gate must exist');
  assert.ok(html.includes('id="schedMultiHome"'), 'multi-session schedule UI must exist');
  assert.ok(html.includes('multi-session-cards-shell'), 'multi-session card shell must wrap session cards');
  assert.ok(src.includes("isMulti ? 'Select Slot' : 'Select Time Slot'"), 'sheet label must switch for multi-session');
  assert.ok(html.includes('id="regenerateSlotsBtn"'), 'Regenerate List button must exist');
  assert.ok(html.includes('id="scheduleMultiBtn"'), 'Schedule Video button must exist');
  assert.ok(html.includes('id="markWatchedConfirmOverlay"'), 'mark-watched confirm modal must exist');
  assert.ok(html.includes('id="deleteSingleHeading"'), 'single delete heading must exist');
  assert.ok(html.includes('id="deleteMultiHeading"'), 'multi delete heading must exist');
  assert.ok(html.includes('This will delete all'), 'multi delete copy must match Figma 545:16478');
  assert.ok(html.includes('No, I missed few'), 'mark-watched cancel must match Figma 545:16509');
  assert.ok(!html.includes('No, I missed some'), 'old mark-watched cancel copy must be gone');
  assert.ok(css.includes('.delete-heading-line'), 'confirm sheets must use two-line heading rows');
  assert.ok(html.includes('Forced (0)'), 'forced tab must use Forced label');
  assert.ok(!html.includes('Needs Attention'), 'Needs Attention UI label must stay gone');
  assert.ok(algoSrc.includes('formatSessionLengthWhy'), 'Why sheet must format session length');
  assert.ok(html.includes('id="multiSessionWhyOverlay"'), 'Why sheet overlay must exist');
  assert.ok(src.includes('function openMultiSessionWhySheet'), 'Why button must open bottom sheet');
  assert.ok(!html.includes('multiSessionWhyTip'), 'Why tooltip must not return');
  assert.ok(html.includes('data-skel="schedule-multi"'), 'multi-session initial skeleton must exist');
  assert.ok(src.includes('function paintMultiSessionCardsSkeleton'), 'regenerate must skeletonize slot cards');
  assert.ok(src.includes('function paintScheduleMultiSkeleton'), 'multi-session load skeleton must match session count');
  assert.ok(!css.match(/\.sched-screen\.is-multi-session[\s\S]{0,120}?gap:\s*var\(--space-2\)/), 'multi schedule screen must use 16px gap like single-session');
  assert.ok(src.includes('function applyPopupFrameHeight'), 'multi-session must resize popup frame');
  assert.ok(css.includes('z-index: 0'), 'multi-session banner must sit behind card shell');
  assert.ok(!css.includes('multi-session-cards') || !css.match(/\.multi-session-cards[\s\S]*overflow-y:\s*auto/), 'multi-session cards must not scroll — frame grows instead');
  assert.ok(src.includes('function regenerateMultiSessionSlots'), 'regenerate must be a shared handler');
  assert.ok(src.includes('excludeSlotKeys'), 'regenerate must exclude current slots to find alternatives');
  assert.ok(src.includes('Complete all sessions first'), 'disabled schedule must explain why');
  assert.ok(src.includes('function rescheduleHistoryGroup'), 'Forced-tab reschedule must exist');
  assert.ok(src.includes('function groupHistoryForDisplay'), 'history must group by session_group_id');
  assert.ok(src.includes("Forced (${forced})"), 'UI must show Forced tab label with count');
  assert.ok(src.includes('function startHistoryPreviewLoop'), 'history preview loop must exist');
  assert.ok(src.includes('function openHistoryConfirmPreview'), 'history confirm preview must exist');
  assert.ok(src.includes("confirmKinds = ['single-delete', 'multi-delete', 'mark-watched']"), 'history preview must cycle confirm sheets');
  assert.ok(src.includes('No forced videos here'), 'Forced empty heading from Figma');
  assert.ok(html.includes('lib/queue-projection.js'), 'popup loads shared queue projection helper');
  assert.ok(html.includes('id="queueInterceptOverlay"'), 'queue intercept overlay must exist');
  assert.ok(html.includes('Schedule instead') && html.includes('View playlist'), 'queue intercept CTAs');
  assert.ok(html.includes('queue-cal-art') && html.includes('Icon/queue/queue-cal-now.png'),
    'queue cards use Figma-exported calendar art at measured positions');
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'Icon/queue/queue-cal-now.png')), 'queue now calendar PNG');
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'Icon/queue/queue-cal-adding.png')), 'queue adding calendar PNG');
  assert.ok(!html.includes('queue-card-now.png') && !html.includes('queue-card-adding.png'),
    'queue card PNG exports must stay gone');
  assert.ok(!html.includes('queue-koala-now') && !html.includes('queue-koala-adding'),
    'cropped koala card art must stay gone');
  assert.ok(html.includes('id="profileScheduled"') && html.includes('id="profileClear"') && html.includes('id="profileBannerText"'),
    'profile stats are Scheduled + To clear + journey banner');
  assert.ok(!html.includes('id="profileWaiting"') && !html.includes('id="profilePace"'),
    'old waiting/pace cells must stay gone');
  assert.ok(!html.includes('id="profileWatched"'),
    'old watched profile cell must stay gone');
  assert.ok(src.includes('function gateQueueIntercept'), 'queue intercept gate must exist');
  assert.strictEqual((src.match(/gateQueueIntercept/g) || []).length, 3,
    'gateQueueIntercept = 1 def + single + multi schedule only');
  {
    const i = src.indexOf('async function rescheduleHistoryGroup');
    const j = src.indexOf('\nasync function ', i + 1);
    assert.ok(i >= 0 && !src.slice(i, j > i ? j : i + 4000).includes('gateQueueIntercept'),
      'Forced-tab reschedule must not fire the queue intercept');
  }
  assert.ok(!src.includes("needs_attention"), 'queue must not use a status column');
  assert.ok(!src.match(/computeSessionPlan\([^)]*\)\.length/), 'session count is plan.sessionCount, not .length');
  assert.ok(src.includes("del('queue_intercept_state')"), 'full logout must wipe queue intercept cooldown');
  {
    const qSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'queue-projection.js'), 'utf8');
    assert.ok(!qSrc.includes("chip: 'days'") && !qSrc.includes('few extra') && !qSrc.includes("chip: 'past'"),
      'days/past copy tiers must stay gone');
    assert.ok(qSrc.includes("chip: 'a month'") && qSrc.includes("chip: '3 months'"),
      'month and 3-month intercept chips must exist');
    assert.ok(qSrc.includes('plan.sessionCount'), 'sessionsAdded must read sessionCount');
  }
  assert.ok(src.includes('function restoreSupabaseSession'), 'session restore must use shared refresh lock');
  assert.ok(src.includes('auth_refresh_lock'), 'refresh lock key must exist');
  assert.ok(src.includes('showReturningConnecting()'), 'session expiry must reconnect via showReturningConnecting');
  assert.ok(
    /performLogout[\s\S]*?ONB_FLAG_COMPLETE\]:\s*false/.test(src),
    'logout must clear onboardingComplete so Pain/Promise restarts'
  );
  assert.ok(
    /performLogout[\s\S]*?showOnboarding\(/.test(src),
    'logout must open onboarding (not location.reload → Connecting)'
  );
}

console.log('✅ selfcheck passed');
