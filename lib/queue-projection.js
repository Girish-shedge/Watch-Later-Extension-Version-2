/**
 * Queue impact intercept — pace, projection, firing, copy.
 * Shared by popup (intercept + profile) and tests. No Chrome / Supabase here.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WLQueue = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DEFAULT_CONFIG = {
    QUEUE_PACE_WINDOW_DAYS: 28,
    QUEUE_PACE_MIN_SAMPLE: 3,
    QUEUE_INTERCEPT_MIN_WEEKS: 3,
    QUEUE_INTERCEPT_TIER_LOW: 4,
    QUEUE_INTERCEPT_TIER_HIGH: 13,
    QUEUE_INCLUDE_NEEDS_ATTENTION: 1,
    QUEUE_DISPLAY_CAP_WEEKS: 26,
    QUEUE_INTERCEPT_COOLDOWN_DAYS: 30,
  };

  const WEEKS_PER_MONTH = 4.33;

  const TIER_COPY = [
    { line1: 'This video would push', before: 'your queue', chip: 'a month', after: '' },
    { line1: 'This video would push', before: 'your queue', chip: '3 months', after: '' },
  ];

  function cfg(config) {
    return { ...DEFAULT_CONFIG, ...(config || {}) };
  }

  function ts(value) {
    const n = new Date(value).getTime();
    return Number.isFinite(n) ? n : NaN;
  }

  function sessionsAdded(durationMin, computeSessionPlan, config) {
    if (typeof computeSessionPlan !== 'function') return 1;
    const plan = computeSessionPlan(durationMin, config);
    if (!plan) return 1;
    const n = Number(plan.sessionCount);
    return n > 0 ? n : 1;
  }

  /**
   * rows: { watched_at, removed, forced }[]
   * Countable unit = one videohistory row (a session).
   */
  function computeQueueProjection(rows, now = Date.now(), config) {
    const c = cfg(config);
    const nowMs = +now;
    const windowMs = Math.max(1, Number(c.QUEUE_PACE_WINDOW_DAYS) || 28) * 86400000;
    const windowStart = nowMs - windowMs;
    const includeForced = Number(c.QUEUE_INCLUDE_NEEDS_ATTENTION) !== 0;
    const list = Array.isArray(rows) ? rows : [];

    let watchedInWindow = 0;
    let queueSize = 0;
    for (const row of list) {
      const watchedAt = row?.watched_at ? ts(row.watched_at) : NaN;
      if (Number.isFinite(watchedAt) && watchedAt >= windowStart && watchedAt <= nowMs) {
        watchedInWindow += 1;
      }
      const waiting = !Number.isFinite(watchedAt);
      const removed = !!row?.removed;
      const forced = !!row?.forced;
      if (waiting && !removed && (includeForced || !forced)) queueSize += 1;
    }

    const weekSpan = (Number(c.QUEUE_PACE_WINDOW_DAYS) || 28) / 7;
    const weeklyPace = weekSpan > 0 ? watchedInWindow / weekSpan : 0;
    if (watchedInWindow < Number(c.QUEUE_PACE_MIN_SAMPLE)) {
      return { queueSize, watchedInWindow, weeklyPace: null, weeksToClear: null, confidence: 'low' };
    }
    const weeksToClear = weeklyPace > 0 ? queueSize / weeklyPace : null;
    return { queueSize, watchedInWindow, weeklyPace, weeksToClear, confidence: 'normal' };
  }

  function computeQueueImpact(before, sessionsAddedCount) {
    if (!before || before.confidence === 'low' || !(before.weeklyPace > 0)) return null;
    const added = Math.max(1, Math.round(Number(sessionsAddedCount) || 1));
    const afterQueueSize = before.queueSize + added;
    return {
      beforeWeeks: before.weeksToClear,
      afterWeeks: afterQueueSize / before.weeklyPace,
      weeklyPace: before.weeklyPace,
      queueSize: before.queueSize,
      sessionsAdded: added,
      afterQueueSize,
      confidence: 'normal',
    };
  }

  /** Inclusive lower / exclusive upper: [MIN, HIGH) = month, [HIGH, ∞) = 3 months. */
  function severityTier(weeks, config) {
    const c = cfg(config);
    const n = Number(weeks);
    if (!Number.isFinite(n) || n < Number(c.QUEUE_INTERCEPT_MIN_WEEKS)) return -1;
    if (n < Number(c.QUEUE_INTERCEPT_TIER_HIGH)) return 0;
    return 1;
  }

  function shouldShowIntercept(impact, state, now = Date.now(), config) {
    if (!impact || impact.confidence === 'low') return false;
    const c = cfg(config);
    if (!(impact.afterWeeks >= Number(c.QUEUE_INTERCEPT_MIN_WEEKS))) return false;
    if (!state || state.last_shown_at == null) return true;
    const nextTier = severityTier(impact.afterWeeks, c);
    const prevTier = severityTier(state.last_shown_after_weeks, c);
    if (nextTier > prevTier) return true;
    const last = ts(state.last_shown_at);
    if (!Number.isFinite(last)) return true;
    const cooldownMs = Math.max(0, Number(c.QUEUE_INTERCEPT_COOLDOWN_DAYS) || 0) * 86400000;
    return (+now - last) >= cooldownMs;
  }

  function roundToHalf(weeks) {
    return Math.round(Number(weeks) * 2) / 2;
  }

  function formatHalfNumber(weeks) {
    const h = roundToHalf(weeks);
    return Number.isInteger(h) ? String(h) : h.toFixed(1);
  }

  /**
   * Card/profile display. Math stays unrounded in weeks.
   * Figma: integer when .0, one decimal when needed (5 vs 5.5).
   * Above QUEUE_DISPLAY_CAP_WEEKS → months.
   */
  function formatWeeksToClear(weeks, config) {
    const c = cfg(config);
    const n = Number(weeks);
    if (!Number.isFinite(n)) {
      return { label: '—', line1: '—', unit: '', kind: 'empty' };
    }
    if (n >= Number(c.QUEUE_DISPLAY_CAP_WEEKS)) {
      const months = Math.round(n / WEEKS_PER_MONTH);
      return {
        label: `Over ${months} months`,
        line1: `Over ${months}`,
        unit: 'months',
        kind: 'months',
      };
    }
    const shown = formatHalfNumber(n);
    return {
      label: `About ${shown} weeks`,
      line1: `About ${shown}`,
      unit: 'weeks',
      kind: 'weeks',
    };
  }

  function everWatched(rows) {
    return (Array.isArray(rows) ? rows : []).some(row => Number.isFinite(ts(row?.watched_at)));
  }

  /** Figma 643:3182 — "0 video" / "1 Video" / "24 Videos". */
  function formatScheduledCount(n) {
    const count = Math.max(0, Math.round(Number(n) || 0));
    if (count === 0) return '0 video';
    if (count === 1) return '1 Video';
    return `${count} Videos`;
  }

  /** To-clear cell — "5.5 Weeks", "Over 9 Months", not intercept "About …" prefix. */
  function formatProfileWeeksCell(weeks, config) {
    const c = cfg(config);
    const n = Number(weeks);
    if (!Number.isFinite(n)) return '—';
    if (n >= Number(c.QUEUE_DISPLAY_CAP_WEEKS)) {
      const months = Math.round(n / WEEKS_PER_MONTH);
      return months === 1 ? 'Over 1 Month' : `Over ${months} Months`;
    }
    const shown = formatHalfNumber(n);
    const unit = Number(shown) === 1 ? 'Week' : 'Weeks';
    return `${shown} ${unit}`;
  }

  /**
   * Profile stats card state — Figma 643:3182 / 643:3790 / 671:18962 / 671:19188 (+ over-cap).
   * `everWatched` splits first-time (0 queue, never watched) from cleared milestone.
   */
  function resolveProfileCardState(proj, rows, config) {
    const c = cfg(config);
    const qs = Math.max(0, Math.round(Number(proj?.queueSize) || 0));
    if (qs === 0 && !everWatched(rows)) return 'first';
    if (qs === 0 && everWatched(rows)) return 'cleared';
    if (proj?.confidence === 'low') return 'low';
    if (Number(proj?.weeksToClear) >= Number(c.QUEUE_DISPLAY_CAP_WEEKS)) return 'over-cap';
    return 'regular';
  }

  function profileCardCopy(state, proj, config) {
    const paceShown = Number.isFinite(proj?.weeklyPace) ? Math.round(proj.weeklyPace) : 0;
    const videoWord = paceShown === 1 ? 'video' : 'videos';
    switch (state) {
      case 'first':
        return {
          scheduled: '0 video',
          toClear: '0 weeks',
          banner: 'Schedule your first video to start tracking',
          bannerKind: 'grey',
        };
      case 'low':
        return {
          scheduled: formatScheduledCount(proj?.queueSize),
          toClear: '—',
          banner: 'Watch a few more to see your pace',
          bannerKind: 'grey',
        };
      case 'regular':
      case 'over-cap':
        return {
          scheduled: formatScheduledCount(proj?.queueSize),
          toClear: formatProfileWeeksCell(proj?.weeksToClear, config),
          banner: `Clearing about ${paceShown} ${videoWord} a week on average`,
          bannerKind: 'grey',
        };
      case 'cleared':
        return {
          scheduled: '0 Video',
          toClear: '0 Week',
          banner: 'Queue empty! Nice work',
          bannerKind: 'green',
        };
      default:
        return profileCardCopy('first', proj, config);
    }
  }

  function interceptCopy(impact, config) {
    const c = cfg(config);
    const tier = Math.max(0, severityTier(impact?.afterWeeks, c));
    const parts = TIER_COPY[tier] || TIER_COPY[0];
    const pace = impact?.weeklyPace;
    const paceShown = Number.isFinite(pace) ? Math.round(pace) : 0;
    const queueSize = Math.max(0, Math.round(Number(impact?.queueSize) || 0));
    return {
      tier,
      line1: parts.line1,
      before: parts.before,
      chip: parts.chip,
      after: parts.after,
      body: `You've got ${queueSize} waiting, clearing about ${paceShown} a week on average.`,
      paceLine: `Clearing about ${paceShown} a week on average.`,
    };
  }

  return {
    DEFAULT_CONFIG,
    TIER_COPY,
    WEEKS_PER_MONTH,
    sessionsAdded,
    computeQueueProjection,
    computeQueueImpact,
    severityTier,
    shouldShowIntercept,
    roundToHalf,
    formatHalfNumber,
    formatWeeksToClear,
    everWatched,
    formatScheduledCount,
    formatProfileWeeksCell,
    resolveProfileCardState,
    profileCardCopy,
    interceptCopy,
  };
});
