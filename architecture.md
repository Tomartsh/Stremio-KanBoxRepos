# Stremio-KanBoxRepos Architecture

## Overview

This project is a Stremio addon that scrapes Israeli TV content from multiple providers (Kan, Mako, Reshet) and serves it through a standardized API. The scraper architecture was refactored to reduce code duplication, improve maintainability, and add resilience features.

## System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         Stremio Addon                           │
│                    (Express.js / Stremio SDK)                   │
└───────────────────────────────┬─────────────────────────────────┘
                                │
                                │ Queries
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                      GitHub JSON Repo                            │
│         (tomartsh.github.io/Stremio-KanBoxRepos)                │
│  - stremio-kan88.json                                           │
│  - stremio-kanarchive.json                                       │
│  - stremio-kandigital.json                                      │
│  - stremio-kankids.json                                         │
│  - stremio-kanpodcasts.json                                     │
│  - stremio-kanteens.json                                        │
│  - stremio-reshet.json                                          │
└───────────────────────────────┬─────────────────────────────────┘
                                │
                                │ Scraped by
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                       Scraper Engine                             │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                    BaseScraper.js                        │   │
│  │  - Batch processing (parallel/sequential)                │   │
│  │  - Circuit breaker & rate limiting                       │   │
│  │  - JSON output & database updates                        │   │
│  │  - Delta tracking                                        │   │
│  └──────────────────────────────────────────────────────────┘   │
│                           │                                      │
│          ┌────────────────┼────────────────┐                    │
│          ▼                ▼                ▼                    │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐              │
│  │ Kan88       │  │ KanArchive  │  │ KanDigital  │              │
│  │ KanKids     │  │ KanPodcasts │  │ KanTeens    │              │
│  │ Reshet      │  │ Mako*       │  │             │              │
│  └─────────────┘  └─────────────┘  └─────────────┘              │
└───────────────────────────────┬─────────────────────────────────┘
                                │
                                │ Fetch from
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Content Providers                           │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐        │
│  │ kan.org  │  │ mako.co  │  │ 13tv.co  │  │ kankids  │        │
│  │   .il    │  │   .il    │  │   .il    │  │ .org.il  │        │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘        │
└─────────────────────────────────────────────────────────────────┘
```

* MakoScraper does not extend BaseScraper (unique requirements)

## Core Components

### 1. BaseScraper (`classes/BaseScraper.js`)

Abstract base class providing common functionality for all scrapers.

**Key Methods:**
- `crawl(isDoWriteFile)` - Template method for main scrape operation
- `crawlContent()` - Abstract method, implemented by subclasses
- `processBatch(items, processor, itemType)` - Batch processing with parallel/sequential modes
- `addToJsonObject(...)` - Add a series to the output
- `addVideoToMeta(...)` - Add an episode to an existing series
- `updateDatabase()` - Bulk update the database
- `writeJSON()` - Write output to JSON file

**Resilience Features:**
- Circuit Breaker - Pauses scraping after consecutive failures
- Rate Limiter - Sliding window rate limiting
- Delta Tracker - Records what changed during scrape

### 2. ScraperHelpers (`classes/ScraperHelpers.js`)

Shared utilities for common scraping tasks.

**Stream Extraction:**
```javascript
extractKanStream(pageElement, logger)     // Extract from Kan redge-player
extractVideoObjectUrl(pageElement, logger) // Fallback: extract from VideoObject
```

**Date Parsing:**
```javascript
parseIsraeliDate(dateString)              // Parse DD.MM.YYYY format
extractDateFromDataAttr(element)          // Extract from data-date attribute
extractDateFromDatetime(element)          // Extract from datetime attribute
extractReleaseDateGeneric(element)        // Universal date extractor
```

**Error Handling:**
```javascript
safeExecute(fn, logger, operationName, options)  // Execute with error handling
safeFetch(url, options, logger)                   // Fetch with retry logic
wrapProcessor(processor, logger, itemName)        // Wrap batch processor
```

**Rate Limiting:**
```javascript
CircuitBreaker(threshold, timeout)  // Pause after N failures
RateLimiter(requestsPerSecond)      // Sliding window limiter
```

### 3. Scraper Configuration (`classes/constants.js`)

Per-scraper settings for rate limiting and circuit breaking:

```javascript
SCRAPER_CONFIG: {
    'KanArchiveScraper': {
        parallelFetching: false,       // Sequential processing
        batchSize: 5,                  // Items per batch
        delayBetweenBatches: 1000,     // Delay between batches (ms)
        requestsPerSecond: 1,          // Rate limit
        circuitBreakerThreshold: 3,    // Failures before pause
        circuitBreakerTimeout: 120000  // Pause duration (ms)
    },
    // ... other scrapers
}
```

### 4. Testing Infrastructure

**ScraperTester (`classes/ScraperTester.js`)**
- Performance metrics collection
- Data validation
- Health checks
- Batch testing capabilities

**CLI Runner (`test-scrapers.js`)**
```bash
node test-scrapers.js              # Run all scrapers
node test-scrapers.js kan88        # Run specific scraper
node test-scrapers.js --health     # Health checks
node test-scrapers.js --validate   # Validate JSON output
```

## Data Flow

### Scraping Process

1. **Initialization**
   - Scraper extends BaseScraper with name and options
   - Configuration loaded from SCRAPER_CONFIG
   - Circuit breaker and rate limiter initialized

2. **Crawling**
   - `crawl()` called (template method)
   - `crawlContent()` executed (subclass-specific)
   - Items processed in batches via `processBatch()`

3. **Data Collection**
   - Series added via `addToJsonObject()`
   - Episodes added via `addVideoToMeta()`
   - Delta tracker records changes

4. **Output**
   - JSON file written to GitHub (if WRITE_TO_GITHUB)
   - Database updated in bulk (if UPDATE_DATABASE)

### Batch Processing

```
┌─────────────────────────────────────────────────────────┐
│                    processBatch()                       │
│  ┌───────────────────────────────────────────────────┐  │
│  │              Sequential Mode                      │  │
│  │  items.forEach(async (item, i) => {               │  │
│  │      await processor(item, i);                    │  │
│  │  });                                              │  │
│  └───────────────────────────────────────────────────┘  │
│                         OR                              │
│  ┌───────────────────────────────────────────────────┐  │
│  │              Parallel Batch Mode                  │  │
│  │  for (batch of items) {                           │  │
│  │      await Promise.all(batch.map(processor));     │  │
│  │      await sleep(delayBetweenBatches);            │  │
│  │  }                                                │  │
│  └───────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

## Resilience Patterns

### Circuit Breaker

```
┌──────────────────────────────────────────────────────────┐
│                   Circuit Breaker State                  │
│                                                           │
│  CLOSED ──failures >= threshold──▶ OPEN                 │
│    ▲                              │                     │
│    │                              │ timeout             │
│    │                              ▼                     │
│    └────────────── HALF_OPEN ──success── CLOSED        │
│                   (test with one request)               │
└──────────────────────────────────────────────────────────┘
```

- **CLOSED**: Normal operation, requests pass through
- **OPEN**: Circuit tripped, requests fail immediately
- **HALF_OPEN**: Testing if service has recovered

### Rate Limiter

Sliding window implementation tracking requests in the last second.

```
┌──────────────────────────────────────────────────────────┐
│              Sliding Window (1 second)                   │
│  ├───┬───┬───┬───┬───┬───┬───┬───┬───┬───┬───┬───┤     │
│  Req Req Req Req Req Req Req Req Req Req Req Req        │
│  └──────────────────────────────────────────────────────┘│
│                  ^ Current time                          │
│                  Count requests in window                │
│                  If >= limit, throttle                   │
└──────────────────────────────────────────────────────────┘
```

## Scraper-Specific Notes

### Kan Family (Kan88, KanArchive, KanDigital, KanKids, KanTeens, KanPodcasts)
- All extend BaseScraper
- Use `extractKanStream()` for stream extraction
- Share similar page structure (lobby pages)
- TMDB lookups removed (now on-demand in addon)

### Reshet
- Extends BaseScraper
- Uses Kaltura API for streams
- Israeli date parsing via `parseIsraeliDate()`
- No TMDB integration

### Mako
- **Does NOT extend BaseScraper** (unique architecture)
- Custom device ID generation
- Direct TmdbHelper usage
- Separate entitlement service for stream access

## JSON Output Format

```json
{
  "il_kan88_123": {
    "id": "il_kan88_123",
    "name": "Series Name",
    "link": "https://...",
    "type": "series",
    "subtype": "k",
    "meta": {
      "id": "il_kan88_123",
      "type": "series",
      "name": "Series Name",
      "background": "https://...",
      "poster": "https://...",
      "posterShape": "poster",
      "logo": "https://...",
      "description": "Series description",
      "genres": ["Drama", "Israel"],
      "videos": [
        {
          "id": "il_kan88_123:1:1",
          "name": "Episode Name",
          "season": 1,
          "episode": 1,
          "description": "Episode description",
          "thumbnail": "https://...",
          "released": "2024-01-15",
          "streams": [
            {
              "url": "https://...",
              "name": "Stream Name"
            }
          ]
        }
      ]
    }
  }
}
```

## Deployment

1. **Scrapers run** → Generate JSON files
2. **JSON files** → Committed to GitHub
3. **GitHub Pages** → Serves JSON at `tomartsh.github.io/Stremio-KanBoxRepos`
4. **Stremio Addon** → Fetches from GitHub Pages
5. **User** → Streams content through Stremio

## Environment

Required `.env` file in `classes/` directory:
```
TMDB_API_KEY=your_key_here  # Optional, not used by scrapers
```

## Future Considerations

- **CI/CD Integration**: Use ScraperTester for automated testing
- **Monitoring**: Expose circuit breaker and rate limiter metrics
- **Mako Refactoring**: Consider if patterns stabilize enough
- **Error Recovery**: Implement automatic retry with exponential backoff
