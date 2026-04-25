const fs = require('fs');
const path = require('path');
const utils = require('./utilities.js');
const { LOG4JS } = require('./constants');

const log4js = require('log4js');

log4js.configure({
    appenders: {
        out: { type: 'stdout' },
        DatabaseImporter: {
            type: 'file',
            filename: 'logs/database-import.log',
            maxLogSize: 10485760,
            backups: 5,
        }
    },
    categories: { default: { appenders: ['DatabaseImporter', 'out'], level: 'info' } },
});

const logger = log4js.getLogger('DatabaseImporter');

/**
 * =============================================================================
 * DATABASE IMPORTER - ONE-TIME INITIAL DATA LOAD
 * =============================================================================
 *
 * Imports existing JSON files into database for initial setup.
 * Run once to populate Supabase with existing scraped data.
 * After initial import, scrapers will handle incremental updates.
 */
class DatabaseImporter {
    constructor(dbClient) {
        this.db = dbClient;
        this.buildPath = path.join(__dirname, '..', 'build');
        this.results = {
            filesProcessed: 0,
            seriesImported: 0,
            videosImported: 0,
            streamsImported: 0,
            errors: [],
            startTime: null,
            endTime: null
        };
    }

    /**
     * Import all JSON files from build directory
     */
    async importAll() {
        logger.info('DatabaseImporter => Starting initial database import...');
        this.results.startTime = new Date();

        try {
            // Find all JSON files
            const jsonFiles = this.findJSONFiles();
            logger.info(`DatabaseImporter => Found ${jsonFiles.length} JSON files to import`);

            // Process each file
            for (const file of jsonFiles) {
                await this.importFile(file);
            }

            this.results.endTime = new Date();
            this.logResults();

        } catch (error) {
            logger.error('DatabaseImporter => Fatal error during import:', error);
            throw error;
        }
    }

    /**
     * Find all stremio-*.json files in build directory
     */
    findJSONFiles() {
        try {
            const files = fs.readdirSync(this.buildPath);
            return files
                .filter(file => file.startsWith('stremio-') && file.endsWith('.json'))
                .map(file => path.join(this.buildPath, file));
        } catch (error) {
            logger.error('DatabaseImporter => Error reading build directory:', error);
            return [];
        }
    }

    /**
     * Import a single JSON file
     */
    async importFile(filePath) {
        const fileName = path.basename(filePath);
        logger.info(`DatabaseImporter => Processing ${fileName}...`);

        try {
            // Read and parse JSON
            const fileContent = fs.readFileSync(filePath, 'utf8');
            const data = JSON.parse(fileContent);

            // Check if it has the timestamp wrapper
            const seriesData = data.data || data;

            // Determine scraper type from filename
            const scraperType = this.extractScraperType(fileName);

            // Import series
            const seriesArray = Object.values(seriesData);
            let importedCount = 0;

            for (const series of seriesArray) {
                try {
                    await this.importSeries(series, scraperType);
                    importedCount++;
                } catch (error) {
                    this.results.errors.push({
                        file: fileName,
                        series: series.id,
                        error: error.message
                    });
                }
            }

            this.results.seriesImported += importedCount;
            this.results.filesProcessed++;

            logger.info(`DatabaseImporter => ✅ ${fileName}: ${importedCount} series imported`);

        } catch (error) {
            logger.error(`DatabaseImporter => ❌ Error importing ${fileName}:`, error.message);
            this.results.errors.push({
                file: fileName,
                error: error.message
            });
        }
    }

    /**
     * Import a single series with its videos
     */
    async importSeries(series, scraperType) {
        const seriesData = {
            id: series.id,
            scraper: scraperType,
            name: series.name,
            poster: series.poster,
            background: series.background || series.poster,
            description: series.description,
            link: series.link,
            type: series.type,
            subtype: series.subtype,
            genres: series.genres || [],
            tmdb_id: series.tmdbId || series.meta?.tmdbId,
            video_count: series.meta?.videos?.length || 0,
            latest_episode_date: this.calculateLatestEpisodeDate(series),
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
        };

        // Insert series
        const { error: seriesError } = await this.db
            .from('series')
            .upsert(seriesData)
            .eq('id', seriesData.id);

        if (seriesError) {
            throw new Error(`Failed to insert series ${seriesData.id}: ${seriesError.message}`);
        }

        // Import videos
        const videos = series.meta?.videos || [];
        for (const video of videos) {
            await this.importVideo(video, scraperType);
            this.results.videosImported++;

            // Import streams for this video
            const streams = video.streams || [];
            for (const stream of streams) {
                await this.importStream(stream, video.id);
                this.results.streamsImported++;
            }
        }
    }

    /**
     * Import a single video/episode
     */
    async importVideo(video, scraperType) {
        const videoData = {
            id: video.id,
            series_id: video.id.split(':')[0], // Extract series ID
            title: video.name,
            season: video.season,
            episode: video.episode,
            description: video.description,
            thumbnail: video.thumbnail,
            episode_link: video.episodeLink,
            released: video.released || null,
            tmdb_episode_id: video.tmdbEpisodeId || video.meta?.tmdbEpisodeId,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
        };

        const { error } = await this.db
            .from('videos')
            .upsert(videoData)
            .eq('id', videoData.id);

        if (error) {
            throw new Error(`Failed to insert video ${videoData.id}: ${error.message}`);
        }
    }

    /**
     * Import a single stream
     */
    async importStream(stream, videoId) {
        const streamData = {
            video_id: videoId,
            url: stream.url,
            name: stream.name || 'Stream',
            quality: stream.quality || null,
            language: stream.language || null,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
        };

        const { error } = await this.db
            .from('streams')
            .upsert(streamData);

        if (error) {
            // Log warning but don't fail the entire import for stream errors
            logger.warn(`Failed to insert stream for ${videoId}: ${error.message}`);
        }
    }

    /**
     * Calculate latest episode date for a series
     */
    calculateLatestEpisodeDate(series) {
        const videos = series.meta?.videos || [];
        if (videos.length === 0) return null;

        const dates = videos
            .map(v => v.released ? new Date(v.released).getTime() : null)
            .filter(d => d !== null);

        return dates.length > 0
            ? new Date(Math.max(...dates)).toISOString()
            : null;
    }

    /**
     * Extract scraper type from filename
     */
    extractScraperType(fileName) {
        if (fileName.includes('kandigital')) return 'kandigital';
        if (fileName.includes('kanarchive')) return 'kanarchive';
        if (fileName.includes('kankids')) return 'kankids';
        if (fileName.includes('kanteens')) return 'kanteens';
        if (fileName.includes('kan88')) return 'kan88';
        if (fileName.includes('kanpodcasts')) return 'kanpodcasts';
        if (fileName.includes('mako')) return 'mako';
        if (fileName.includes('reshet')) return 'reshet';
        return 'unknown';
    }

    /**
     * Log import results
     */
    logResults() {
        const duration = ((this.results.endTime - this.results.startTime) / 1000).toFixed(2);

        logger.info('============================================================');
        logger.info('DATABASE IMPORT RESULTS');
        logger.info('============================================================');
        logger.info(`Files Processed:    ${this.results.filesProcessed}`);
        logger.info(`Series Imported:    ${this.results.seriesImported}`);
        logger.info(`Videos Imported:    ${this.results.videosImported}`);
        logger.info(`Streams Imported:   ${this.results.streamsImported}`);
        logger.info(`Errors:             ${this.results.errors.length}`);
        logger.info(`Duration:           ${duration} seconds`);
        logger.info('============================================================');

        if (this.results.errors.length > 0) {
            logger.warn('Errors encountered:');
            this.results.errors.forEach((err, index) => {
                logger.warn(`  ${index + 1}. ${err.file} - ${err.series || err.error}`);
            });
        }

        logger.info('DatabaseImporter => Import complete!');
    }

    /**
     * Validate that all required tables exist
     */
    async validateDatabaseSchema() {
        logger.info('DatabaseImporter => Validating database schema...');

        const requiredTables = ['series', 'videos', 'streams'];
        const validationResults = {};

        for (const table of requiredTables) {
            try {
                const { data, error, status } = await this.db
                    .from(table)
                    .select('*')
                    .limit(1);

                // Table exists if we got a successful HTTP status or if error is not about missing table
                const tableExists = status >= 200 && status < 300 ||
                                  (error && !error.message.includes('does not exist'));

                validationResults[table] = tableExists;
                logger.info(`DatabaseImporter => Table '${table}': ${tableExists ? '✅ OK' : '❌ Missing'}`);

                if (error && tableExists) {
                    logger.debug(`DatabaseImporter => Note: ${error.message} (but table exists)`);
                }
            } catch (error) {
                validationResults[table] = false;
                logger.error(`DatabaseImporter => Table '${table}': ❌ Error - ${error.message}`);
            }
        }

        const allValid = Object.values(validationResults).every(v => v);

        if (!allValid) {
            throw new Error('Database schema validation failed. Please create required tables first.');
        }

        logger.info('DatabaseImporter => ✅ Schema validation passed');
        return true;
    }

    /**
     * Get import statistics before running
     */
    async getPreImportStats() {
        const stats = {
            files: [],
            totalSeries: 0,
            totalVideos: 0
        };

        const jsonFiles = this.findJSONFiles();

        for (const file of jsonFiles) {
            try {
                const content = fs.readFileSync(file, 'utf8');
                const data = JSON.parse(content);
                const seriesData = data.data || data;
                const seriesCount = Object.keys(seriesData).length;
                const videoCount = Object.values(seriesData)
                    .reduce((sum, s) => sum + (s.meta?.videos?.length || 0), 0);

                stats.files.push({
                    name: path.basename(file),
                    series: seriesCount,
                    videos: videoCount
                });

                stats.totalSeries += seriesCount;
                stats.totalVideos += videoCount;

            } catch (error) {
                logger.warn(`DatabaseImporter => Could not analyze ${file}: ${error.message}`);
            }
        }

        return stats;
    }
}

module.exports = DatabaseImporter;