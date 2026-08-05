# Watch Later Extension — Version 2

Chrome/Edge MV3 extension that schedules YouTube “Watch Later” videos into Google Calendar.

**Agent handoff (Aug 2026):** auth sheets use per-state MP4s in `Icon/auth/`; warn banners are **Figma PNG exports** (`auth-warn-banner.png`, `-why`, `-privacy`) — do not rebuild in CSS except Analyzing `.is-live` error. Modals: no drop shadow, padding 12 all sides, gap 16. Auth dim over schedule is CSS gradient (not PNG). Full context for Cursor agents lives in the parent workspace `.cursor/rules/project.mdc` + `rules.mdc` + `ponytail.mdc`.

## Load unpacked

1. Open `chrome://extensions` (or `edge://extensions`)
2. Enable Developer mode
3. Load unpacked → select this folder
4. Pin the extension and open it on a YouTube watch URL

## Preview (no extension needed)

```bash
# from this folder
npx --yes serve -p 8321
# open http://127.0.0.1:8321/popup.html?preview=1
# auth states: &auth=connecting|cancelled|denied|generic|interrupted
# first-time wrong URL: &wrongurl=1
```

## Tests

```bash
node tests/selfcheck.js                     # pure UI/history helpers
node tests/slot-algorithm-selfcheck.js      # scoring, suggestions, resume routing
node tests/slot-algorithm-stress.js         # jam-packed / empty / hostile / DST calendars + timings
node tests/scanandscore-tz-selfcheck.mjs    # Edge Function timezone helpers
node tests/stress-oauth.js                  # refresh-token rotation + reuse detection
```

## Slot algorithm

`lib/slot-algorithm.js` is the reference implementation and runs client-side: the
post-login calendar scan writes a 7×7 score grid to `calendar_slot_scores`, and
suggestions only ever fill an *empty* `user_slot_preferences` — a rescan never
overwrites days/times the user picked.

`supabase/functions/scanAndScore/` mirrors the scoring server-side but is **not
deployed**. It still needs a Google access token from the caller, so it only
becomes worthwhile once a server-held refresh token exists (cron path).

## Stack

- Plain HTML/JS/CSS (MV3)
- Supabase Auth (Google OIDC) + Postgres
- Google Calendar API (freeBusy + events)

## Figma

https://www.figma.com/design/PrF1j2l2jxbROee7Ek6PW8/Extension---V2
