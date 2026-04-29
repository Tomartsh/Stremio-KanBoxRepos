# Database Setup Instructions

## Initial Setup (One-Time)

### 1. Create Supabase Project
1. Go to https://supabase.com
2. Create new project (free tier)
3. Note your project URL and keys

### 2. Set Up Environment Variables
Create `.env` file in project root:
```bash
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
SUPABASE_ANON_KEY=your-anon-key
```

**⚠️ IMPORTANT:** Never commit `.env` to git!

### 3. Create Database Tables
1. Open Supabase Dashboard
2. Go to SQL Editor
3. Copy contents of `schema.sql`
4. Paste and run

### 4. Install Dependencies
```bash
npm install @supabase/supabase-js
```

### 5. Run Initial Import
```bash
node scripts/initial-load.js
```

This will:
- Download all JSON files from GitHub
- Extract and load data into database
- Populate series, videos, and streams tables
- Report summary statistics

## Usage After Setup

### Run Scrapers (Normal Operation)
```bash
# Scrapers will now track changes via DeltaTracker
# Database updated automatically (future feature)

node main.js --scraper kandigital
```

### Database Query Examples
```javascript
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY
);

// Get latest series
const { data } = await supabase
    .from('series')
    .select('*')
    .eq('scraper', 'kandigital')
    .order('latest_episode_date', { ascending: false })
    .limit(100);
```

## File Locations

- `scripts/schema.sql` - Database schema (run in Supabase SQL Editor)
- `scripts/initial-load.js` - Initial database load (downloads from GitHub)
- `scripts/quick-import.js` - Fast import from local `build/` directory
- `classes/DatabaseUpdater.js` - Bulk database update logic

## Troubleshooting

### Import Fails
- Check `.env` has correct credentials (in `classes/` directory)
- Verify tables were created (run schema.sql first)
- Check network connectivity to GitHub
- Verify GitHub repository has JSON files

### Connection Issues
- Verify Supabase project is active
- Check network connectivity
- Validate API keys (use SERVICE_ROLE_KEY for bulk operations)

### Data Missing After Import
- Verify all JSON files were downloaded from GitHub
- Check Supabase dashboard for data
- Review import logs for errors

## Next Steps

After successful import:
1. ✅ Database is primary data source
2. ✅ JSON files become emergency backup
3. ✅ Scrapers track changes via DeltaTracker
4. ✅ Addon queries database (not files)

## Rollback

If you need to revert:
```bash
# Drop all tables (run in Supabase SQL Editor)
DROP TABLE IF EXISTS sync_logs CASCADE;
DROP TABLE IF EXISTS streams CASCADE;
DROP TABLE IF EXISTS videos CASCADE;
DROP TABLE IF EXISTS series CASCADE;

# Re-run this setup process
```
