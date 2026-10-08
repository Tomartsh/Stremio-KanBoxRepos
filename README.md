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

## Regenerating Kan 88

`output/stremio-kan88.zip` on main is the empty catalog (`"data": {}`, about 195 bytes). Supabase has no Kan 88 rows for the addon to show. `www.kan.org.il` returns HTTP 403 from outside Israel, so this catalog has to be scraped from an Israeli host. Playwright is required because the lobby is behind Cloudflare.

Do these three steps from that host, with `classes/.env` containing the Supabase service role:

1. Confirm the scrape actually finds series, without uploading anything:

```bash
npx playwright install chromium
npm run scrape:local -- kan88
```

`scripts/scrape-local.js` forces `SAVE_MODE=local`, `WRITE_TO_GITHUB=false`, and `UPDATE_DATABASE=false`. Check that `output/stremio-kan88.zip` is no longer ~195 bytes and that its `data` object has series. A lobby page that fails to load aborts the run, and `BaseScraper` does not replace an existing ZIP or Supabase rows when the result is empty.

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
