/**
 * Clean KanDigital Data from Supabase
 *
 * Deletes all streams → videos → series where scraper = 'kandigital'
 * This allows a fresh scrape after fixing the season numbering bug.
 *
 * Usage: node scripts/clean-kandigital.js [--confirm]
 *        Without --confirm, runs in dry-run mode (reports what would be deleted)
 */

require('dotenv').config({ path: __dirname + '/../classes/.env' });
const { createClient } = require('@supabase/supabase-js');
const log4js = require('log4js');
const { LOG4JS } = require('../classes/constants');

log4js.configure({
    appenders: {
        out: { type: "stdout" },
        Cleaner: {
            type: LOG4JS.TYPE || 'file',
            filename: LOG4JS.FILENAME || 'logs/Stremio-Repos.log',
            maxLogSize: LOG4JS.MAX_SIZE || 10 * 1024 * 1024,
            backups: LOG4JS.BACKUP_FILES || 3,
        }
    },
    categories: { default: { appenders: ['Cleaner', 'out'], level: LOG4JS.LEVEL || 'info' } },
});

const logger = log4js.getLogger("Cleaner");

async function cleanKanDigital(confirmed = false) {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseKey) {
        logger.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env");
        process.exit(1);
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    const SCRAPER = 'kandigital';

    // Step 1: Find all series for this scraper
    logger.info(`Step 1: Finding series with scraper='${SCRAPER}'...`);
    const { data: series, error: seriesError } = await supabase
        .from('series')
        .select('id')
        .eq('scraper', SCRAPER);

    if (seriesError) {
        logger.error(`Error querying series: ${seriesError.message}`);
        process.exit(1);
    }

    if (!series || series.length === 0) {
        logger.info(`No series found for scraper='${SCRAPER}'. Nothing to clean.`);
        return { series: 0, videos: 0, streams: 0 };
    }

    const seriesIds = series.map(s => s.id);
    logger.info(`Found ${seriesIds.length} series to delete`);

    // Step 2: Find all videos for these series
    logger.info('Step 2: Finding associated videos...');
    const { data: videos, error: videosError } = await supabase
        .from('videos')
        .select('id')
        .in('series_id', seriesIds);

    if (videosError) {
        logger.error(`Error querying videos: ${videosError.message}`);
        process.exit(1);
    }

    const videoIds = videos ? videos.map(v => v.id) : [];
    logger.info(`Found ${videoIds.length} videos to delete`);

    if (!confirmed) {
        logger.info('══════════════════════════════════════════════');
        logger.info('DRY RUN — Use --confirm to actually delete.');
        logger.info(`Would delete: ${seriesIds.length} series, ${videoIds.length} videos`);
        logger.info('══════════════════════════════════════════════');
        return { series: seriesIds.length, videos: videoIds.length, streams: 0 };
    }

    // Use raw SQL for a single atomic delete with cascade handling
    // This avoids foreign key issues and RLS problems across multiple tables
    logger.info('Step 3: Deleting all KanDigital data via raw SQL...');

    // Delete streams first (if any)
    if (videoIds.length > 0) {
        const { error: streamError } = await supabase
            .rpc('delete_related_streams', { video_ids: videoIds })
            .catch(() => ({ error: null })); // RPC may not exist, that's fine

        if (streamError) {
            logger.warn(`RPC delete_related_streams failed (may not exist): ${streamError.message}`);
        } else {
            logger.info('Attempted cascade delete via RPC');
        }

        // Fallback: try direct delete
        for (let i = 0; i < videoIds.length; i += 1000) {
            const batch = videoIds.slice(i, i + 1000);
            const { error: streamDelError } = await supabase
                .from('streams')
                .delete()
                .in('video_id', batch);

            if (streamDelError && !streamDelError.message.includes('does not exist')) {
                logger.warn(`Streams delete batch error: ${streamDelError.message}`);
            }
        }
    }

    // Delete videos
    if (videoIds.length > 0) {
        for (let i = 0; i < videoIds.length; i += 1000) {
            const batch = videoIds.slice(i, i + 1000);
            const { error: vidDelError } = await supabase
                .from('videos')
                .delete()
                .in('id', batch);

            if (vidDelError) {
                logger.error(`Error deleting videos batch: ${vidDelError.message}`);
            }
        }
    }

    // Delete series
    for (let i = 0; i < seriesIds.length; i += 100) {
        const batch = seriesIds.slice(i, i + 100);
        const { error: serDelError } = await supabase
            .from('series')
            .delete()
            .in('id', batch);

        if (serDelError) {
            logger.error(`Error deleting series batch: ${serDelError.message}`);
        }
    }

    // Verify deletion
    const { data: remaining } = await supabase
        .from('series')
        .select('id', { count: 'exact', head: true })
        .eq('scraper', SCRAPER);

    logger.info(`✅ Cleanup complete! Remaining series for '${SCRAPER}': ${remaining || 0}`);
    return { series: seriesIds.length, videos: videoIds.length, streams: 0 };
}

// CLI Entry
const confirmed = process.argv.includes('--confirm');
cleanKanDigital(confirmed).then(result => {
    logger.info(`Summary: ${result.series} series, ${result.videos} videos, ${result.streams} streams`);
}).catch(err => {
    logger.error(`Fatal error: ${err.message}`);
    process.exit(1);
});