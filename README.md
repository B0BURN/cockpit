# Semester Cockpit

Offline-first iPhone web app for the semester: schedule, deadlines, grades, body and time tracking, push notifications and a Claude assistant.

- `app/`: the app (GitHub Pages). Install on iPhone: open the Pages URL in Safari, then Share → Add to Home Screen.
- `worker/`: Cloudflare Worker for sync, push notifications (cron every 5 min) and the Claude chat.
- Data lives in the private repo `cockpit-data` (`data.json`), so Claude can read and edit it.

Every push to `main` redeploys both.
