const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: './classes/.env' });

/**
 * =============================================================================
 * DELTA UPDATER - Incremental Database Updates
 * =============================================================================
 *
 * Handles incremental database updates for scrapers.
 * Instead of deleting all data and re-inserting, this class:
 * 1. Identifies new items to INSERT
 * 2. Identifies changed items to UPDATE
 * 3. Updates scrape_state table
 *
 * Used when incremental scraping is enabled.
 */
class DeltaUpdater {
    constructor(logger) {
        this.logger = logger;

        // Initialize Supabase client
        const supabaseUrl = process.env.SUPABASE_URL;
        const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

        if (!supabaseUrl || !supabaseKey) {
            throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env');
        }

        this.supabase = createClient(supabaseUrl, supabaseKey);
    }

    /**
     * Update database incrementally based on scraped data
     * @param {string} scraperName - Scraper name (e.g., 'kandigital', 'kanpodcasts')
     * @param {Object} jsonData - Scraped JSON data
     * @param {Object} deltaTracker - DeltaTracker instance with change info
     * @returns {Promise<Object>} Summary of updates
     */
    async updateIncrementally(scraperName, jsonData, deltaTracker) {
        const startTime = Date.now();
        this.logger.info(`DeltaUpdater => Starting incremental update for ${scraperName}...`);

        const summary = {
            series: { inserted: 0, updated: 0, skipped: 0 },
            videos: { inserted: 0, updated: 0 },
            streams: { inserted: 0 },
            duration: 0
        };

        try {
            // Get delta summary
            const delta = deltaTracker.getSummary();
            this.logger.info(`DeltaUpdater => Delta summary: ${JSON.stringify(delta)}`);

            // Process new series
            if (delta.newSeries && delta.newSeries.length > 0) {
                await this._insertNewSeries(delta.newSeries, jsonData, summary);
            }

            // Process updated series
            if (delta.updatedSeries && delta.updatedSeries.length > 0) {
                await this._updateChangedSeries(delta.updatedSeries, jsonData, summary);
            }

            // Process new videos
            if (delta.newVideos && delta.newVideos.length > 0) {
                await this._insertNewVideos(delta.newVideos, jsonData, summary);
            }

            // Process updated videos
            if (delta.updatedVideos && delta.updatedVideos.length > 0) {
                await this._updateChangedVideos(delta.updatedVideos, jsonData, summary);
            }

            // Process new streams
            if (delta.newStreams && delta.newStreams.length > 0) {
                await this._insertNewStreams(delta.newStreams, jsonData, summary);
            }

            summary.duration = ((Date.now() - startTime) / 1000).toFixed(2);

            this.logger.info(`DeltaUpdater => ✅ Incremental update complete: ` +
                `${summary.series.inserted} new series, ` +
                `${summary.series.updated} updated series, ` +
                `${summary.series.skipped} skipped, ` +
                `${summary.videos.inserted} new videos, ` +
                `${summary.videos.updated} updated videos, ` +
                `${summary.streams.inserted} new streams ` +
                `in ${summary.duration}s`);

            return summary;

        } catch (error) {
            this.logger.error(`DeltaUpdater => ❌ Incremental update failed: ${error.message}`);
            throw error;
        }
    }

    /**
     * Insert new series
     * @private
     */
    async _insertNewSeries(newSeriesIds, jsonData, summary) {
        this.logger.info(`DeltaUpdater => Inserting ${newSeriesIds.length} new series...`);

        const seriesToInsert = [];
        for (const seriesId of newSeriesIds) {
            if (jsonData[seriesId]) {
                const series = this._mapSeriesForDB(seriesId, jsonData[seriesId]);
                seriesToInsert.push(series);
            }
        }

        if (seriesToInsert.length === 0) return;

        // Batch insert (Supabase/Postgres has limits, so do in chunks)
        const batchSize = 100;
        for (let i = 0; i < seriesToInsert.length; i += batchSize) {
            const batch = seriesToInsert.slice(i, i + batchSize);
            const { error } = await this.supabase
                .from('series')
                .insert(batch);

            if (error) {
                this.logger.error(`DeltaUpdater => Error inserting series batch ${i / batchSize + 1}: ${error.message}`);
            } else {
                summary.series.inserted += batch.length;
            }
        }
    }

    /**
     * Update changed series
     * @private
     */
    async _updateChangedSeries(updatedSeriesIds, jsonData, summary) {
        this.logger.info(`DeltaUpdater => Updating ${updatedSeriesIds.length} changed series...`);

        for (const seriesId of updatedSeriesIds) {
            if (!jsonData[seriesId]) continue;

            const series = this._mapSeriesForDB(seriesId, jsonData[seriesId]);

            const { error } = await this.supabase
                .from('series')
                .update(series)
                .eq('id', seriesId);

            if (error) {
                this.logger.error(`DeltaUpdater => Error updating series ${seriesId}: ${error.message}`);
            } else {
                summary.series.updated++;
            }
        }
    }

    /**
     * Insert new videos
     * @private
     */
    async _insertNewVideos(newVideoKeys, jsonData, summary) {
        this.logger.info(`DeltaUpdater => Inserting ${newVideoKeys.length} new videos...`);

        const videosToInsert = [];
        for (const key of newVideoKeys) {
            const [seriesId, videoId] = key.split(':');
            if (jsonData[seriesId] && jsonData[seriesId].meta) {
                const video = jsonData[seriesId].meta.videos.find(v => v.id === videoId);
                if (video) {
                    videosToInsert.push(this._mapVideoForDB(videoId, seriesId, video));
                }
            }
        }

        if (videosToInsert.length === 0) return;

        // Batch insert
        const batchSize = 100;
        for (let i = 0; i < videosToInsert.length; i += batchSize) {
            const batch = videosToInsert.slice(i, i + batchSize);
            const { error } = await this.supabase
                .from('videos')
                .insert(batch);

            if (error) {
                this.logger.error(`DeltaUpdater => Error inserting videos batch ${i / batchSize + 1}: ${error.message}`);
            } else {
                summary.videos.inserted += batch.length;
            }
        }
    }

    /**
     * Update changed videos
     * @private
     */
    async _updateChangedVideos(updatedVideoKeys, jsonData, summary) {
        this.logger.info(`DeltaUpdater => Updating ${updatedVideoKeys.length} changed videos...`);

        for (const key of updatedVideoKeys) {
            const [seriesId, videoId] = key.split(':');
            if (jsonData[seriesId] && jsonData[seriesId].meta) {
                const video = jsonData[seriesId].meta.videos.find(v => v.id === videoId);
                if (video) {
                    const videoData = this._mapVideoForDB(videoId, seriesId, video);
                    delete videoData.id; // Don't update ID

                    const { error } = await this.supabase
                        .from('videos')
                        .update(videoData)
                        .eq('id', videoId);

                    if (error) {
                        this.logger.error(`DeltaUpdater => Error updating video ${videoId}: ${error.message}`);
                    } else {
                        summary.videos.updated++;
                    }
                }
            }
        }
    }

    /**
     * Insert new streams
     * @private
     */
    async _insertNewStreams(newStreamKeys, jsonData, summary) {
        this.logger.info(`DeltaUpdater => Inserting ${newStreamKeys.length} new streams...`);

        const streamsToInsert = [];
        for (const key of newStreamKeys) {
            const [seriesId, videoId, streamIndex] = key.split(':');
            if (jsonData[seriesId] && jsonData[seriesId].meta) {
                const video = jsonData[seriesId].meta.videos.find(v => v.id === videoId);
                if (video && video.streams && video.streams[streamIndex]) {
                    const stream = video.streams[streamIndex];
                    streamsToInsert.push({
                        video_id: videoId,
                        url: stream.url,
                        title: stream.title || stream.name || '',
                        description: stream.description || '',
                        quality: stream.quality || 'default'
                    });
                }
            }
        }

        if (streamsToInsert.length === 0) return;

        // Batch insert
        const batchSize = 100;
        for (let i = 0; i < streamsToInsert.length; i += batchSize) {
            const batch = streamsToInsert.slice(i, i + batchSize);
            const { error } = await this.supabase
                .from('streams')
                .insert(batch);

            if (error) {
                this.logger.error(`DeltaUpdater => Error inserting streams batch ${i / batchSize + 1}: ${error.message}`);
            } else {
                summary.streams.inserted += batch.length;
            }
        }
    }

    /**
     * Map series data from JSON to database format
     * @private
     */
    _mapSeriesForDB(seriesId, seriesData) {
        return {
            id: seriesId,
            scraper: seriesData.scraper || 'unknown',
            name: seriesData.name || '',
            poster: seriesData.meta?.poster || '',
            background: seriesData.meta?.background || seriesData.meta?.poster || '',
            description: seriesData.meta?.description || '',
            link: seriesData.link || seriesData.meta?.link || '',
            type: seriesData.type || 'series',
            subtype: seriesData.subtype || '',
            genres: seriesData.meta?.genres || [],
            video_count: seriesData.meta?.videos?.length || 0,
            latest_episode_date: this._extractLatestDate(seriesData.meta?.videos) || null,
            tmdb_id: seriesData.meta?.tmdb_id || null
        };
    }

    /**
     * Map video data from JSON to database format
     * @private
     */
    _mapVideoForDB(videoId, seriesId, videoData) {
        return {
            id: videoId,
            series_id: seriesId,
            title: videoData.name || videoData.title || '',
            season: videoData.season || 1,
            episode: videoData.episode || 1,
            description: videoData.description || '',
            thumbnail: videoData.thumbnail || videoData.thumb || '',
            episode_link: videoData.episodeLink || '',
            released: videoData.released || null,
            tmdb_episode_id: videoData.tmdb_episode_id || null
        };
    }

    /**
     * Extract latest episode date from videos array
     * @private
     */
    _extractLatestDate(videos) {
        if (!videos || videos.length === 0) return null;

        let latest = null;
        for (const video of videos) {
            if (video.released) {
                const date = new Date(video.released);
                if (!latest || date > latest) {
                    latest = date;
                }
            }
        }

        return latest ? latest.toISOString() : null;
    }
}

module.exports = DeltaUpdater;
