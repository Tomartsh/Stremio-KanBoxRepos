# Stremio-KanBoxRepos

Scraper project for Israeli TV content. Scrapes data from KAN, Mako, Reshet, and other sources, then updates a shared Supabase database.

## Scraper Server

The project includes an Express server (runs on port **49999** by default) for triggering scrapers via HTTP endpoints.

### Starting the Server

```bash
cd /path/to/Stremio-KanBoxRepos
node main.js
```

Server will be accessible at: `http://localhost:49999`

### Endpoints

#### Run Scraper

**`GET /run?scraper=<name>&mode=<mode>`**

Trigger a scraper to run in the background.

| Parameter | Required | Options |
|-----------|----------|---------|
| scraper | Yes | `kanDigital`, `kanArchive`, `kanKids`, `kanTeens`, `kanPodcasts`, `kan88`, `mako`, `reshet`, `livetv` |
| mode | No | `auto` (default), `full`, `incremental`, `skip` |

**Examples:**
```bash
# Run podcasts in auto mode
curl http://localhost:49999/run?scraper=kanPodcasts

# Force full scrape
curl http://localhost:49999/run?scraper=kanPodcasts&mode=full

# Incremental mode (skip unchanged)
curl http://localhost:49999/run?scraper=kanDigital&mode=incremental
```

#### Database Diagnostics

**`GET /admin/diagnose/<scraper>`**

Check data integrity for a specific scraper - shows `episodeLink` and `streams` status.

**Examples:**
```bash
curl http://localhost:49999/admin/diagnose/kanPodcasts
curl http://localhost:49999/admin/diagnose/kanDigital
```

#### Wipe Scraper Data

**`GET /admin/wipe/<scraper>`**

Delete all data for a specific scraper from the database. **Use with caution!**

**Examples:**
```bash
curl http://localhost:49999/admin/wipe/kanPodcasts
curl http://localhost:49999/admin/wipe/mako
```

#### Database Statistics

**`GET /admin/stats`**

Get database statistics by scraper type.

**Example:**
```bash
curl http://localhost:49999/admin/stats
```

#### Sanity Check

**`GET /sanityCheck?mode=<mode>&scraper=<scraper>&quick=<true/false>`**

Run database sanity checks.

| Parameter | Options |
|-----------|---------|
| mode | `report` (default), `fix` |
| scraper | Any scraper name (optional) |
| table | `series`, `videos`, `streams` (optional) |
| quick | `true`/`false` - skip URL validations (optional) |

**Examples:**
```bash
# Report issues only
curl http://localhost:49999/sanityCheck

# Fix issues automatically
curl http://localhost:49999/sanityCheck?mode=fix

# Check specific scraper
curl http://localhost:49999/sanityCheck?scraper=kanDigital
```

#### Health Check

**`GET /healthcheck`**

Check if the server is running.

## Scrapers

| Scraper | Source | Content Type | Notes |
|---------|--------|--------------|-------|
| kanDigital | KAN 11 Digital | TV Series | On-demand stream resolution |
| kanArchive | KAN Archive | TV Series | Historical content |
| kanKids | KAN Kids | Kids Series | |
| kanTeens | KAN Teens | Teen Series | |
| kanPodcasts | KAN Podcasts | Podcasts | On-demand stream resolution |
| kan88 | KAN 88 | Podcasts | On-demand stream resolution |
| mako | Mako (Channel 12) | TV Series | Token-based streams |
| reshet | Reshet (Channel 13) | TV Series | |
| livetv | Various | Live TV | |

## Environment Variables

Create `classes/.env`:

```env
# Supabase Database
SUPABASE_URL=your_supabase_url
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key

# GitHub (optional - for JSON file backup)
GITHUB_TOKEN=your_github_token
REPO_OWNER=your_github_username
REPO_NAME=your_repo_name
BRANCH_SECRET=main
```

## Pacing

Request gaps, page pauses, Cloudflare backoff, the time budget, retry limit, and slow mode are all in [`config/pacing.json`](config/pacing.json). `defaults` apply to every scraper. A `scrapers` entry overrides only the fields it sets. Changing a number there is enough; the scrapers read the file at startup and log the resolved values on the first line of the run.

The file is checked when the process starts. A missing scraper, an unknown field, a min greater than its max, or slow mode with neither a budget nor a retry limit aborts before any request.

| Field | Meaning |
| --- | --- |
| `slow` | On: progress logs, and a 403 waits out `blockBackoff` then retries the same URL. Off: one backoff, then `BLOCKED` and no publish. |
| `minIntervalMs` | Minimum gap since the previous request. `0` in slow mode. |
| `requestDelayMinMs` / `requestDelayMaxMs` | Extra random wait. With the defaults this is the 1–4s jitter on top of a 2s floor. In slow mode the floor is 0 and this range is the whole gap. |
| `pauseEveryPages` | Pause after this many completed pages. `0` disables it. |
| `pauseMinMs` / `pauseMaxMs` | Length of that pause. |
| `blockBackoffMinMs` / `blockBackoffMaxMs` | Wait after a 403 or Cloudflare challenge. |
| `budgetMs` | Stop the run at this elapsed time, including sleeps. `null` means no budget. |
| `maxRetries` | How many 403 backoffs to take before aborting. `null` means until the budget runs out. |
| `governHttp` | Also use these delays for hosts other than `kan.org.il` (Mako, Reshet, Kan Kids). |
| `maxPerMinute` | Cap used when `governHttp` is on. `null` keeps that host's existing per-minute cap. |

`kanDigital` is slow by default, sized for a 20-hour window:

- 45–90 seconds between `kan.org.il` requests
- 10–20 minute pause every 40 pages
- 60–90 minute wait on a 403, then resume that same page (the scrape does not start over)
- 20-hour budget. When the budget is spent the run stops and does not publish
- the 85% video gate still refuses a thinner catalog

Other scrapers keep today's pace until their entry in the file (or an override below) changes it. `--slow` / `KAN_SLOW=1` on a scraper that is not already slow copies `kanDigital`'s slow numbers. `--no-slow` / `KAN_SLOW=0` puts that run back on `defaults`. Numeric overrides still win after that.

Environment (only the variables you set are applied):

```bash
KAN_SLOW=1
KAN_BUDGET_HOURS=20
KAN_BUDGET_MS=72000000
KAN_REQUEST_DELAY_MIN_MS=45000
KAN_REQUEST_DELAY_MAX_MS=90000
KAN_MIN_INTERVAL_MS=0
KAN_PAUSE_EVERY_PAGES=40
KAN_PAUSE_MIN_MS=600000
KAN_PAUSE_MAX_MS=1200000
KAN_BLOCK_BACKOFF_MIN_MS=3600000
KAN_BLOCK_BACKOFF_MAX_MS=5400000
KAN_MAX_RETRIES=unlimited
```

CLI and the `/run` query use the same knobs. `KAN_BUDGET_MS` wins over `KAN_BUDGET_HOURS` when both are set. CLI wins over environment.

```bash
node scripts/run-scraper.js kan88 --slow --budget-hours 20
node scripts/scrape-local.js kanDigital --no-slow
curl "http://localhost:49999/run?scraper=kanTeens&slow=1&budgetHours=20"
```

Slow-mode logs look like this:

```text
KanDigital pacing: slow=true minInterval=0s requestDelay=45s-1m 30s pauseEvery=40 pages pause=10m-20m blockBackoff=1h-1h 30m budget=20h maxRetries=unlimited governHttp=false maxPerMinute=domain-default
kan slow: page 40 done (https://www.kan.org.il/...). elapsed 1h 12m. budget left 18h 48m. ETA 2026-10-17T05:00:00.000Z. pausing now.
kan slow: sleeping 12m 4s (pause after 40 pages). pages 40. budget left 18h 36m.
CLOUDFLARE CHALLENGE kan.org.il HTTP 403 on https://www.kan.org.il/.... Opening the browser before any long backoff.
CLOUDFLARE CHALLENGE cleared for https://www.kan.org.il/.... Reusing this browser for the rest of the scrape.
CLOUDFLARE CHALLENGE kan.org.il HTTP 403 on https://www.kan.org.il/.... kan slow: sleeping 1h 12m then resuming this page (not restarting). retry 1. pages 41. budget left 17h 20m.
```

### Standalone kanDigital on the Windows station

Slow mode is already on for `kanDigital`. Run it in its own process so it can use the 20-hour window. This publishes (GitHub and Supabase follow `WRITE_TO_GITHUB` and `UPDATE_DATABASE`, both on unless you turn them off). `classes/.env` needs the usual Supabase and GitHub keys.

```bat
cd /d D:\Development\Stremio-KanBoxRepos
git pull
set KAN_SLOW=1
set KAN_BUDGET_HOURS=20
node scripts/run-scraper.js kanDigital --slow --budget-hours 20
```

`scripts/scrape-local.js` is the same scrape with upload and Supabase forced off.

### Cloudflare on the Windows scraper machine

kan.org.il and kankids.org.il answer plain HTTP, and Playwright's default headless shell, with a Cloudflare challenge. The scrapers open the installed Google Chrome instead, keep one persistent profile, and log `CLOUDFLARE CHALLENGE` when the interstitial is still up. A browser that cannot start is logged as `KAN BROWSER UNAVAILABLE` and is not called a Cloudflare block. Mako and Reshet do not use this browser.

Set these on the scheduled task (Machine or the task itself, not only the interactive user). The profile has to stay off C: and off the interactive Chrome profile:

```bat
set KAN_BROWSER_CHANNEL=chrome
set KAN_BROWSER_EXECUTABLE=C:\Program Files\Google\Chrome\Application\chrome.exe
set KAN_BROWSER_USER_DATA_DIR=D:\KanBox\kan-browser-profile
set KAN_BROWSER_HEADLESS=false
```

`KAN_BROWSER_HEADLESS=false` is the default: Chrome stays headed and the window is placed off-screen. New headless (`KAN_BROWSER_HEADLESS=new`) sends a `HeadlessChrome` user agent and was still challenged. `KAN_BROWSER_CHANNEL=chromium` with `PLAYWRIGHT_BROWSERS_PATH=D:\KanBox\ms-playwright` uses the full bundled Chromium (not the headless shell) after `npx playwright install chromium` is run with that variable set. `KAN_CHALLENGE_TIMEOUT_MS` is how long the browser waits for an interstitial (default 30000).

Check one page before a nightly run:

```bat
node scripts/check-kan-access.js https://www.kan.org.il/lobby/kan-box/
```

Exit 0 prints `CLEAR`. Exit 3 is a Cloudflare challenge or block. Exit 4 is a browser that did not start.

### Nightly runner skip

The runner at `D:\Development\kanbox-runner` pulls this repo and starts each scraper through `BaseScraper.crawl` (`/run` or `node scripts/run-scraper.js`). Before any request, crawl creates `locks/<scraper>.lock` in the repo (override the directory with `SCRAPER_LOCK_DIR`) and writes the pid, start time, and a stale-after deadline.

While that file is held by a live pid and is younger than the run's budget plus 2 hours (22 hours for kanDigital's 20-hour budget), the next crawl of that scraper does not start. It logs `SKIPPED`, returns immediately, and does not publish. A standalone slow run holds `locks/kanDigital.lock` for the whole window, so the nightly kanDigital start skips and leaves the current ZIP and Supabase rows in place. The other scrapers have their own lock files and still run.

A lock is stale when the pid is gone, or when the file is older than that deadline (a wedged process). The next run deletes the stale file and starts. The lock is removed when the run finishes, including on process exit.

## Regenerating Kan 88

`output/stremio-kan88.zip` on main is the empty catalog (`"data": {}`, about 195 bytes). Supabase has no Kan 88 rows for the addon to show. `www.kan.org.il` returns HTTP 403 from outside Israel, so this catalog has to be scraped from an Israeli host. Playwright is required because the lobby is behind Cloudflare.

Do these three steps from that host, with `classes/.env` containing the Supabase service role:

1. Confirm the scrape actually finds series, without uploading anything. Point the browser at installed Chrome first (see "Cloudflare on the Windows scraper machine" above), then:

```bash
node scripts/check-kan-access.js https://www.kan.org.il/lobby/kan-box/
npm run scrape:local -- kan88
```

`scripts/scrape-local.js` forces `SAVE_MODE=local`, `WRITE_TO_GITHUB=false`, and `UPDATE_DATABASE=false`. Check that `output/stremio-kan88.zip` is no longer ~195 bytes and that its `data` object has series. A lobby page that fails to load aborts the run, and `BaseScraper` does not replace an existing ZIP or Supabase rows when the result is empty. With slow mode off, a Cloudflare HTTP 403 opens the browser once, then aborts that scraper and is logged as `BLOCKED` with `CLOUDFLARE CHALLENGE` when the page is still an interstitial. kanDigital runs in slow mode by default: a challenge opens the browser immediately, and a browser that is still challenged waits and retries the same page until the time budget is gone. A budget exhaustion does not publish. The same publish step also keeps the previous ZIP and Supabase rows when the new video count is under 85% of the previous catalog. Kan and Kan Kids requests share one cookie jar and, only after a challenge, one browser.

2. Republish the ZIP to GitHub (this is what GitHub Pages serves as the addon fallback) and upsert Supabase. From the scraper server:

```bash
curl "http://localhost:49999/run?scraper=kan88&mode=full"
```

That writes `output/stremio-kan88.zip` through the GitHub uploader and calls `updateFromJSON` with scraper `kan88`. The database column `scraper` is `kan88`. The series `subtype` written by this scraper is `8`. The addon catalog also accepts subtypes `kan88` and `88`.

3. Restart or wait for the addon to reload. It reads Supabase first. An empty ZIP is ignored by the addon, so publishing the empty file again will not fill the catalog.

`output/stremio-kankids.zip` already has series. It does not need a regen for this fix.

## Live TV

`classes/LiveTV.js` matches Stremio-KanBoxAddon branch `cursor/fix-stremio-playback-d2c6`: the same channel ids and posters as `classes/liveChannels.js`, and the first playlist from `classes/liveStreamResolver.js`. That includes the Mako `/evrideo/` channels and Reshet's CloudFront backup as the first Reshet stream. It does not write `output/stremio-live.zip`. The addon deleted that archive and ignores the filename. Keshet 12, Channel 24, and the `/evrideo/` channels still need a Mako entitlement ticket, which the addon fetches at playback.

## Logging

Logs are written to: `logs/Stremio-Repos.log`

## Troubleshooting

### Podcasts show "no streams found"

1. Check diagnostics: `curl http://localhost:49999/admin/diagnose/kanPodcasts`
2. Look for `hasEpisodeLink: true` in the output
3. If `hasEpisodeLink` is false or data is corrupted:
   - Wipe: `curl http://localhost:49999/admin/wipe/kanPodcasts`
   - Re-scrape: `curl http://localhost:49999/run?scraper=kanPodcasts&mode=full`

### Duplicate episodes

If you see duplicate episodes:
1. Check database stats: `curl http://localhost:49999/admin/stats`
2. Wipe and re-scrape the affected content type
3. Check logs for pagination issues
