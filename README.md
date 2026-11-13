# Semester Cockpit

Offline-first iPhone web app for the semester: schedule, deadlines, grades, body and time tracking, push notifications and a Claude assistant.

- `app/`: the app (GitHub Pages). Install on iPhone: open the Pages URL in Safari, then Share → Add to Home Screen.
- `worker/`: Cloudflare Worker for sync, push notifications (cron every 5 min) and the Claude chat.
- Data lives in the private repo `cockpit-data` (`data.json`), so Claude can read and edit it.

Every push to `main` redeploys both.

## Lock-screen timer (iPhone Shortcuts)

The worker has a `/timer` endpoint that Shortcuts can call, so the timer can be started and stopped from the lock screen, Control Center or Siri without opening the app. Every start/stop (from a Shortcut or from the app) also sends a push notification, "⏱ TSA study · since 09:40", which stays on the lock screen while the timer runs and is replaced by "✓ Logged 45m" when it stops.

Shortcut: **Get Contents of URL**
- URL: `https://<your-worker>.workers.dev/timer?action=toggle&course=TSA`
- Method: GET · Header: `Authorization` = `Bearer <APP_PASSWORD>`
- then **Show Notification** with the result (the reply is plain text, e.g. "Started TSA study at 09:40").

Parameters: `action` = `start` | `stop` | `toggle` | `status`; `course` = TSA, ML, ADS, DEV, MM, RP, ENT (aliases like "time series" work); optional `title` and `cat` (study, class, work, gym, road, diet, life), e.g. `?action=start&title=Home%20→%20Uni&cat=road`. Starting while another timer runs stops and logs the old one first.
