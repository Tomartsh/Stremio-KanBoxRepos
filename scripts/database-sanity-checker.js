/**
 * ============================================================================
 * DATABASE SANITY CHECKER
 * ============================================================================
 *
 * Validates database integrity and data quality for Stremio addon.
 *
 * USAGE:
 *   node scripts/database-sanity-checker.js [options]
 *
 * OPTIONS:
 *   --fix          Actually fix issues (default: report only)
 *   --scraper=name Check only specific scraper (e.g., kanDigital)
 *   --table=name   Check only specific table (series, videos, streams)
 *   --quick        Run quick checks only (skip URL validations)
 *   --verbose      Show detailed output for each issue
 *
 * EXAMPLES:
 *   node scripts/database-sanity-checker.js                    # Report all issues
 *   node scripts/database-sanity-checker.js --fix              # Fix all issues
 *   node scripts/database-sanity-checker.js --scraper=kanDigital
 *   node scripts/database-sanity-checker.js --quick
 *
 * HTTP ENDPOINT (via main.js):
 *   /sanityCheck?mode=report&scraper=kanDigital&quick=false
 *
 * ============================================================================
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'classes', '.env') });
const { createClient } = require('@supabase/supabase-js');
const log4js = require('log4js');
const { LOG4JS } = require(path.join(__dirname, '..', 'classes', 'constants'));

// Configure logger - separate log file for sanity checker
log4js.configure({
    appenders: {
        out: { type: 'stdout' },
        SanityCheck: {
            type: LOG4JS.TYPE,
            filename: 'logs/sanity-check.log',
            maxLogSize: LOG4JS.MAX_SIZE,
            backups: LOG4JS.BACKUP_FILES,
        }
    },
    categories: { default: { appenders: ['SanityCheck', 'out'], level: LOG4JS.LEVEL } },
});

const logger = log4js.getLogger('SanityCheck');

class DatabaseSanityChecker {
    constructor(options = {}) {
        this.supabase = createClient(
            process.env.SUPABASE_URL,
            process.env.SUPABASE_SERVICE_ROLE_KEY
        );

        this.options = {
            fix: options.fix || false,
            scraper: options.scraper || null,
            table: options.table || null,
            quick: options.quick || false,
            verbose: options.verbose || false
        };

        this.validScrapers = [
            'kandigital', 'kanarchive', 'kankids', 'kanteens',
            'kanpodcasts', 'kan88', 'mako', 'reshet'
        ];

        this.results = {
            checksRun: 0,
            issuesFound: 0,
            issuesFixed: 0,
            errors: [],
            details: {
                series: { issues: [], fixed: [] },
                videos: { issues: [], fixed: [] },
                streams: { issues: [], fixed: [] },
                orphaned: { issues: [], fixed: [] },
                consistency: { issues: [], fixed: [] }
            },
            startTime: Date.now(),
            endTime: null
        };
    }

    /**
     * Fetch all records from Supabase with pagination (bypasses 1000 row limit)
     * @param {string} table - Table name
     * @param {object} query - Supabase query builder
     * @returns {Promise<Array>} - All records
     */
    async fetchAllRecords(table, query) {
        const pageSize = 1000;
        let allRecords = [];
        let page = 0;
        let hasMore = true;

        while (hasMore) {
            const { data, error } = await query.range(page * pageSize, (page + 1) * pageSize - 1);

            if (error) {
                throw new Error(`Error fetching ${table}: ${error.message}`);
            }

            if (data && data.length > 0) {
                allRecords = allRecords.concat(data);

                // Check if we got a full page (might be more records)
                if (data.length < pageSize) {
                    hasMore = false;
                } else {
                    page++;
                    // Small delay to avoid rate limiting
                    await new Promise(resolve => setTimeout(resolve, 50));
                }
            } else {
                hasMore = false;
            }
        }

        return allRecords;
    }

    /**
     * Delete all records with scraper='kandigital' (il_kan_dogital typo bug)
     * This will cascade delete all associated videos and streams
     */
    async deleteDogitalRecords() {
        logger.info('Checking for il_kan_dogital typo records...');

        // Check if any records exist with scraper='kandigital'
        const { data: dogitalSeries, error } = await this.supabase
            .from('series')
            .select('id')
            .eq('scraper', 'kandigital');

        if (error) {
            logger.error(`Error checking for dogital records: ${error.message}`);
            return;
        }

        if (!dogitalSeries || dogitalSeries.length === 0) {
            logger.info('✅ No il_kan_dogital typo records found\n');
            return;
        }

        const count = dogitalSeries.length;
        logger.warn(`⚠️  Found ${count} series with scraper='kandigital' (il_kan_dogital typo)`);

        if (!this.options.fix) {
            logger.info(`   Run with --fix to delete these ${count} series and all their videos/streams\n`);
            this.results.issuesFound += count;
            this.results.details.series.issues.push({
                type: 'dogital_typo',
                count: count,
                message: `${count} series with scraper='kandigital' typo need deletion`
            });
            return;
        }

        // Delete all series with scraper='kandigital'
        // Cascade delete will handle videos and streams
        logger.info(`   Deleting ${count} series with scraper='kandigital'...`);

        const { error: deleteError } = await this.supabase
            .from('series')
            .delete()
            .eq('scraper', 'kandigital');

        if (deleteError) {
            logger.error(`   ❌ Failed to delete dogital records: ${deleteError.message}`);
            return;
        }

        this.results.issuesFixed += count;
        this.results.details.series.fixed.push({
            action: 'deleted_dogital_typo_records',
            count: count
        });

        logger.info(`   ✅ Deleted ${count} series (cascade deleted all videos/streams)\n`);
    }

    /**
     * Run all sanity checks
     */
    async run() {
        logger.info('============================================================');
        logger.info('DATABASE SANITY CHECKER');
        logger.info('============================================================');
        logger.info(`Mode: ${this.options.fix ? 'FIX' : 'REPORT'}`);
        if (this.options.scraper) logger.info(`Scraper: ${this.options.scraper}`);
        if (this.options.table) logger.info(`Table: ${this.options.table}`);
        if (this.options.quick) logger.info(`Quick mode: enabled (skip URL validations)`);
        logger.info('============================================================\n');

        try {
            // Test database connection
            await this.testConnection();

            // Delete dogital typo records (highest priority - affects other checks)
            if (!this.options.table || this.options.table === 'series') {
                await this.deleteDogitalRecords();
            }

            // Run checks based on options
            if (!this.options.table || this.options.table === 'series') {
                await this.checkSeries();
            }

            if (!this.options.table || this.options.table === 'videos') {
                await this.checkVideos();
            }

            if (!this.options.table || this.options.table === 'streams') {
                await this.checkStreams();
            }

            if (!this.options.table) {
                await this.checkOrphanedRecords();
                await this.checkDataConsistency();
            }

            this.results.endTime = Date.now();
            this.printSummary();

            return this.results;

        } catch (error) {
            logger.error(`Fatal error: ${error.message}`);
            throw error;
        }
    }

    /**
     * Test database connection
     */
    async testConnection() {
        logger.info('Testing database connection...');
        const { error } = await this.supabase.from('series').select('id').limit(1);

        if (error) {
            throw new Error(`Database connection failed: ${error.message}`);
        }

        logger.info('✅ Database connection OK\n');
        this.results.checksRun++;
    }

    /**
     * Check series table
     */
    async checkSeries() {
        logger.info('Checking series table...');
        this.results.checksRun++;

        let query = this.supabase.from('series').select('*');

        if (this.options.scraper) {
            query = query.eq('scraper', this.options.scraper);
        }

        const series = await this.fetchAllRecords('series', query);
        logger.info(`Found ${series.length} series to check`);

        for (const s of series) {
            const issues = [];

            // Check 1: Name is required
            if (!s.name || s.name.trim() === '') {
                issues.push('Missing or empty name');
            }

            // Check 2: Name is not just placeholder text
            if (s.name && ['null', 'undefined', 'n/a', 'n\a', '-', ''].includes(s.name.toLowerCase().trim())) {
                issues.push(`Invalid placeholder name: "${s.name}"`);
            }

            // Check 3: Scraper is valid
            if (s.scraper && !this.validScrapers.includes(s.scraper.toLowerCase())) {
                issues.push(`Invalid scraper value: "${s.scraper}"`);
            }

            // Check 4: Link is valid URL if present
            if (s.link && !this.options.quick) {
                if (!this.isValidUrl(s.link)) {
                    issues.push(`Invalid link URL: "${s.link}"`);
                }
            }

            // Check 5: Poster is valid URL if present
            if (s.poster && !this.options.quick) {
                if (!this.isValidUrl(s.poster)) {
                    issues.push(`Invalid poster URL: "${s.poster}"`);
                }
            }

            // Check 6: Background is valid URL if present
            if (s.background && !this.options.quick) {
                if (!this.isValidUrl(s.background)) {
                    issues.push(`Invalid background URL: "${s.background}"`);
                }
            }

            // Check 7: Type is valid if present
            if (s.type && !['movie', 'series', 'channel', 'tv'].includes(s.type)) {
                issues.push(`Invalid type: "${s.type}"`);
            }

            // Check 8: Genres is valid array
            if (s.genres && !Array.isArray(s.genres)) {
                issues.push(`Genres is not an array: ${typeof s.genres}`);
            }

            // Log issues
            if (issues.length > 0) {
                this.results.issuesFound += issues.length;
                this.results.details.series.issues.push({ id: s.id, scraper: s.scraper, name: s.name, issues });

                if (this.options.verbose) {
                    logger.warn(`  [${s.scraper}] ${s.id}: ${issues.join(', ')}`);
                }

                // Fix if needed
                if (this.options.fix) {
                    await this.fixSeries(s, issues);
                }
            }
        }

        logger.info(`✅ Series check complete: ${this.results.details.series.issues.length} series with issues\n`);
    }

    /**
     * Check videos table
     */
    async checkVideos() {
        logger.info('Checking videos table...');
        this.results.checksRun++;

        let query = this.supabase.from('videos').select('*');

        // Filter by scraper if specified
        if (this.options.scraper) {
            // Get series IDs for the scraper first (with pagination)
            const seriesData = await this.fetchAllRecords(
                'series',
                this.supabase.from('series').select('id').eq('scraper', this.options.scraper)
            );

            if (seriesData && seriesData.length > 0) {
                const seriesIds = seriesData.map(s => s.id);
                query = query.in('series_id', seriesIds);
            }
        }

        const videos = await this.fetchAllRecords('videos', query);
        logger.info(`Found ${videos.length} videos to check`);

        for (const v of videos) {
            const issues = [];

            // Check 1: Title is present and meaningful
            if (!v.title || v.title.trim() === '') {
                issues.push('Missing or empty title');
            }

            // Check 2: Title is not placeholder
            if (v.title && ['null', 'undefined', 'n/a', 'n\a', '-', '', 'episode'].includes(v.title.toLowerCase().trim())) {
                issues.push(`Invalid placeholder title: "${v.title}"`);
            }

            // Check 3: Series reference is valid
            if (!v.series_id || v.series_id.trim() === '') {
                issues.push('Missing series_id');
            }

            // Check 4: episode_link is valid URL if present
            if (v.episode_link && !this.options.quick) {
                if (!this.isValidUrl(v.episode_link)) {
                    issues.push(`Invalid episode_link URL: "${v.episode_link}"`);
                }
            }

            // Check 5: Thumbnail is valid URL if present
            if (v.thumbnail && !this.options.quick) {
                if (!this.isValidUrl(v.thumbnail)) {
                    issues.push(`Invalid thumbnail URL: "${v.thumbnail}"`);
                }
            }

            // Check 6: Season is valid number if present
            if (v.season !== null && v.season !== undefined) {
                if (typeof v.season !== 'number' || v.season < 0 || v.season > 100) {
                    issues.push(`Invalid season value: ${v.season}`);
                }
            }

            // Check 7: Episode is valid number if present
            if (v.episode !== null && v.episode !== undefined) {
                if (typeof v.episode !== 'number' || v.episode < 0 || v.episode > 1000) {
                    issues.push(`Invalid episode value: ${v.episode}`);
                }
            }

            // Check 8: ID format matches expected pattern (seriesId:s:season:e:episode)
            if (v.id && !v.id.includes(':')) {
                issues.push(`Video ID doesn't follow expected format: "${v.id}"`);
            }

            // Log issues
            if (issues.length > 0) {
                this.results.issuesFound += issues.length;
                this.results.details.videos.issues.push({ id: v.id, series_id: v.series_id, title: v.title, issues });

                if (this.options.verbose) {
                    logger.warn(`  Video ${v.id}: ${issues.join(', ')}`);
                }

                // Fix if needed
                if (this.options.fix) {
                    await this.fixVideo(v, issues);
                }
            }
        }

        logger.info(`✅ Videos check complete: ${this.results.details.videos.issues.length} videos with issues\n`);
    }

    /**
     * Check streams table
     */
    async checkStreams() {
        logger.info('Checking streams table...');
        this.results.checksRun++;

        let query = this.supabase.from('streams').select('*, videos(series_id)');

        // Filter by scraper if specified (need to join through videos)
        if (this.options.scraper) {
            const seriesData = await this.fetchAllRecords(
                'series',
                this.supabase.from('series').select('id').eq('scraper', this.options.scraper)
            );

            if (seriesData && seriesData.length > 0) {
                const seriesIds = seriesData.map(s => s.id);
                const videosData = await this.fetchAllRecords(
                    'videos',
                    this.supabase.from('videos').select('id').in('series_id', seriesIds)
                );

                if (videosData && videosData.length > 0) {
                    const videoIds = videosData.map(v => v.id);
                    query = this.supabase.from('streams').select('*').in('video_id', videoIds);
                } else {
                    // No videos found for this scraper, skip streams check
                    logger.info('No videos found for this scraper, skipping streams check');
                    return;
                }
            }
        }

        const streams = await this.fetchAllRecords('streams', query);
        logger.info(`Found ${streams.length} streams to check`);

        for (const s of streams) {
            const issues = [];

            // Check 1: URL is required
            if (!s.url || s.url.trim() === '') {
                issues.push('Missing URL');
            }

            // Check 2: URL is valid (but allow dynamic/stream URLs)
            if (s.url && !this.options.quick) {
                // Some scrapers don't have actual stream URLs - they're retrieved on demand
                // Allow common patterns for dynamic URLs
                if (!this.isValidUrl(s.url) && !s.url.includes('{') && !s.url.includes('$')) {
                    issues.push(`Invalid stream URL: "${s.url}"`);
                }
            }

            // Check 3: video_id is present
            if (!s.video_id || s.video_id.trim() === '') {
                issues.push('Missing video_id');
            }

            // Check 4: Quality is valid if present
            if (s.quality && !['Unknown', '360p', '480p', '720p', '1080p', '4K'].includes(s.quality)) {
                // Allow other quality values but warn
                if (!s.quality.match(/^\d+p$/) && !s.quality.match(/^\d+x\d+$/)) {
                    issues.push(`Unusual quality value: "${s.quality}"`);
                }
            }

            // Log issues
            if (issues.length > 0) {
                this.results.issuesFound += issues.length;
                this.results.details.streams.issues.push({ id: s.id, video_id: s.video_id, url: s.url, issues });

                if (this.options.verbose) {
                    logger.warn(`  Stream ${s.id}: ${issues.join(', ')}`);
                }

                // Fix if needed
                if (this.options.fix) {
                    await this.fixStream(s, issues);
                }
            }
        }

        logger.info(`✅ Streams check complete: ${this.results.details.streams.issues.length} streams with issues\n`);
    }

    /**
     * Check for orphaned records
     */
    async checkOrphanedRecords() {
        logger.info('Checking for orphaned records...');
        this.results.checksRun++;

        // Get all valid series IDs (with pagination)
        let seriesQuery = this.supabase.from('series').select('id');
        if (this.options.scraper) {
            seriesQuery = seriesQuery.eq('scraper', this.options.scraper);
        }
        const allSeries = await this.fetchAllRecords('series', seriesQuery);
        const seriesIds = new Set(allSeries.map(s => s.id));

        // Get all valid video IDs (with pagination)
        let videoQuery = this.supabase.from('videos').select('id');
        if (this.options.scraper) {
            videoQuery = videoQuery.in('series_id', Array.from(seriesIds));
        }
        const allVideos = await this.fetchAllRecords('videos', videoQuery);
        const videoIds = new Set(allVideos.map(v => v.id));

        // Check 1: Videos without series (fetch all videos and filter)
        let allVideosQuery = this.supabase.from('videos').select('id, series_id');
        if (this.options.scraper) {
            // For scraper filter, we need to check against the specific series IDs
            const scraperSeries = await this.fetchAllRecords(
                'series',
                this.supabase.from('series').select('id').eq('scraper', this.options.scraper)
            );
            const scraperSeriesIds = new Set(scraperSeries.map(s => s.id));
            const allVideosForScraper = await this.fetchAllRecords(
                'videos',
                this.supabase.from('videos').select('id, series_id')
            );
            var orphanedVideos = allVideosForScraper.filter(v => !scraperSeriesIds.has(v.series_id));
        } else {
            const allVideosList = await this.fetchAllRecords(
                'videos',
                this.supabase.from('videos').select('id, series_id')
            );
            var orphanedVideos = allVideosList.filter(v => !seriesIds.has(v.series_id));
        }

        if (orphanedVideos && orphanedVideos.length > 0) {
            this.results.issuesFound += orphanedVideos.length;
            this.results.details.orphaned.issues.push({
                type: 'orphaned_videos',
                count: orphanedVideos.length,
                items: orphanedVideos.slice(0, 10).map(v => v.id)
            });

            logger.warn(`  Found ${orphanedVideos.length} videos without matching series`);

            if (this.options.verbose && orphanedVideos.length > 0) {
                orphanedVideos.slice(0, 5).forEach(v => {
                    logger.warn(`    Orphaned video: ${v.id} (series_id: ${v.series_id})`);
                });
            }

            // Fix: Delete orphaned videos
            if (this.options.fix) {
                logger.info(`  Deleting ${orphanedVideos.length} orphaned videos...`);
                const idsToDelete = orphanedVideos.map(v => v.id);

                // Delete in batches
                const batchSize = 1000;
                for (let i = 0; i < idsToDelete.length; i += batchSize) {
                    const batch = idsToDelete.slice(i, i + batchSize);
                    // Delete streams first, then videos
                    await this.supabase.from('streams').delete().in('video_id', batch);
                    await this.supabase.from('videos').delete().in('id', batch);
                }

                this.results.issuesFixed += orphanedVideos.length;
                this.results.details.orphaned.fixed.push({ action: 'deleted_orphaned_videos', count: orphanedVideos.length });
            }
        }

        // Check 2: Streams without videos (fetch all streams and filter)
        const allStreamsList = await this.fetchAllRecords(
            'streams',
            this.supabase.from('streams').select('id, video_id')
        );
        const orphanedStreams = allStreamsList.filter(s => !videoIds.has(s.video_id));

        if (orphanedStreams && orphanedStreams.length > 0) {
            this.results.issuesFound += orphanedStreams.length;
            this.results.details.orphaned.issues.push({
                type: 'orphaned_streams',
                count: orphanedStreams.length,
                items: orphanedStreams.slice(0, 10).map(s => s.id)
            });

            logger.warn(`  Found ${orphanedStreams.length} streams without matching videos`);

            if (this.options.verbose && orphanedStreams.length > 0) {
                orphanedStreams.slice(0, 5).forEach(s => {
                    logger.warn(`    Orphaned stream: ${s.id} (video_id: ${s.video_id})`);
                });
            }

            // Fix: Delete orphaned streams
            if (this.options.fix) {
                logger.info(`  Deleting ${orphanedStreams.length} orphaned streams...`);
                const streamIds = orphanedStreams.map(s => s.id);
                await this.supabase.from('streams').delete().in('id', streamIds);

                this.results.issuesFixed += orphanedStreams.length;
                this.results.details.orphaned.fixed.push({ action: 'deleted_orphaned_streams', count: orphanedStreams.length });
            }
        }

        logger.info('✅ Orphaned records check complete\n');
    }

    /**
     * Check data consistency (OPTIMIZED - single query instead of per-series queries)
     */
    async checkDataConsistency() {
        logger.info('Checking data consistency...');
        this.results.checksRun++;

        // Get all series with their video counts
        let query = this.supabase.from('series').select('id, video_count, scraper');

        if (this.options.scraper) {
            query = query.eq('scraper', this.options.scraper);
        }

        const series = await this.fetchAllRecords('series', query);
        if (!series || series.length === 0) return;

        logger.info(`Checking video_count for ${series.length} series...`);

        // OPTIMIZED: Get all video counts in a single query grouped by series_id
        // This requires using a raw SQL query or doing it client-side
        // For now, we'll fetch all videos and count client-side (much faster than 1714 queries)

        let videoQuery = this.supabase.from('videos').select('series_id');
        if (this.options.scraper) {
            const seriesIds = series.map(s => s.id);
            videoQuery = videoQuery.in('series_id', seriesIds);
        }

        const allVideos = await this.fetchAllRecords('videos', videoQuery);

        // Count videos per series
        const videoCounts = {};
        for (const v of allVideos) {
            videoCounts[v.series_id] = (videoCounts[v.series_id] || 0) + 1;
        }

        // Check each series
        let mismatches = 0;
        for (const s of series) {
            const actualCount = videoCounts[s.id] || 0;
            const storedCount = s.video_count || 0;

            if (actualCount !== storedCount) {
                mismatches++;
                this.results.issuesFound++;
                this.results.details.consistency.issues.push({
                    id: s.id,
                    scraper: s.scraper,
                    issue: `video_count mismatch: stored=${storedCount}, actual=${actualCount}`
                });

                if (this.options.verbose || mismatches <= 20) {
                    logger.warn(`  [${s.scraper}] ${s.id}: video_count is ${storedCount} but should be ${actualCount}`);
                }

                // Fix: Update video_count
                if (this.options.fix) {
                    await this.supabase
                        .from('series')
                        .update({ video_count: actualCount })
                        .eq('id', s.id);

                    this.results.issuesFixed++;
                    this.results.details.consistency.fixed.push({
                        id: s.id,
                        action: 'updated_video_count',
                        value: actualCount
                    });
                }
            }
        }

        if (mismatches > 20) {
            logger.warn(`  ... and ${mismatches - 20} more series with video_count mismatches`);
        }

        logger.info('✅ Data consistency check complete\n');
    }

    /**
     * Fix series issues
     */
    async fixSeries(series, issues) {
        const updates = {};

        for (const issue of issues) {
            if (issue.includes('Invalid scraper value')) {
                // Try to fix scraper value
                const fixedScraper = this.validScrapers.find(vs => series.scraper.toLowerCase().includes(vs));
                if (fixedScraper) {
                    updates.scraper = fixedScraper;
                }
            }
            // Add more fix logic as needed
        }

        if (Object.keys(updates).length > 0) {
            const { error } = await this.supabase
                .from('series')
                .update(updates)
                .eq('id', series.id);

            if (!error) {
                this.results.issuesFixed++;
                this.results.details.series.fixed.push({ id: series.id, updates });
                logger.info(`  Fixed series ${series.id}: ${JSON.stringify(updates)}`);
            } else {
                logger.error(`  Failed to fix series ${series.id}: ${error.message}`);
            }
        }
    }

    /**
     * Fix video issues
     */
    async fixVideo(video, issues) {
        const updates = {};

        // Fix title placeholders
        if (video.title && ['null', 'undefined', 'n/a', 'n\a', '-'].includes(video.title.toLowerCase().trim())) {
            updates.title = `Episode ${video.episode || '?'}`;
        }

        if (Object.keys(updates).length > 0) {
            const { error } = await this.supabase
                .from('videos')
                .update(updates)
                .eq('id', video.id);

            if (!error) {
                this.results.issuesFixed++;
                this.results.details.videos.fixed.push({ id: video.id, updates });
                logger.info(`  Fixed video ${video.id}: ${JSON.stringify(updates)}`);
            }
        }
    }

    /**
     * Fix stream issues
     */
    async fixStream(stream, issues) {
        // For now, streams can only be deleted, not fixed
        // This is a placeholder for future fix logic
    }

    /**
     * Validate URL format
     */
    isValidUrl(string) {
        try {
            const url = new URL(string);
            return url.protocol === 'http:' || url.protocol === 'https:';
        } catch (_) {
            return false;
        }
    }

    /**
     * Print summary of results
     */
    printSummary() {
        const duration = ((this.results.endTime - this.results.startTime) / 1000).toFixed(2);

        logger.info('\n============================================================');
        logger.info('SANITY CHECK SUMMARY');
        logger.info('============================================================');
        logger.info(`Checks Run:        ${this.results.checksRun}`);
        logger.info(`Issues Found:      ${this.results.issuesFound}`);
        logger.info(`Issues Fixed:      ${this.results.issuesFixed}`);
        logger.info(`Duration:          ${duration} seconds`);
        logger.info('============================================================');

        // Print breakdown
        if (this.results.details.series.issues.length > 0) {
            logger.info(`Series issues:     ${this.results.details.series.issues.length}`);
        }
        if (this.results.details.videos.issues.length > 0) {
            logger.info(`Video issues:      ${this.results.details.videos.issues.length}`);
        }
        if (this.results.details.streams.issues.length > 0) {
            logger.info(`Stream issues:     ${this.results.details.streams.issues.length}`);
        }
        if (this.results.details.orphaned.issues.length > 0) {
            logger.info(`Orphaned records:  ${this.results.details.orphaned.issues.reduce((sum, i) => sum + (i.count || 1), 0)}`);
        }
        if (this.results.details.consistency.issues.length > 0) {
            logger.info(`Consistency:       ${this.results.details.consistency.issues.length}`);
        }

        if (this.results.issuesFound === 0) {
            logger.info('\n✅ No issues found! Database is healthy.');
        } else if (!this.options.fix) {
            logger.info(`\n⚠️  Run with --fix to repair these issues.`);
        } else {
            logger.info(`\n✅ Fixed ${this.results.issuesFixed} issues.`);
        }

        logger.info('============================================================\n');
    }

    /**
     * Export results as JSON
     */
    exportResults() {
        return {
            options: this.options,
            results: this.results,
            timestamp: new Date().toISOString()
        };
    }
}

// CLI interface
async function main() {
    const args = process.argv.slice(2);
    const options = {
        fix: args.includes('--fix'),
        quick: args.includes('--quick'),
        verbose: args.includes('--verbose')
    };

    // Parse named arguments
    for (const arg of args) {
        if (arg.startsWith('--scraper=')) {
            options.scraper = arg.split('=')[1];
        } else if (arg.startsWith('--table=')) {
            options.table = arg.split('=')[1];
        }
    }

    const checker = new DatabaseSanityChecker(options);

    try {
        await checker.run();
        process.exit(0);
    } catch (error) {
        logger.error(`Error: ${error.message}`);
        process.exit(1);
    }
}

// Run if called directly
if (require.main === module) {
    main();
}

module.exports = DatabaseSanityChecker;
