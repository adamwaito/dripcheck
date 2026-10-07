# DripCheck Push Notifications

## Status

**Live.** The app is served at `https://dripcheck.oksure.cc`, and push delivery is active through the Worker API at `https://dripcheck-push.dripcheck-push.workers.dev`.

## Included

- An installable PWA shell with offline app assets and a push-capable service worker.
- A Cloudflare Worker API for saving, updating, and deleting per-device push subscriptions.
- A 15-minute scheduled job that checks Open-Meteo forecasts in each user's local timezone.
- Three independently selectable schedules: one alert per cold spell, a daily 7 a.m. local summary, and an alert during the hour before each cold period starts.
- D1 storage for subscriptions, user-selected locations, Celsius thresholds, schedule selections, and duplicate-alert state.

Users must open the app over HTTPS (or localhost), grant notification permission, and enable at least one schedule. iOS users must install the app to the Home Screen before enabling web push.

## Cloudflare Status

- D1 database `dripcheck-push` is created and migrated. Its ID is `423e14bf-7f96-408e-b8dc-9d0b4c0c74e2`.
- The Worker is deployed at `https://dripcheck-push.dripcheck-push.workers.dev` with a 15-minute cron trigger.
- VAPID public and private keys are stored as Cloudflare Worker secrets. They are not in this repository.
- `VAPID_SUBJECT` is set to a `mailto:` contact in `wrangler.jsonc`.
- `ALLOWED_ORIGINS` allows `https://dripcheck.oksure.cc` and `http://localhost:8000`.
- `push-config.js` points `apiBase` at the Worker URL.

## Redeploying

After changing the Worker or `wrangler.jsonc`, redeploy with `npm run deploy:push`. If the app moves to a new origin, add it to `ALLOWED_ORIGINS` and redeploy.

Local development uses `npm run dev:push`; the deployed cron trigger runs every 15 minutes. Users must grant notification permission. iOS users must install the app to the Home Screen before enabling web push.

Never commit the VAPID private key. If it is regenerated, the public key changes and existing device subscriptions must be re-enabled.