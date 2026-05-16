require('dotenv').config({ path: './classes/.env' });
const { createClient } = require('@supabase/supabase-js');
const log4js = require('log4js');
const { LOG4JS } = require('./constants');
const DeltaUpdater = require('./DeltaUpdater.js');

log4js.configure({
    appenders: {
        out: { type: "stdout" },
        DatabaseUpdater:
        {
            type: LOG4JS.TYPE,
            filename: LOG4JS.FILENAME,
            maxLogSize: LOG4JS.MAX_SIZE,
            backups: LOG4JS.BACKUP_FILES,
        }
    },
    categories: { default: { appenders: ['DatabaseUpdater','out'], level: LOG4JS.LEVEL } },
});

const logger = log4js.getLogger("DatabaseUpdater");

class DatabaseUpdater {
    constructor() {
        this.supabase = createClient(
            process.env.SUPABASE_URL,
            process.env.SUPABASE_SERVICE_ROLE_KEY
        );
    }

    /**
     * Bulk update database from JSON object
     * @param {string} scraper - Scraper name (e.g., 'mako', 'kanteens')
     * @param {object} jsonData - The scraped data object with series as keys
     */
    async updateFromJSON(scraper, jsonData) {
        logger.info(`DatabaseUpdater => Starting bulk update for ${scraper}...`);
        const startTime = Date.now();

        try {
            // Prepare all data in memory first
            const seriesToInsert = [];
            const videosToInsert = [];
            const streamsToInsert = [];

            for (const [seriesId, series] of Object.entries(jsonData)) {
                // Extract series data
                const seriesData = {
                    id: seriesId,
                    scraper: scraper,
                    name: series.meta?.name || series.name,
                    poster: series.meta?.poster || series.poster,
                    // poster_shape: series.meta?.posterShape, // Column doesn't exist in database
                    background: series.meta?.background || series.poster,
                    description: series.meta?.description,
                    link: series.link,
                    type: series.type,
                    subtype: series.subtype,
                    genres: series.meta?.genres || [],
                    tmdb_id: series.meta?.tmdbId
                };
                seriesToInsert.push(seriesData);

                // Extract videos
                const videos = series.meta?.videos || [];
                for (const video of videos) {
                    videosToInsert.push({
                        id: video.id,
                        series_id: seriesId,
                        title: video.name || video.title,
                        season: video.season,
                        episode: video.episode,
                        description: video.description,
                        thumbnail: video.thumbnail,
                        episode_link: video.episodeLink,
                        released: video.released,
                        tmdb_episode_id: video.tmdbEpisodeId
                    });

                    // Extract streams (deduplicated by URL)
                    const streams = video.streams || [];
                    const seenUrls = new Set();
                    for (const stream of streams) {
                        if (!stream.url || seenUrls.has(stream.url)) continue;
                        seenUrls.add(stream.url);

                        streamsToInsert.push({
                            video_id: video.id,
                            url: stream.url,
                            title: stream.name || 'Stream',
                            description: stream.description,
                            quality: stream.quality
                        });
                    }
                }
            }

            logger.info(`DatabaseUpdater => Prepared: ${seriesToInsert.length} series, ${videosToInsert.length} videos, ${streamsToInsert.length} streams`);

            // Delete existing data for this scraper
            logger.info(`DatabaseUpdater => Clearing old data for ${scraper}...`);
            const { data: existingSeries } = await this.supabase
                .from('series')
                .select('id')
                .eq('scraper', scraper);

            if (existingSeries && existingSeries.length > 0) {
                const seriesIds = existingSeries.map(s => s.id);

                // Get all video IDs first
                const { data: allVideos } = await this.supabase
                    .from('videos')
                    .select('id')
                    .in('series_id', seriesIds);

                if (allVideos && allVideos.length > 0) {
                    const videoIds = allVideos.map(v => v.id);
                    // Delete streams in batches
                    for (let i = 0; i < videoIds.length; i += 1000) {
                        const batch = videoIds.slice(i, i + 1000);
                        await this.supabase.from('streams').delete().in('video_id', batch);
                    }
                }

                await this.supabase.from('videos').delete().in('series_id', seriesIds);
                await this.supabase.from('series').delete().eq('scraper', scraper);
                logger.info(`DatabaseUpdater => Cleared ${existingSeries.length} old series`);
            }

            // Insert series in batches
            logger.info(`DatabaseUpdater => Inserting ${seriesToInsert.length} series...`);
            const SERIES_BATCH_SIZE = 100;
            for (let i = 0; i < seriesToInsert.length; i += SERIES_BATCH_SIZE) {
                const batch = seriesToInsert.slice(i, i + SERIES_BATCH_SIZE);
                await this.supabase.from('series').insert(batch);
                if ((i / SERIES_BATCH_SIZE) % 10 === 0) {
                    logger.debug(`DatabaseUpdater => Series: ${i + batch.length}/${seriesToInsert.length}`);
                }
            }

            // Insert videos in batches
            logger.info(`DatabaseUpdater => Inserting ${videosToInsert.length} videos...`);
            const VIDEO_BATCH_SIZE = 100;
            for (let i = 0; i < videosToInsert.length; i += VIDEO_BATCH_SIZE) {
                const batch = videosToInsert.slice(i, i + VIDEO_BATCH_SIZE);
                await this.supabase.from('videos').insert(batch);
                if ((i / VIDEO_BATCH_SIZE) % 100 === 0) {
                    logger.debug(`DatabaseUpdater => Videos: ${i + batch.length}/${videosToInsert.length}`);
                }
            }

            // Insert streams in batches
            logger.info(`DatabaseUpdater => Inserting ${streamsToInsert.length} streams...`);
            const STREAM_BATCH_SIZE = 100;
            for (let i = 0; i < streamsToInsert.length; i += STREAM_BATCH_SIZE) {
                const batch = streamsToInsert.slice(i, i + STREAM_BATCH_SIZE);
                await this.supabase.from('streams').insert(batch);
                if ((i / STREAM_BATCH_SIZE) % 1000 === 0) {
                    logger.debug(`DatabaseUpdater => Streams: ${i + batch.length}/${streamsToInsert.length}`);
                }
            }

            const duration = ((Date.now() - startTime) / 1000).toFixed(1);
            logger.info(`✅ DatabaseUpdater => Import complete in ${duration}s!`);
            logger.info(`   Series: ${seriesToInsert.length}`);
            logger.info(`   Videos: ${videosToInsert.length}`);
            logger.info(`   Streams: ${streamsToInsert.length}`);

            return {
                success: true,
                series: seriesToInsert.length,
                videos: videosToInsert.length,
                streams: streamsToInsert.length,
                duration: duration
            };

        } catch (error) {
            logger.error(`❌ DatabaseUpdater => Error: ${error.message}`);
            throw error;
        }
    }

    /**
     * Incremental update - only update changed/new items
     * Use this for incremental scraping mode
     * @param {string} scraper - Scraper name
     * @param {object} jsonData - Scraped data
     * @param {object} deltaTracker - DeltaTracker with changes
     * @returns {Promise<object>} Update summary
     */
    async updateIncrementally(scraper, jsonData, deltaTracker) {
        logger.info(`DatabaseUpdater => Starting incremental update for ${scraper}...`);

        try {
            const deltaUpdater = new DeltaUpdater(logger);
            const result = await deltaUpdater.updateIncrementally(scraper, jsonData, deltaTracker);

            return {
                success: true,
                ...result
            };

        } catch (error) {
            logger.error(`❌ DatabaseUpdater => Incremental update error: ${error.message}`);
            throw error;
        }
    }
}

module.exports = DatabaseUpdater;
