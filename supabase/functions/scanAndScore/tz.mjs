/**
 * Timezone helpers for scanAndScore.
 *
 * Edge Functions run in UTC, so bucket boundaries ("Morning (6–9)") must be
 * resolved in the user's zone explicitly — a plain setHours() would score
 * 06:00 UTC, i.e. 11:30 for an IST user.
 *
 * Plain .mjs so Deno (the function) and Node (tests/scanandscore-tz-selfcheck.mjs)
 * can both import the same source.
 */

export function isValidTimeZone(tz) {
  // Intl silently falls back to the host zone for '' / undefined, which would
  // let a malformed request score against the server's UTC clock.
  if (typeof tz !== 'string' || !tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function partsIn(utcMs, timeZone, withTime) {
  const opts = { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' };
  if (withTime) {
    Object.assign(opts, { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }
  const v = {};
  for (const p of new Intl.DateTimeFormat('en-US', opts).formatToParts(new Date(utcMs))) {
    if (p.type !== 'literal') v[p.type] = Number(p.value);
  }
  return v;
}

/** Offset (ms) between `timeZone` wall-clock and UTC at a given instant. */
export function tzOffsetMs(utcMs, timeZone) {
  const v = partsIn(utcMs, timeZone, true);
  // hour12:false renders midnight as hour 24 on some ICU builds.
  return Date.UTC(v.year, v.month - 1, v.day, v.hour % 24, v.minute, v.second) - utcMs;
}

/**
 * UTC instant of a wall-clock time in `timeZone`. DST-correct: the offset is
 * re-read at the candidate instant, because the offset at the naive guess can
 * belong to the wrong side of a transition.
 */
export function zonedToUtcMs(y, monthIdx, day, hour, timeZone) {
  const guess = Date.UTC(y, monthIdx, day, hour);
  const first = tzOffsetMs(guess, timeZone);
  const ts = guess - first;
  const second = tzOffsetMs(ts, timeZone);
  return second === first ? ts : guess - second;
}

/** Civil (calendar) date in `timeZone` at `atMs` (default: now). */
export function civilNow(timeZone, atMs = Date.now()) {
  const v = partsIn(atMs, timeZone, false);
  return { y: v.year, monthIdx: v.month - 1, day: v.day };
}
