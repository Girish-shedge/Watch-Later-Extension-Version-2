# Watch Later Extension — Version 2

Chrome/Edge MV3 extension that schedules YouTube “Watch Later” videos into Google Calendar.

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
```

## Tests

```bash
node tests/selfcheck.js
node tests/stress-oauth.js
```

## Stack

- Plain HTML/JS/CSS (MV3)
- Supabase Auth (Google OIDC) + Postgres
- Google Calendar API (freeBusy + events)
