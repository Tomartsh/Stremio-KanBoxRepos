# Incremental Scraping Implementation Plan

## Overview

Currently, scrapers fetch ALL content on every run. For large scrapers like KanPodcasts (266 series, thousands of episodes), this takes 25-35 hours due to rate limiting.

**Goal:** Only scrape new/changed content, skipping unchanged series and episodes.

## Current Architecture

```
┌─────────────┐    Full Scrape    ┌──────────────┐    Write All    ┌─────────┐
│   Scraper   │ ────────────────> │  JSON Object │ ──────────────> │  JSON   │
│  (KanPod)   │                   │              │                 │  File   │
└─────────────┘                   └──────────────┘                 └─────────┘
                                                                       │
                                                                       v
                                                                 ┌─────────┐
                                                                 │ Database│
                                                                 │ (Supabase)│
                                                                 └─────────┘
```

**Problem:** Every series/episode is fetched, even if unchanged.

## Proposed Architecture

```
┌─────────────┐    Load State    ┌──────────────┐    Compare     ┌──────────────┐
│   Scraper   │ <─────────────── │State Storage │ ─────────────> │  Decision    │
│  (KanPod)   │                   │              │                 │  Engine      │
└─────────────┘                   └──────────────┘                 └──────────────┘
       │                                                                    │
       │                                                            ┌───────▼──────┐
       │                     Skip Unchanged                       │  Changed?    │
       │                         │                               │              │
       v                         v                               │  YES └─> Fetch │
  ┌─────────┐               ┌─────────┐                        │  NO  └─> Skip │
  │  Fetch  │               │  Keep   │                        └───────┬──────┘
  │ Changed │               │  Old    │                                │
  │  Items  │               │  Data   │                                v
  └────┬────┘               └─────────┘                        ┌──────────────┐
       │                                                       │Merge Old+New│
       v                                                       └──────┬───────┘
┌──────────────┐    Write Only Changes     ┌─────────┐             │
│  JSON Object │ ──────────────────────────>│  JSON   │<────────────┘
│  (Delta)     │                            │  File   │
└──────────────┘                            └─────────┘
       │                                            │
       v                                            v
  ┌────────────────────────────────────────────────────┐
  │              Database Update (Delta Only)          │
  │  - INSERT new series/videos/streams                │
  │  - UPDATE changed series/videos/streams            │
  │  - DELETE removed items (optional, with config)    │
  └────────────────────────────────────────────────────┘
```

## Database Schema Changes

### New Table: `scrape_state`

```sql
CREATE TABLE scrape_state (
    id BIGSERIAL PRIMARY KEY,
    scraper_name VARCHAR(50) NOT NULL,        -- 'KanPodcasts', 'Reshet', etc.
    series_id VARCHAR(255) NOT NULL,          -- 'il_kan_podcasts_8199'
    
    -- Series-level state
    series_title VARCHAR(500),
    episode_count INTEGER DEFAULT 0,
    last_episode_date TIMESTAMP,
    last_episode_id VARCHAR(255),
    
    -- Scrape metadata
    last_scraped_at TIMESTAMP DEFAULT NOW(),
    last_scrape_hash VARCHAR(64),             -- Hash of series metadata for change detection
    scrape_version INTEGER DEFAULT 1,         -- Increment on schema changes
    
    -- Status
    is_active BOOLEAN DEFAULT TRUE,           -- FALSE if series removed from source
    skip_reason TEXT,                         -- Why skipped (if applicable)
    
    -- Change tracking
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    
    -- Constraints
    UNIQUE(scraper_name, series_id)
);

-- Indexes for performance
CREATE INDEX idx_scrape_state_lookup ON scrape_state(scraper_name, is_active);
CREATE INDEX idx_scrape_state_last_scraped ON scrape_state(last_scraped_at);
```

### Optional: Episode-level state (for very large series)

```sql
CREATE TABLE scrape_episode_state (
    id BIGSERIAL PRIMARY KEY,
    series_id VARCHAR(255) NOT NULL,
    episode_id VARCHAR(255) NOT NULL,
    
    episode_number INTEGER,
    season_number INTEGER,
    release_date TIMESTAMP,
    scrape_hash VARCHAR(64),
    
    last_scraped_at TIMESTAMP DEFAULT NOW(),
    
    UNIQUE(series_id, episode_id)
);
```

## State Storage File Format

**Location:** `cache/scrape-state.json` (gitignored)

```json
{
  "version": 1,
  "last_updated": "2024-05-12T14:00:00Z",
  "scrapers": {
    "KanPodcasts": {
      "series": {
        "il_kan_podcasts_8199": {
          "title": "ספיישל 88",
          "episodeCount": 156,
          "lastEpisodeDate": "2024-05-10T10:00:00Z",
          "lastEpisodeId": "il_kan_podcasts_8199:1:156",
          "lastScraped": "2024-05-12T10:00:00Z",
          "hash": "abc123...",
          "active": true
        }
      },
      "metadata": {
        "totalSeries": 266,
        "lastScrapeRun": "2024-05-12T14:00:00Z",
        "scrapeDuration": 12345
      }
    },
    "Reshet": { /* similar */ }
  }
}
```

## Implementation Components

### 1. State Manager Class

**File:** `classes/StateManager.js`

```javascript
class StateManager {
    constructor(scraperName) {
        this.scraperName = scraperName;
        this.stateFile = path.join('cache', `${scraperName}-state.json`);
        this.state = this.load();
    }

    load() {
        // Load from file, create new if doesn't exist
    }

    save() {
        // Persist to file
    }

    getSeriesState(seriesId) {
        // Return state for specific series
    }

    updateSeriesState(seriesId, data) {
        // Update state after scraping
    }

    compareSeries(seriesData) {
        // Return: 'NEW', 'CHANGED', 'UNCHANGED'
    }
}
```

### 2. Decision Engine

**File:** `classes/ScrapingDecision.js`

```javascript
class ScrapingDecision {
    constructor(stateManager, config) {
        this.state = stateManager;
        this.config = config;
    }

    shouldScrapeSeries(seriesData) {
        // Decision logic:
        // 1. New series? → SCRAPE
        // 2. Episode count changed? → SCRAPE
        // 3. Last episode date changed? → SCRAPE
        // 4. Hash changed? → SCRAPE
        // 5. Older than X days? → SCRAPE (force refresh)
        // 6. Otherwise → SKIP
    }

    shouldScrapeEpisode(episodeData, existingState) {
        // For very large series, skip unchanged episodes
    }
}
```

### 3. Modified BaseScraper

**Changes to:** `classes/BaseScraper.js`

```javascript
class BaseScraper {
    constructor(scraperName, options = {}) {
        // ... existing code ...
        
        // NEW: Add state manager
        this.stateManager = new StateManager(scraperName);
        this.incrementalMode = options.incremental || false;
    }

    async crawl(isDoWriteFile = false) {
        this.logger.info("Started Crawling (Mode: " + 
            (this.incrementalMode ? "INCREMENTAL" : "FULL") + ")";
        
        // ... existing crawl logic ...
    }

    // NEW: Hook for subclasses to override
    async shouldScrapeSeries(seriesData) {
        if (!this.incrementalMode) return true;
        return this.stateManager.shouldScrapeSeries(seriesData);
    }
}
```

### 4. Database Delta Updater

**File:** `classes/DeltaUpdater.js`

```javascript
class DeltaUpdater {
    async updateDatabase(scraperName, newData, oldData) {
        // 1. Identify INSERTs (new items)
        const toInsert = this.findNewItems(newData, oldData);
        
        // 2. Identify UPDATEs (changed items)
        const toUpdate = this.findChangedItems(newData, oldData);
        
        // 3. Identify DELETEs (removed items, optional)
        const toDelete = this.findRemovedItems(newData, oldData);
        
        // 4. Execute in batches
        await this.batchInsert(toInsert);
        await this.batchUpdate(toUpdate);
        await this.batchDelete(toDelete);
        
        // 5. Update scrape_state table
        await this.updateScrapeState(scraperName, newData);
    }
}
```

## Configuration

**Add to:** `classes/constants.js`

```javascript
INCREMENTAL_SCRAPING: {
    enabled: true,                    // Master switch (can be overridden by CLI flags)
    forceRefreshDays: 7,              // Re-scrape series older than X days
    hashAlgorithm: 'sha256',          // For change detection
    
    // CLI Override Behavior:
    // --full        : Force full scrape, ignore this setting
    // --incremental : Force incremental mode, even if enabled=false
    // --skip        : Skip scraping, just validate state
    
    // Per-scraper overrides
    'KanPodcasts': {
        enabled: true,
        episodeLevel: false,           // Don't track individual episodes (too many)
        forceRefreshDays: 3            // More frequent for podcasts
    },
    'KanArchive': {
        enabled: false,                // Archive doesn't change much
        forceRefreshDays: 30
    },
    'Reshet': {
        enabled: true,
        episodeLevel: false,
        forceRefreshDays: 7
    }
}
```

## Phase 1: Foundation (Week 1)

### Tasks:
1. **Create StateManager class**
   - File I/O for state persistence
   - JSON structure definition
   - Load/save operations

2. **Create database migration**
   - `scrape_state` table
   - Indexes for performance

3. **Add state directory to .gitignore**
   - `cache/` folder

4. **Write unit tests**
   - StateManager load/save
   - Decision logic

### Deliverables:
- `classes/StateManager.js`
- `migrations/001_create_scrape_state.sql`
- Tests passing

## Phase 2: Decision Logic (Week 2)

### Tasks:
1. **Create ScrapingDecision class**
   - Series comparison logic
   - Episode comparison (optional)
   - Hash generation for metadata

2. **Integrate into BaseScraper**
   - Add `incrementalMode` option
   - Add `shouldScrapeSeries()` hook
   - Modify processBatch to skip unchanged series

3. **Update individual scrapers**
   - KanPodcasts: Enable incremental
   - Reshet: Enable incremental
   - Others: Add support (can disable per config)

### Deliverables:
- `classes/ScrapingDecision.js`
- Modified `BaseScraper.js`
- Test results showing time savings

## Phase 3: Database Delta Updates (Week 3)

### Tasks:
1. **Create DeltaUpdater class**
   - Compare old/new data
   - Generate INSERT/UPDATE/DELETE lists
   - Batch database operations

2. **Update database update workflow**
   - Replace bulk DELETE with MERGE/UPSERT
   - Add scrape_state table updates

3. **Performance testing**
   - Measure time savings on large scrapers
   - Verify data correctness

### Deliverables:
- `classes/DeltaUpdater.js`
- Database integration working
- Performance benchmarks

## Phase 4: JSON Delta Output (Week 4)

### Tasks:
1. **Implement JSON delta writer**
   - Only write changed series to JSON
   - Or: Full JSON + timestamp for CDN caching

2. **Addon integration**
   - Update DatabaseManager to handle incremental JSON
   - Fallback logic for missing data

### Deliverables:
- JSON delta output working
- Addon reading incremental data correctly

## Success Metrics

| Metric | Before | After (Target) |
|--------|--------|-----------------|
| KanPodcasts full scrape | 25-35 hours | 1-2 hours (only new) |
| Daily scrape (no changes) | 25-35 hours | 10-20 minutes |
| Database writes | All rows | Only deltas |
| API calls | ~50,000 | ~500-2,000 |

## Rollback Plan

If incremental scraping has issues:
1. **Master switch:** Set `INCREMENTAL_SCRAPING.enabled = false`
2. **Per-scraper:** Disable specific scrapers
3. **CLI flags:** Force mode per run (see below)
4. **Full scrape:** Run with `--full` flag to bypass incremental mode

## CLI Usage

```bash
# Incremental scrape (default when enabled)
node scripts/test-scrapers.js kanpodcasts

# Force full scrape (override config)
node scripts/test-scrapers.js kanpodcasts --full

# Force incremental (even if disabled in config)
node scripts/test-scrapers.js kanpodcasts --incremental

# Force skip (quick validation only)
node scripts/test-scrapers.js kanpodcasts --skip
```

## Implementation: CLI Flags

**Add to:** `scripts/test-scrapers.js`

```javascript
const args = process.argv.slice(2);
const forceFull = args.includes('--full');
const forceIncremental = args.includes('--incremental');
const skipOnly = args.includes('--skip');

// Determine mode
let scrapeMode;
if (forceFull) {
    scrapeMode = 'FULL';  // Override config
} else if (forceIncremental) {
    scrapeMode = 'INCREMENTAL';  // Force incremental even if disabled
} else if (skipOnly) {
    scrapeMode = 'SKIP';  // Validate only, don't scrape
} else {
    scrapeMode = config.INCREMENTAL_SCRAPING.enabled ? 'INCREMENTAL' : 'FULL';
}

// Pass to scraper
const scraper = new ScraperClass({ incrementalMode: scrapeMode === 'INCREMENTAL' });
```

## Open Questions

1. **Deleted content:** How to handle series removed from source?
   - Option A: Mark as inactive, keep in DB
   - Option B: Delete after X days
   - Recommendation: Option A

2. **Episode-level tracking:** Worth it for large series?
   - KanPodcasts has 10,000+ episodes
   - Tracking each episode may be overkill
   - Recommendation: Series-level only, for now

3. **State file vs database:** Store state where?
   - File: Faster to load, no DB dependency
   - Database: Consistent, centralized
   - Recommendation: Both (file for speed, DB for persistence)

4. **Hash algorithm:** What to hash?
   - Option A: Series metadata only
   - Option B: Metadata + episode IDs
   - Recommendation: B (catches new episodes)
