/**
 * Queue intercept math — spec §3–11. Run: node tests/queue-projection-selfcheck.js
 */
'use strict';

const assert = require('assert');
const path = require('path');
const Q = require(path.join(__dirname, '..', 'lib', 'queue-projection.js'));

const DAY = 86400000;
const NOW = Date.parse('2026-08-31T12:00:00.000Z');
const C = Q.DEFAULT_CONFIG;

function row(over = {}) {
  return { watched_at: null, removed: false, forced: false, ...over };
}
function watchedAgo(days) {
  return row({ watched_at: new Date(NOW - days * DAY).toISOString() });
}

{
  const before = Q.computeQueueProjection([row(), row()], NOW, C);
  assert.strictEqual(before.confidence, 'low');
  assert.strictEqual(before.queueSize, 2);
  assert.strictEqual(Q.computeQueueImpact(before, 1), null);
}

{
  const rows = [watchedAgo(1), watchedAgo(2), row(), row()];
  const before = Q.computeQueueProjection(rows, NOW, C);
  assert.strictEqual(before.confidence, 'low', 'MIN_SAMPLE - 1 must stay low');
}

{
  const rows = [watchedAgo(1), watchedAgo(2), watchedAgo(3), row(), row(), row()];
  const before = Q.computeQueueProjection(rows, NOW, C);
  assert.strictEqual(before.confidence, 'normal');
  assert.strictEqual(before.watchedInWindow, 3);
  assert.strictEqual(before.weeklyPace, 3 / 4);
  assert.strictEqual(before.queueSize, 3);
  assert.ok(Math.abs(before.weeksToClear - 4) < 1e-9);
}

{
  const rows = [
    watchedAgo(1), watchedAgo(2), watchedAgo(3),
    row({ watched_at: new Date(NOW + DAY).toISOString() }),
    row(),
  ];
  const before = Q.computeQueueProjection(rows, NOW, C);
  assert.strictEqual(before.watchedInWindow, 3, 'future watched_at must not count');
  assert.strictEqual(before.queueSize, 1);
}

{
  const rows = [
    watchedAgo(1), watchedAgo(2), watchedAgo(3),
    row({ forced: true }),
    row({ removed: true }),
    row(),
  ];
  const include = Q.computeQueueProjection(rows, NOW, C);
  assert.strictEqual(include.queueSize, 2, 'forced counts when INCLUDE=1');
  const exclude = Q.computeQueueProjection(rows, NOW, { ...C, QUEUE_INCLUDE_NEEDS_ATTENTION: 0 });
  assert.strictEqual(exclude.queueSize, 1, 'forced dropped when INCLUDE=0');
}

{
  const plan = { sessionCount: 4, sessions: [1, 2, 3, 4] };
  assert.strictEqual(Q.sessionsAdded(200, () => plan), 4);
  assert.strictEqual(Q.sessionsAdded(10, () => null), 1);
  assert.strictEqual(Q.sessionsAdded(10, () => ({ sessionCount: 3 })), 3);
}

{
  const before = { confidence: 'normal', queueSize: 20, weeklyPace: 5, weeksToClear: 4 };
  const impact = Q.computeQueueImpact(before, 3);
  assert.strictEqual(impact.afterQueueSize, 23);
  assert.ok(Math.abs(impact.afterWeeks - 4.6) < 1e-9);
  assert.strictEqual(impact.weeklyPace, 5, 'pace stays unrounded');
}

{
  assert.strictEqual(Q.severityTier(2.99, C), -1);
  assert.strictEqual(Q.severityTier(3, C), 0);
  assert.strictEqual(Q.severityTier(3.99, C), 0);
  assert.strictEqual(Q.severityTier(4, C), 0, 'month copy covers [MIN, HIGH)');
  assert.strictEqual(Q.severityTier(12.99, C), 0);
  assert.strictEqual(Q.severityTier(13, C), 1);
}

{
  const impact = { confidence: 'normal', afterWeeks: 3.5, weeklyPace: 5, queueSize: 18 };
  assert.strictEqual(Q.shouldShowIntercept(impact, null, NOW, C), true);
  assert.strictEqual(
    Q.shouldShowIntercept(impact, { last_shown_at: NOW - DAY, last_shown_after_weeks: 3.2 }, NOW, C),
    false,
    'same tier within cooldown must not re-fire'
  );
  assert.strictEqual(
    Q.shouldShowIntercept(
      { ...impact, afterWeeks: 4 },
      { last_shown_at: NOW - DAY, last_shown_after_weeks: 3.5 },
      NOW,
      C
    ),
    false,
    '3.5 → 4 stays month copy — no re-fire'
  );
  assert.strictEqual(
    Q.shouldShowIntercept(
      { ...impact, afterWeeks: 13 },
      { last_shown_at: NOW - DAY, last_shown_after_weeks: 5 },
      NOW,
      C
    ),
    true,
    'month → 3 months must fire despite cooldown'
  );
  assert.strictEqual(
    Q.shouldShowIntercept(
      { ...impact, afterWeeks: 5 },
      { last_shown_at: NOW - 30 * DAY, last_shown_after_weeks: 5 },
      NOW,
      C
    ),
    true,
    'same tier after 30 days must re-fire'
  );
  assert.strictEqual(
    Q.shouldShowIntercept(
      { ...impact, afterWeeks: 5 },
      { last_shown_at: NOW - 29 * DAY, last_shown_after_weeks: 5 },
      NOW,
      C
    ),
    false,
    '29 days is still inside cooldown'
  );
}

{
  const twoTiers = Q.computeQueueImpact(
    { confidence: 'normal', queueSize: 10, weeklyPace: 4, weeksToClear: 2.5 },
    50
  );
  assert.ok(twoTiers.afterWeeks > 13);
  assert.strictEqual(Q.severityTier(twoTiers.afterWeeks, C), 1);
  assert.strictEqual(Q.interceptCopy(twoTiers, C).chip, '3 months');
  assert.strictEqual(Q.interceptCopy(twoTiers, C).after, '');
}

{
  const month = Q.interceptCopy({ afterWeeks: 5, weeklyPace: 4.6, queueSize: 24 }, C);
  assert.strictEqual(month.tier, 0);
  assert.strictEqual(month.chip, 'a month');
  assert.strictEqual(month.after, '');
  assert.ok(month.body.includes('24 waiting'));
  assert.ok(month.body.includes('about 5 a week'));
  const early = Q.interceptCopy({ afterWeeks: 3.2, weeklyPace: 5, queueSize: 16 }, C);
  assert.strictEqual(early.tier, 0);
  assert.strictEqual(early.chip, 'a month');
  assert.ok(!Q.TIER_COPY.some(t => t.chip === 'days' || t.chip === 'past' || /few extra/.test(t.before)));
}

{
  assert.strictEqual(Q.formatWeeksToClear(5, C).label, 'About 5 weeks');
  assert.strictEqual(Q.formatWeeksToClear(5.5, C).label, 'About 5.5 weeks');
  assert.strictEqual(Q.formatWeeksToClear(5.24, C).label, 'About 5 weeks');
  assert.strictEqual(Q.formatWeeksToClear(5.25, C).label, 'About 5.5 weeks');
  assert.strictEqual(Q.formatWeeksToClear(25.9, C).kind, 'weeks');
  assert.strictEqual(Q.formatWeeksToClear(26, C).kind, 'months');
  assert.ok(Q.formatWeeksToClear(26, C).label.startsWith('Over '));
}

{
  const rows = [watchedAgo(1), watchedAgo(2), watchedAgo(3), row()];
  const before = Q.computeQueueProjection(rows, NOW, C);
  assert.strictEqual(before.watchedInWindow, 3);
  rows[0].watched_at = null;
  const afterUndo = Q.computeQueueProjection(rows, NOW, C);
  assert.strictEqual(afterUndo.watchedInWindow, 2);
  assert.strictEqual(afterUndo.confidence, 'low');
}

{
  assert.strictEqual(Q.formatScheduledCount(0), '0 video');
  assert.strictEqual(Q.formatScheduledCount(1), '1 Video');
  assert.strictEqual(Q.formatScheduledCount(24), '24 Videos');
  assert.strictEqual(Q.formatProfileWeeksCell(5.5, C), '5.5 Weeks');
  assert.strictEqual(Q.formatProfileWeeksCell(1, C), '1 Week');
  assert.strictEqual(Q.formatProfileWeeksCell(30, C), 'Over 7 Months');
  const first = Q.computeQueueProjection([], NOW, C);
  assert.strictEqual(Q.resolveProfileCardState(first, [], C), 'first');
  const firstCopy = Q.profileCardCopy('first', first, C);
  assert.strictEqual(firstCopy.scheduled, '0 video');
  assert.strictEqual(firstCopy.toClear, '0 weeks');
  assert.strictEqual(firstCopy.bannerKind, 'grey');
  const clearedRows = [{ watched_at: watchedAgo(10).watched_at }];
  const cleared = Q.computeQueueProjection(clearedRows, NOW, C);
  assert.strictEqual(Q.resolveProfileCardState(cleared, clearedRows, C), 'cleared');
  assert.strictEqual(Q.profileCardCopy('cleared', cleared, C).bannerKind, 'green');
  const lowRows = [row(), row()];
  const low = Q.computeQueueProjection(lowRows, NOW, C);
  assert.strictEqual(Q.resolveProfileCardState(low, lowRows, C), 'low');
  assert.strictEqual(Q.profileCardCopy('low', low, C).toClear, '—');
  const paceRows = [watchedAgo(1), watchedAgo(2), watchedAgo(3), row(), row()];
  const regular = Q.computeQueueProjection(paceRows, NOW, C);
  assert.strictEqual(Q.resolveProfileCardState(regular, paceRows, C), 'regular');
  assert.ok(Q.profileCardCopy('regular', regular, C).banner.includes('a week on average'));
}

console.log('queue-projection-selfcheck: ok');
