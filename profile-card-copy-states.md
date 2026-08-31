# Profile Journey Card — Copy for Every State

All states read from `computeQueueProjection(userId)`. None of this copy should be
written twice in two places — if a second surface (e.g. a future dashboard) needs
the same states, it calls the same function and reuses these strings, not a
re-derived version.

**One naming decision that resolves a bug from the last round:** the big "Waiting"
number shows **no unit word** — just the bare count. The word "sessions" appears
once, in the pace sentence underneath, where it reads naturally in a full sentence
instead of sounding clinical next to a big number ("24 Sessions"). This was the
"Video" vs "session" inconsistency flagged last round — removing the word from the
stat cell removes the place it could contradict itself.

---

## State 1 — True first-time user

**Trigger:** `queueSize = 0` AND the user has never had a `watched_at` set, ever
(not just within the 28-day window — a genuine first-timer, not someone who
recently cleared out).

**Don't show the two-cell stat row at all for this state.** Showing "0 / 0" reads
as real, computed data rather than "nothing has happened yet" — same trap as an
empty-calendar result being mistaken for a failed scan elsewhere in this project.
Replace the stat row with a single line:

> Nothing here yet — schedule a video and this is where you'll track your progress.

**No mood chip** ("Night Owl," "Lunch Breaker"). Assigning a personality read from
zero behavioral data is the same kind of fabrication the slot-scoring algorithm
already refuses to do with thin calendar data — don't guess at a trait with nothing
to base it on. The chip appears starting at State 2, once there's at least
`queueSize > 0` to reason from.

**Subtitle under the name:**
> Schedule your first video to start tracking your journey

---

## State 2 — Has a queue, but not enough watch history for pace yet

**Trigger:** `queueSize > 0` AND `confidence: 'low'` (fewer than `QUEUE_PACE_MIN_SAMPLE`
sessions watched in the last 28 days — same threshold as the intercept).

This is a real, distinct state from State 1 — someone who scheduled a batch of
videos on day one and hasn't watched any yet. The queue number is real and known;
the pace isn't.

**Stat row:**
> Waiting: {queueSize}
> To clear: — *(em dash, not "0" — zero would imply a computed answer, this is an unknown one)*

**Subtitle under "To clear":**
> Watch a few more to see your pace

**No pace sentence** below the stat row for this state — there's nothing honest to
say yet. Don't fall back to "Clearing about 0 a week," which would read as a real,
bad number rather than "not enough data."

---

## State 3 — Regular state

**Trigger:** `queueSize > 0` AND `confidence: 'normal'` AND `weeksToClear < QUEUE_DISPLAY_CAP_WEEKS`.

**Stat row:**
> Waiting: {queueSize}
> To clear: {formatWeeks(weeksToClear)}

**Pace sentence:**
> Clearing about {round(weeklyPace)} session{s if weeklyPace != 1} a week on average

**Singular/plural rules, spelled out explicitly (this broke last round — locking it
here so it can't drift again):**
- `queueSize == 1` → stat cell shows bare `1`, no word attached either way (this is
  why dropping the unit word from Section header fixed the plural bug for free —
  there's no "Video/Videos" to get wrong anymore).
- `weeksToClear` formatting: `0.5` → "0.5 Week" · `1.0` → "1 Week" · `5.5` → "5.5 Weeks".
  Rule: singular "Week" only when the rounded/formatted value is exactly `1`,
  plural otherwise, including fractional values under 1 or over 1 (e.g. `0.5` and
  `1.5` are both "Week**s**" grammatically... except `0.5` reads better as
  "Week" since it's less than one whole week. Use: singular when
  `formattedValue <= 1`, plural when `> 1`.
- `weeklyPace` rounds to a whole number for the sentence only (per the earlier
  rounding rule) — `round(weeklyPace) == 1` → "1 session a week," not "1 sessions."

---

## State 4 — Queue cleared (the milestone state)

**Trigger:** `queueSize = 0` AND the user has watched at least one session, ever
(distinguishes this from State 1 — this is a returning, active user who's caught up,
not someone who's never used the product).

This is the one state in this card that's earned real celebration — matches the
"reserve delight for actual watching, not scheduling" rule from the design
principles file. It's also the same milestone previously flagged as undesigned
(`hist-04-queue-cleared`) — this is that state's home on Profile specifically.

**Subtitle under the name:**
> You're all caught up! Nothing waiting in your queue.

**Stat row:** replace the two-cell layout with a single celebratory line, not
"0 / 0 Weeks" (a real zero-queue here is worth stating plainly, not burying in the
same two-cell shape used for a real backlog number):
> Queue: empty — nice work.

**No pace sentence** — there's nothing pending to project a clearing time for.

---

## State 5 — Over the display cap (very large queue)

**Trigger:** `confidence: 'normal'` AND `weeksToClear >= QUEUE_DISPLAY_CAP_WEEKS` (26).

**Stat row:**
> Waiting: {queueSize}
> To clear: {formatWeeksToClear(weeksToClear)} → e.g. "Over 9 Months"

**Pace sentence:** same as State 3, unchanged:
> Clearing about {round(weeklyPace)} sessions a week on average

**Deliberately no extra editorializing copy for this state** — no "that's a lot!"
or a suggestion to change preferences bolted onto the number. Section 4 of the
design principles file applies directly here: state the fact, don't narrate
judgment about it. "Change slot preferences" is already one tap away in the menu
below if the person wants to act on what they're seeing — the card's job is to
tell the truth, not to nudge.

**Singular edge case:** if `weeksToClear` rounds to exactly one month-equivalent,
"Over 1 Month," not "Over 1 Months" — same singular/plural rule as State 3, applied
to the month unit once `formatWeeksToClear` has switched over.

---

## Quick reference — trigger conditions in one place

| State | `queueSize` | `confidence` | `weeksToClear` | Ever watched anything? |
|---|---|---|---|---|
| 1. First-time | `0` | n/a | n/a | Never |
| 2. Low confidence | `> 0` | `low` | n/a | — |
| 3. Regular | `> 0` | `normal` | `< 26` | — |
| 4. Cleared | `0` | any | n/a | At least once |
| 5. Over cap | `> 0` | `normal` | `>= 26` | — |

State 1 and State 4 both have `queueSize = 0` — the "ever watched anything" check
is what tells them apart, and it's the one piece of this table that isn't already
sitting in `computeQueueProjection`'s return value. That function will need to also
return (or a caller will need to separately check) whether the user has any
`watched_at` in their full history, not just the 28-day window, specifically to
distinguish these two states.
