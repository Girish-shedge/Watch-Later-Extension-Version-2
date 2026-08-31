# Watch Later Extension — Version 2

Chrome/Edge MV3 extension that schedules YouTube “Watch Later” videos into Google Calendar.

**Agent docs:** parent workspace `.cursor/rules/project.mdc` + `rules.mdc` + `ponytail.mdc` (facts of record). This README is the short human/load map.

## Layout

| Path | Role |
|------|------|
| `popup.html` / `popup.js` / `style.css` | v2 UI (MV3 plain HTML/JS/CSS) |
| `background.js` | Service worker — silent OAuth + token refresh |
| `lib/google-oauth.js` | Shared `launchWebAuthFlow` + `auth_oauth_lock` |
| `lib/slot-algorithm.js` | Calendar slot scoring / multi-session plan |
| `lib/translate.js` | Non-Latin → English (`WLTranslate`) |
| `lib/supabase.js` | Bundled supabase-js (only client) |
| `fonts/` | Proxima Nova TTFs |
| `Icon/` | UI assets (onboarding, auth, schedule, multi-session, …) |
| `tests/` | `selfcheck.js`, `translate-stress.js`, `stress-oauth.js`, slot-algorithm checks |
| `supabase/` | Migrations + Edge Functions (mostly undeployed helpers) |

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
| `#preview=1&schedule=1` | Schedule + random sample |
| `#preview=1&multi=1` | Multi-session schedule |
| `#preview=1&anim=fall` | Wrong URL sheet (Figma `533:9884`) |
| `#preview=1&wrongurl=1` | First-time Wrong URL onboarding |
| `#preview=1&success=1` / `&fail=1` | Outcome sheets (`541:15067` / `541:15659`) |
| `#preview=1&auth=…` | Auth / analyzing / permissions |

Hosted preview is the same static folder on Vercel (`/` rewrites to `chrome.html`). After deploy, use hash flags on that origin the same way (`/#preview=1&schedule=1`).

## Tests

```bash
node tests/selfcheck.js                 # UI/auth/motion/token contracts
node tests/translate-stress.js          # non-Latin detect + gtx cache / fail paths
node tests/stress-oauth.js              # refresh-token rotation + OAuth lock
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

Key nodes: Pain `531:958` · Promise `546:16896` · schedule sheet `532:2721` · Wrong URL `533:9884` · success `541:15067` · fail `541:15659` · history `533:7243`.
