# Slack Archive Curator

A browser-only tool for scraping Slack channels, curating messages, and exporting a clean ZIP of the ones worth keeping. Built so each teammate can run it themselves with their own token — **nothing is ever stored on the server**.

## How it works

```
┌────────────────────────────┐        X-Slack-Token            ┌─────────────────┐
│  Your browser tab          │ ───────────────────────────────▶│  /api/slack/*   │
│  • UI + message viewer     │                                 │  (Vercel)       │
│  • Scrape Web Worker       │ ◀───────────────────────────────│  Stateless      │
│  • IndexedDB (everything)  │         Slack's JSON            │  CORS proxy     │
│  • JSZip → .zip download   │                                 └─────────────────┘
└────────────────────────────┘                                          │
                                                                        ▼
                                                             ┌────────────────────┐
                                                             │  slack.com/api/... │
                                                             └────────────────────┘
```

- **Your token** is sent as `X-Slack-Token` on every request. The proxy forwards it to Slack as a Bearer header and then throws it away. It is **not logged and not persisted** by our code.
- **Your scraped data** (messages, threads, users, marks) lives in IndexedDB in your browser. Refresh-safe, survives tab close, but does **not** survive a "Clear my data" click or a browser profile wipe.
- **Your export** is a ZIP file generated client-side and triggered as a browser download. No intermediate server storage.

## Quickstart (local)

```bash
pip install -r requirements.txt
python api/index.py
# open http://localhost:5173
```

For a production-identical local setup (recommended before deploying):

```bash
npm i -g vercel
vercel dev
# open the URL printed in the terminal (usually http://localhost:3000)
```

`vercel dev` matches the routing in `vercel.json` exactly, including the edge-CDN handling for `/public/**`. Use it whenever you're touching `vercel.json` or the static layout.

## Using the app

1. **Get a Slack token.** A `xoxp-…` user token works best. Your workspace admin can issue one, or (if you're an admin) from *Settings & administration → Manage apps → Legacy custom integrations → Legacy tokens*. It needs read scopes: `channels:read`, `channels:history`, `groups:read`, `groups:history`, `users:read`.
2. **Scan your workspace.** Click `+` in the top-left. Paste your token, hit Scan. The app lists every channel you can see.
3. **Pick channels + options.** Check the channels you want, tick *Fetch thread replies* if you want them, choose a history cutoff, click *Start scrape*.
4. **Keep the tab open during the scrape.** The app holds a Wake Lock so the screen won't sleep, but if you close the tab you'll have to resume from the last 200-message checkpoint when you reopen it. A resume banner will appear if it detects an interrupted scrape.
5. **Curate.** Click channels in the sidebar, click `Keep` / `Del` on individual messages, or `Keep page` / `Delete page` to mark all 100 visible messages at once.
6. **Export.** Sidebar → *Export kept*. A ZIP downloads to your machine containing `curated/<channel>.json` per channel with just the messages you marked `keep` (plus their thread replies, if you fetched them).

## Architecture details

- **Backend** (`api/index.py`) — ~100 lines of Flask. Exposes `POST /api/slack/<method>` which whitelists one of {`auth.test`, `conversations.list`, `conversations.history`, `conversations.replies`, `conversations.info`, `users.list`, `users.info`, `users.conversations`} and forwards to `https://slack.com/api/<method>` with the user's token as a Bearer header. Retry-After is preserved on 429s so the client-side rate limiter can back off correctly.
- **Frontend** (`public/`) — vanilla ES modules, no build step.
  - `index.html` — SPA shell.
  - `app.js` — main-thread UI, rendering, IndexedDB reads, ZIP export, Wake Lock management, resume banner.
  - `storage.js` — IndexedDB wrapper. One database `slack-archive` with stores for channels, users, messages, threads, marks, scrape_progress, scan_results, meta.
  - `slack-client.js` — POSTs to `/api/slack/*`. Includes `AdaptiveRateLimiter` (ported from `extract_slack.py`).
  - `scrape-worker.js` — Web Worker that runs the scrape loop (history → threads). Checkpoints progress after every page of 200 messages so a mid-scrape refresh doesn't lose much.
  - `vendor/jszip.min.js` — JSZip 3.10.1, vendored for offline-after-first-load reliability.

## Privacy and security

- Tokens are never written to disk or logged by our code. They only exist in the memory of the Vercel function for the ~1 second it takes to proxy a single Slack call.
- A Vercel team member with platform log access could in theory read HTTP headers in flight — this is mitigated by our proxy explicitly not logging them. If this concern matters to you, create a short-lived token and revoke it after you export.
- We never ask for write scopes. The proxy whitelists only read-oriented Slack methods.
- Your IndexedDB data is bound to the browser profile that scraped it. Another user on another machine cannot see it.

## Deploying to Vercel

1. Push this repo to GitHub.
2. On Vercel, *Import Project* → pick the repo. Vercel auto-detects `vercel.json`.
3. No environment variables needed. Click *Deploy*.
4. Share the URL with your team. Each person brings their own token.

You're on Vercel Pro/Enterprise, so function invocation limits, bandwidth, and the serverless function timeout are effectively non-issues for this workload (one scrape is ~1 API call every ~1.5s, all well under the per-invocation limit).

## Standalone CLI tools (optional, legacy)

The repo also contains `extract_slack.py` and `resolve_raw_threads.py` from an earlier local-only workflow. They write JSON files under `knowledge-archive/raw/` and are independent of the web app. Keep them or delete them — the web app does not read or write those files.

## File layout

```
.
├── api/
│   └── index.py              # Vercel serverless Flask proxy (also runs locally)
├── public/
│   ├── index.html            # SPA shell
│   ├── app.js                # main-thread UI + IndexedDB reads + export
│   ├── storage.js            # IndexedDB wrapper
│   ├── slack-client.js       # proxy client + rate limiter
│   ├── scrape-worker.js      # Web Worker: scrape loop
│   ├── style.css
│   └── vendor/jszip.min.js   # ZIP generation
├── vercel.json               # Vercel routing
├── requirements.txt          # Flask + requests (+ slack_sdk for CLI tools)
├── extract_slack.py          # CLI: bulk-scrape channels to JSON (standalone)
├── resolve_raw_threads.py    # CLI: fetch thread replies for scraped JSON (standalone)
└── channels.json             # CLI config (ignored by the web app)
```

## Known limitations

1. **Tab must stay open during a scrape.** Mitigated by Web Worker + Wake Lock + 200-msg checkpoints + Resume banner. Large channels (e.g. one with ~1500 active threads) can still take 15–20 minutes wall-clock to fully resolve. Leave the machine plugged in.
2. **No cross-device sync.** Data scraped in Chrome on your laptop isn't visible in Firefox on your iPad. Intentional — that's IndexedDB being browser-local.
3. **Token must be re-entered on every page load.** We don't persist it anywhere, not even `localStorage`.
