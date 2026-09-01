# Watch Later Extension — Version 2

Chrome/Edge MV3 extension that schedules YouTube “Watch Later” videos into Google Calendar.

**Current build:** `manifest.json` `"version"` **1.1.7**. Bump the patch on every shipped runtime change (see `.cursor/rules/extension-version.mdc`).

**Agent docs:** `.cursor/rules/project.mdc` + `rules.mdc` + `ponytail.mdc` + `extension-version.mdc` (facts of record). This README is the short human/load map. Parent workspace copies of those rules live one folder up when this repo is nested.

## Layout

| Path | Role |
|------|------|
| `popup.html` / `popup.js` / `style.css` | v2 UI (MV3 plain HTML/JS/CSS) |
| `background.js` | Service worker — silent OAuth + token refresh |
| `lib/google-oauth.js` | Shared `launchWebAuthFlow` + `auth_oauth_lock` (timeout → `flow_busy`, no second launch) |
| `lib/slot-algorithm.js` | Calendar slot scoring / multi-session plan |
| `lib/queue-projection.js` | Queue pace / intercept copy (`WLQueue`) |
| `lib/translate.js` | Non-Latin → English (`WLTranslate`) |
| `lib/supabase.js` | Bundled supabase-js (only client) |
| `fonts/` | Proxima Nova TTFs |
| `Icon/` | UI assets. Toolbar/store: `WatchLater-16/32/48.png` + `WatchLater.png` (128) from Figma `715:20031`. Why/logout heroes are JPEG. |
| `tests/` | `selfcheck.js`, `translate-stress.js`, `stress-oauth.js`, slot-algorithm + queue-projection checks |
| `supabase/` | Migrations + Edge Functions (`scanAndScore` is **not** deployed) |

## Load unpacked

1. Open `chrome://extensions` (or `edge://extensions`)
2. Enable Developer mode
3. Load unpacked → select this folder
4. Pin the extension and open it on a YouTube watch URL
5. After auth / host_permissions changes: **Reload** the extension

## Preview (no extension needed)

```bash
# from this folder
npx --yes serve -p 8321
# open http://127.0.0.1:8321/chrome.html
# or http://127.0.0.1:8321/popup#preview=1  (hash when serve strips ? on .html)
```

| URL / hash | Screen |
|------------|--------|
| `#preview=1&schedule=1` | Schedule + random sample (`&slots=0` / `1` / `2` for compact sheets) |
| `#preview=1&multi=1` | Multi-session schedule |
| `#preview=1&schedule=1&profile=1` | Profile menu (cycles journey states) |
| `#preview=1&schedule=1&history=1` | History playlist |
| `#preview=1&schedule=1&queue=1` | Queue intercept |
| `#preview=1&offline=1` | No-internet fact carousel |
| `#preview=1&anim=fall` | Wrong URL sheet (Figma `533:9884`) |
| `#preview=1&wrongurl=1` | First-time Wrong URL onboarding |
| `#preview=1&success=1` / `&fail=1` | Outcome sheets (`541:15067` / `541:15659`) |
| `#preview=1&auth=promise` (or `connecting` / `denied` / `analyzing`) | Auth / permissions / calendar scan |
| `#preview=1&schedule=1&auth=analyzing` | Calendar scan over schedule skeleton |

Hosted preview is the same static folder on Vercel (`/` rewrites to `chrome.html`). After deploy, use hash flags on that origin the same way (`/#preview=1&schedule=1`).

## Current notes (1.1.7)

- Unpacked folder is ~5 MB (unused `data/*.mp4`, duplicate wrong-URL art, leftover koala/warn PNGs removed; Why/logout heroes are 836×470 JPEG).
- `public.users` needs column-limited `authenticated` INSERT/UPDATE/SELECT. If those grants drop, profile upsert is `permission denied` and prefs / scores / `button_clicks` fail FK. Last restore: migration `20260901120000_restore_users_authenticated_grants`.
- Chrome’s extension Errors panel lists `console.warn`. Expected Google cancel (`The user did not approve access`) and a busy `launchWebAuthFlow` are not warned. After auth or this upgrade: **Reload** unpacked, then Clear all on the Errors page.

## Tests

```bash
node tests/selfcheck.js                 # UI/auth/motion/token contracts
node tests/translate-stress.js          # non-Latin detect + gtx cache / fail paths
node tests/stress-oauth.js              # refresh-token rotation + OAuth lock
node tests/queue-projection-selfcheck.js
node tests/slot-algorithm-selfcheck.js
node tests/slot-algorithm-stress.js
node tests/scanandscore-tz-selfcheck.mjs
```

## Slot algorithm

`lib/slot-algorithm.js` is the reference implementation (client freeBusy). Scores go to `calendar_slot_scores`; suggestions fill empty `user_slot_preferences` only. `supabase/functions/scanAndScore/` mirrors scoring but is **not deployed**.

## Translate

Non-Latin titles/channel/description → English via free Google gtx (`lib/translate.js`). Cache: `chrome.storage.local.wl_translate_cache`. Failure keeps the original language. Host: `https://translate.googleapis.com/*` in `manifest.json`.

## Stack

- Plain HTML/JS/CSS (MV3)
- Supabase Auth (Google OIDC) + Postgres
- Google Calendar API (freeBusy + events)

## Figma

https://www.figma.com/design/PrF1j2l2jxbROee7Ek6PW8/Extension---V2

Key nodes: Pain `531:958` · Promise `546:16896` · extension icon `715:20031` · schedule sheet `532:2721` · Wrong URL `533:9884` · success `541:15067` · fail `541:15659` · history `533:7243`.
