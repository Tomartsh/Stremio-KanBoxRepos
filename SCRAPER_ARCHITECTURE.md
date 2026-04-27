# Scraper Architecture Guide

## Overview
All scrapers now follow a unified 3-step architecture:
1. **Scrape** → Generate JSON in memory
2. **Write to GitHub** → Upload JSON files (optional)
3. **Update Database** → Bulk import to database (optional)

## Configuration

Add these constants to `classes/constants.js`:
```javascript
WRITE_TO_GITHUB: true,     // Control GitHub uploads
UPDATE_DATABASE: true,     // Control database updates
```

## Implementation Pattern for Each Scraper

### 1. Import DatabaseUpdater
```javascript
const DatabaseUpdater = require('./DatabaseUpdater');
```

### 2. Add `updateDatabase()` method
```javascript
async updateDatabase() {
    logger.trace("updateDatabase => Entered");
    logger.debug("updateDatabase => Starting bulk database update");

    const dbUpdater = new DatabaseUpdater();

    try {
        const result = await dbUpdater.updateFromJSON('scrapername', this._jsonObject);
        logger.info(`updateDatabase => ✅ Updated ${result.series} series, ${result.videos} videos, ${result.streams} streams in ${result.duration}s`);
    } catch (error) {
        logger.error(`updateDatabase => ❌ Failed to update database: ${error.message}`);
        throw error;
    }

    logger.trace("updateDatabase => Leaving");
}
```

### 3. Update `crawl()` method
Replace the existing write logic:
```javascript
// OLD CODE:
if (isDoWriteFile){
    logger.info("crawl => writing JSON file");
    this.writeJSON();
}

// NEW CODE:
const { WRITE_TO_GITHUB, UPDATE_DATABASE } = require('./constants.js');

if (WRITE_TO_GITHUB || UPDATE_DATABASE) {
    if (WRITE_TO_GITHUB) {
        logger.info("crawl => writing JSON file to GitHub");
        this.writeJSON();
    }

    if (UPDATE_DATABASE) {
        logger.info("crawl => updating database in bulk");
        await this.updateDatabase();
    }
} else if (isDoWriteFile) {
    // Backward compatibility
    logger.info("crawl => writing JSON file");
    this.writeJSON();
}
```

## Scraper-Specific Values

| Scraper | JSON Object | Scraper Name | Export Filename |
|---------|-------------|--------------|-----------------|
| KanDigital | `this._kanDigitalJSONObj` | `kandigital` | `stremio-kandigital` |
| KanArchive | `this._kanArchiveJSONObj` | `kanarchive` | `stremio-kanarchive` |
| KanKids | `this._kanKidsJSONObj` | `kankids` | `stremio-kankids` |
| KanTeens | `this._kanTeensJSONObj` | `kanteens` | `stremio-kanteens` |
| Kan88 | `this._kan88JSONObj` | `kan88` | `stremio-kan88` |
| KanPodcasts | `this._kanPodcastsJSONObj` | `kanpodcasts` | `stremio-kanpodcasts` |
| Mako | `this._makoJSONObj` | `mako` | `stremio-mako` |
| Reshet | `this._reshetJSONObj` | `reshet` | `stremio-reshet` |

## Example: run-kandigital.js
```javascript
require('dotenv').config({ path: './classes/.env' });
const KanDigitalScraper = require('./classes/KanDigitalScraper.js');
const { WRITE_TO_GITHUB, UPDATE_DATABASE } = require('./classes/constants.js');

async function runKanDigital() {
    console.log('🚀 Starting KanDigital scraper...');
    console.log(`📝 Write to GitHub: ${WRITE_TO_GITHUB ? '✅' : '❌'}`);
    console.log(`🗄️  Update Database: ${UPDATE_DATABASE ? '✅' : '❌'}`);

    const scraper = new KanDigitalScraper();
    await scraper.crawl();
}

runKanDigital().catch(console.error);
```

## Benefits
- ✅ Clean separation of concerns
- ✅ GitHub is source of truth
- ✅ Database is just a cache/index
- ✅ Both steps are optional and controllable
- ✅ Easy to disable one without affecting the other
- ✅ Version history in GitHub
- ✅ Easy rollback if needed
