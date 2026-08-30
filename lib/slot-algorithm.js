/**
 * Slot suggestion algorithm v1 (shared by popup + selfcheck).
 * Bucket keys match SLOT_RANGES labels. Weekday: 0=mon .. 6=sun.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WLSlotAlgorithm = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SLOT_RANGES = {
    'Morning (6–9)': [6, 9],
    'Mid-Morning (9–12)': [9, 12],
    'Afternoon (12–3)': [12, 15],
    'Mid-Afternoon (3–6)': [15, 18],
    'Evening (6–9)': [18, 21],
    'Night (9–12)': [21, 24],
    'Late Night (12–3)': [0, 3],
  };

  const BUCKET_ORDER = Object.keys(SLOT_RANGES);
  /** Plan WEEKDAY_ORDER: mon..sun → indices 0..6 */
  const WEEKDAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

  const DEFAULT_CONFIG = {
    FREE_RATIO_THRESHOLD: 0.8,
    SELECTION_THRESHOLD: 0.7,
    MIN_SAMPLE_SIZE: 3,
    MAX_SELECTIONS: 3,
    ALGORITHM_VERSION: 1,
    STALENESS_DAYS: 30,
    LONG_VIDEO_THRESHOLD_MINUTES: 165,
  };

  const MULTI_SESSION_MAX_WINDOW_DAYS = 56;

  /** JS Date.getDay(): 0=sun → plan weekday 6; 1=mon → 0; … */
  function jsDayToWeekday(jsDay) {
    return jsDay === 0 ? 6 : jsDay - 1;
  }

  function weekdayToKey(weekday) {
    return WEEKDAY_KEYS[weekday] || 'mon';
  }

  function keyToWeekday(key) {
    const i = WEEKDAY_KEYS.indexOf(String(key || '').toLowerCase());
    return i >= 0 ? i : 0;
  }

  function prefsAnalysisWindow(now = new Date()) {
    const timeMin = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const timeMax = new Date(now.getFullYear(), now.getMonth() + 2, 0, 23, 59, 59, 999);
    return { timeMin, timeMax };
  }

  function monthRanges(now = new Date()) {
    const y = now.getFullYear();
    const m = now.getMonth();
    return [
      { start: new Date(y, m - 1, 1), end: new Date(y, m, 0, 23, 59, 59, 999) },
      { start: new Date(y, m, 1), end: new Date(y, m + 1, 0, 23, 59, 59, 999) },
      { start: new Date(y, m + 1, 1), end: new Date(y, m + 2, 0, 23, 59, 59, 999) },
    ];
  }

  function mergeIntervals(intervals) {
    if (!intervals || !intervals.length) return [];
    const sorted = intervals
      .map(b => ({ start: +new Date(b && b.start), end: +new Date(b && b.end) }))
      .filter(b => b.end > b.start)
      .sort((a, b) => a.start - b.start);
    if (!sorted.length) return [];
    const out = [{ ...sorted[0] }];
    for (let i = 1; i < sorted.length; i++) {
      const cur = sorted[i];
      const last = out[out.length - 1];
      if (cur.start <= last.end) last.end = Math.max(last.end, cur.end);
      else out.push({ ...cur });
    }
    return out;
  }

  function busyMsInRange(merged, rangeStart, rangeEnd) {
    const rs = +rangeStart;
    const re = +rangeEnd;
    if (!(re > rs)) return 0;
    let ms = 0;
    for (const b of merged) {
      const s = Math.max(b.start, rs);
      const e = Math.min(b.end, re);
      if (e > s) ms += e - s;
    }
    return ms;
  }

  function dateKey(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  /**
   * Index busy intervals by local calendar date (merged per day).
   * clampStart/clampEnd bound the work: freeBusy can hand back an event spanning
   * years, and the midnight-split loop below costs one iteration per day spanned.
   */
  function mergeAndIndexByDate(busyIntervals, clampStart = -Infinity, clampEnd = Infinity) {
    const byDate = {};
    for (const b of busyIntervals || []) {
      if (!b) continue;
      let startMs = +new Date(b.start);
      let endMs = +new Date(b.end);
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) continue;
      if (startMs < clampStart) startMs = clampStart;
      if (endMs > clampEnd) endMs = clampEnd;
      if (!(endMs > startMs)) continue;
      // Split across midnight so each day gets its local slice
      let cursor = new Date(startMs);
      while (+cursor < endMs) {
        const dayEnd = new Date(cursor);
        dayEnd.setHours(24, 0, 0, 0);
        if (!(+dayEnd > +cursor)) break; // clock arithmetic never advanced — don't spin
        const sliceEnd = Math.min(endMs, +dayEnd);
        const k = dateKey(cursor);
        if (!byDate[k]) byDate[k] = [];
        byDate[k].push({ start: +cursor, end: sliceEnd });
        cursor = dayEnd;
      }
    }
    const out = {};
    for (const [k, list] of Object.entries(byDate)) {
      out[k] = mergeIntervals(list);
    }
    return out;
  }

  /**
   * Cap each ISO week’s contribution to at most one occurrence per cell
   * by only counting each (weekday,bucket) once per week-key.
   * Implemented as: iterate dates; for each cell use Set of weekKeys counted.
   */
  function weekKey(d) {
    // ISO-ish: year + week number from Thursday-based week
    const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    const dayNum = t.getUTCDay() || 7;
    t.setUTCDate(t.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
    const weekNo = Math.ceil((((t - yearStart) / 86400000) + 1) / 7);
    return `${t.getUTCFullYear()}-W${weekNo}`;
  }

  /**
   * Compute 7×7 score grid from busy intervals over coveredRange.
   * Returns { scores: { [weekday]: { [bucket]: { score, confidence, sampleSize } } }, rows: [...] }
   */
  function computeScores(busyIntervals, coveredRange, config = {}) {
    const cfg = { ...DEFAULT_CONFIG, ...config };

    const grid = {};
    const weekSeen = {}; // `${weekday}|${bucket}|${weekKey}` → true (outlier cap)
    for (let w = 0; w < 7; w++) {
      grid[w] = {};
      for (const bucket of BUCKET_ORDER) {
        grid[w][bucket] = { freeCount: 0, totalCount: 0, freeRatioSum: 0 };
      }
    }

    const ranges = Array.isArray(coveredRange)
      ? coveredRange
      : [{ start: coveredRange[0] || coveredRange.start, end: coveredRange[1] || coveredRange.end }];

    let clampStart = Infinity;
    let clampEnd = -Infinity;
    for (const range of ranges) {
      const s = new Date(range.start);
      s.setHours(0, 0, 0, 0);
      const e = new Date(range.end);
      e.setHours(24, 0, 0, 0);
      if (+s < clampStart) clampStart = +s;
      if (+e > clampEnd) clampEnd = +e;
    }
    const busyByDate = mergeAndIndexByDate(busyIntervals, clampStart, clampEnd);

    for (const range of ranges) {
      const start = new Date(range.start);
      start.setHours(0, 0, 0, 0);
      const end = new Date(range.end);
      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        const day = new Date(d);
        const weekday = jsDayToWeekday(day.getDay());
        const dk = dateKey(day);
        const dayTimeline = busyByDate[dk] || [];
        const wk = weekKey(day);

        for (const bucket of BUCKET_ORDER) {
          const [h0, h1] = SLOT_RANGES[bucket];
          const s0 = new Date(day);
          s0.setHours(h0, 0, 0, 0);
          // Late Night (0–3) is the early morning of this same calendar day,
          // matching how the scheduler expands SLOT_RANGES onto a date.
          const s1 = new Date(day);
          s1.setHours(h1 === 24 ? 0 : h1, 0, 0, 0);
          if (h1 === 24) s1.setDate(s1.getDate() + 1);
          const winMs = +s1 - +s0;
          if (winMs <= 0) continue;

          const capKey = `${weekday}|${bucket}|${wk}`;
          if (weekSeen[capKey]) continue; // outlier: one sample per week per cell
          weekSeen[capKey] = true;

          const busyMs = busyMsInRange(dayTimeline, s0, s1);
          const freeRatio = Math.min(1, Math.max(0, 1 - busyMs / winMs));
          grid[weekday][bucket].totalCount += 1;
          grid[weekday][bucket].freeRatioSum += freeRatio;
          if (freeRatio >= cfg.FREE_RATIO_THRESHOLD) {
            grid[weekday][bucket].freeCount += 1;
          }
        }
      }
    }

    const scores = {};
    const rows = [];
    for (let w = 0; w < 7; w++) {
      scores[w] = {};
      for (const bucket of BUCKET_ORDER) {
        const cell = grid[w][bucket];
        // avgFreeRatio keeps the continuous signal that the free/busy threshold
        // throws away, so a grid of all-zero scores can still be ranked.
        const avgFreeRatio = cell.totalCount ? cell.freeRatioSum / cell.totalCount : 0.5;
        let entry;
        if (cell.totalCount < cfg.MIN_SAMPLE_SIZE) {
          entry = { score: 0.5, confidence: 'low', sampleSize: cell.totalCount, avgFreeRatio };
        } else {
          entry = {
            score: cell.freeCount / cell.totalCount,
            confidence: 'normal',
            sampleSize: cell.totalCount,
            avgFreeRatio,
          };
        }
        scores[w][bucket] = entry;
        rows.push({
          weekday: w,
          time_bucket: bucket,
          score: Math.round(entry.score * 1000) / 1000,
          sample_size: entry.sampleSize,
          confidence: entry.confidence,
          algorithm_version: cfg.ALGORITHM_VERSION,
        });
      }
    }
    return { scores, rows };
  }

  function argMax(map, order, tie = {}) {
    let best = order[0];
    let bestVal = -Infinity;
    let bestTie = -Infinity;
    for (const k of order) {
      const v = map[k] ?? -Infinity;
      const t = tie[k] ?? 0;
      if (v > bestVal || (v === bestVal && t > bestTie)) {
        bestVal = v;
        bestTie = t;
        best = k;
      }
    }
    return best;
  }

  function topN(candidates, n, scoreBy, order, tie = {}) {
    return [...candidates]
      .sort((a, b) => {
        const d = (scoreBy[b] || 0) - (scoreBy[a] || 0);
        if (d !== 0) return d;
        const t = (tie[b] || 0) - (tie[a] || 0);
        if (t !== 0) return t;
        return order.indexOf(a) - order.indexOf(b);
      })
      .slice(0, n);
  }

  function mean(values) {
    if (!values.length) return 0;
    let sum = 0;
    for (const v of values) sum += v;
    return sum / values.length;
  }

  /**
   * First-time setup suggestion only. Returns day keys + slot keys.
   * Days/buckets are ranked on the mean score across the other axis — taking the
   * max instead would score a day with one free late-night hour the same as a
   * completely empty day, which makes every day of a work calendar look equal.
   */
  function suggestPreferences(scores, config = {}) {
    const cfg = { ...DEFAULT_CONFIG, ...config };
    const dayScore = {};
    const dayTie = {};
    for (let w = 0; w < 7; w++) {
      const key = weekdayToKey(w);
      dayScore[key] = mean(BUCKET_ORDER.map(b => scores[w]?.[b]?.score ?? 0));
      dayTie[key] = mean(BUCKET_ORDER.map(b => scores[w]?.[b]?.avgFreeRatio ?? 0));
    }

    let candidateDays = WEEKDAY_KEYS.filter(d => dayScore[d] >= cfg.SELECTION_THRESHOLD);
    if (!candidateDays.length) {
      candidateDays = [argMax(dayScore, WEEKDAY_KEYS, dayTie)];
    }
    const selectedDays = topN(candidateDays, cfg.MAX_SELECTIONS, dayScore, WEEKDAY_KEYS, dayTie);

    const timeScore = {};
    const timeTie = {};
    for (const bucket of BUCKET_ORDER) {
      const ws = selectedDays.map(keyToWeekday);
      timeScore[bucket] = mean(ws.map(w => scores[w]?.[bucket]?.score ?? 0));
      timeTie[bucket] = mean(ws.map(w => scores[w]?.[bucket]?.avgFreeRatio ?? 0));
    }

    let candidateTimes = BUCKET_ORDER.filter(b => timeScore[b] >= cfg.SELECTION_THRESHOLD);
    if (!candidateTimes.length) {
      candidateTimes = [argMax(timeScore, BUCKET_ORDER, timeTie)];
    }
    const selectedTimes = topN(candidateTimes, cfg.MAX_SELECTIONS, timeScore, BUCKET_ORDER, timeTie);

    return { suggestedDays: selectedDays, suggestedTimes: selectedTimes };
  }

  function prefsBusyHint(score) {
    if (score >= 0.6) return 'Free days';
    if (score >= 0.35) return 'Moderately busy';
    return 'Occupied';
  }

  function hintsFromScores(scores) {
    const dayHints = {};
    const slotHints = {};
    for (let w = 0; w < 7; w++) {
      dayHints[weekdayToKey(w)] = prefsBusyHint(mean(BUCKET_ORDER.map(b => scores[w]?.[b]?.score ?? 0)));
    }
    for (const bucket of BUCKET_ORDER) {
      const perDay = [];
      for (let w = 0; w < 7; w++) perDay.push(scores[w]?.[bucket]?.score ?? 0);
      slotHints[bucket] = prefsBusyHint(mean(perDay));
    }
    return { dayHints, slotHints };
  }

  /**
   * Split a long video into evenly-sized sessions. Returns null for single-session path.
   * sessionLengthMin is shared by UI banner + session cards so they cannot disagree.
   */
  function computeSessionPlan(videoDurationMin, config = {}) {
    const cfg = { ...DEFAULT_CONFIG, ...config };
    const threshold = cfg.LONG_VIDEO_THRESHOLD_MINUTES;
    if (!(videoDurationMin > threshold)) return null;

    const sessionCount = Math.ceil(videoDurationMin / threshold);
    const sessionLengthMin = Math.ceil(videoDurationMin / sessionCount);
    const totalSec = videoDurationMin * 60;
    const sessions = [];
    let offsetSec = 0;

    for (let i = 1; i <= sessionCount; i++) {
      const remainingSec = totalSec - offsetSec;
      const thisSessionSec = Math.min(sessionLengthMin * 60, remainingSec);
      sessions.push({
        sessionIndex: i,
        sessionCount,
        sessionLengthMin,
        videoOffsetStartSec: offsetSec,
        videoOffsetEndSec: offsetSec + thisSessionSec,
        durationMin: Math.ceil(thisSessionSec / 60),
      });
      offsetSec += thisSessionSec;
    }

    return { sessionCount, sessionLengthMin, sessions };
  }

  function formatVideoOffset(sec) {
    const s = Math.max(0, Math.floor(Number(sec) || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    const pad = n => String(n).padStart(2, '0');
    return `${pad(h)}:${pad(m)}:${pad(r)}`;
  }

  function formatVideoOffsetRange(startSec, endSec) {
    return `${formatVideoOffset(startSec)} - ${formatVideoOffset(endSec)}`;
  }

  /** Why-sheet chip label — "1h", "1h 30m", "90m" (Figma 400:9920–400:9972). */
  function formatSessionLengthWhy(minutes) {
    const m = Math.max(0, Math.round(Number(minutes) || 0));
    const h = Math.floor(m / 60);
    const r = m % 60;
    if (h && r) return `${h}h ${r}m`;
    if (h) return `${h}h`;
    return `${m}m`;
  }

  function multiSessionBannerText(sessionPlan) {
    if (!sessionPlan) return '';
    return `Video split in ${sessionPlan.sessionCount} sessions. `;
  }

  /** Hard gate — duplicate date+start must never reach the UI. */
  function validateSessionPlan(assignedSlots) {
    const seen = new Set();
    for (const slot of assignedSlots || []) {
      const start = slot.start || slot.slot?.start;
      const date = slot.date || (start ? String(start).slice(0, 10) : '');
      const key = `${date}|${start}`;
      if (seen.has(key)) {
        throw new Error('Duplicate session slot detected — do not return to UI');
      }
      seen.add(key);
    }
    return assignedSlots;
  }

  /** Field-level resume destination. */
  function resumeDestination({ calendarScanned, selectedDays, selectedTimes, triggeredBySaveAction }) {
    if (!calendarScanned) return 'scanning';
    const days = Array.isArray(selectedDays) ? selectedDays : [];
    const times = Array.isArray(selectedTimes) ? selectedTimes : [];
    if (!days.length) return 'pref_days';
    if (!times.length) return 'pref_times';
    return triggeredBySaveAction ? 'schedule' : 'schedule';
  }

  return {
    SLOT_RANGES,
    BUCKET_ORDER,
    WEEKDAY_KEYS,
    DEFAULT_CONFIG,
    jsDayToWeekday,
    weekdayToKey,
    keyToWeekday,
    prefsAnalysisWindow,
    monthRanges,
    mergeIntervals,
    mergeAndIndexByDate,
    computeScores,
    suggestPreferences,
    hintsFromScores,
    prefsBusyHint,
    resumeDestination,
    computeSessionPlan,
    formatVideoOffset,
    formatVideoOffsetRange,
    formatSessionLengthWhy,
    multiSessionBannerText,
    validateSessionPlan,
    MULTI_SESSION_MAX_WINDOW_DAYS,
  };
});
