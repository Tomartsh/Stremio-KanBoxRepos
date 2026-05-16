const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
require('dotenv').config({ path: './classes/.env' });

/**
 * =============================================================================
 * STATE MANAGER - Incremental Scraping State Management
 * =============================================================================
 *
 * Manages scraping state to enable incremental updates.
 * Tracks what was scraped, when, and what changed.
 *
 * Modes:
 * - 'auto': Use config setting (full or incremental based on INCREMENTAL_SCRAPING config)
 * - 'full': Force full scrape (ignore state)
 * - 'incremental': Force incremental mode
 * - 'skip': Skip scraping, just validate state
 */
class StateManager {
    constructor(scraperName, logger) {
        this.scraperName = scraperName;
        this.logger = logger;

        // Initialize Supabase client
        const supabaseUrl = process.env.SUPABASE_URL;
        const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

        if (!supabaseUrl || !supabaseKey) {
            throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env');
        }

        this.supabase = createClient(supabaseUrl, supabaseKey);

        // In-memory cache for state
        this.stateCache = new Map(); // series_id -> state object
        this.loaded = false;
    }

    /**
     * Load all scrape state for this scraper from database
     */
    async loadState() {
        if (this.loaded) return;

        try {
            this.logger.info(`StateManager => Loading state for ${this.scraperName}...`);

            const { data, error } = await this.supabase
                .from('scrape_state')
                .select('*')
                .eq('scraper_name', this.scraperName)
                .eq('is_active', true);

            if (error) {
                // Table might not exist yet (first run)
                if (error.code === '42P01') {
                    this.logger.warn('StateManager => scrape_state table does not exist, will create on first update');
                    this.loaded = true;
                    return;
                }
                throw error;
            }

            // Populate cache
            for (const row of data || []) {
                this.stateCache.set(row.series_id, row);
            }

            this.loaded = true;
            this.logger.info(`StateManager => Loaded ${this.stateCache.size} series states for ${this.scraperName}`);

        } catch (error) {
            this.logger.error(`StateManager => Error loading state: ${error.message}`);
            throw error;
        }
    }

    /**
     * Get state for a specific series
     * @param {string} seriesId - Series ID
     * @returns {Object|null} State object or null if not found
     */
    getSeriesState(seriesId) {
        return this.stateCache.get(seriesId) || null;
    }

    /**
     * Check if a series should be scraped based on state
     * @param {Object} seriesData - Series data from scraper
     * @param {Object} config - Scraper config (forceRefreshDays, etc.)
     * @returns {string} - 'SCRAPE', 'SKIP', or 'NEW'
     */
    compareAndDecide(seriesData, config = {}) {
        const state = this.getSeriesState(seriesData.id);

        // No existing state = new series
        if (!state) {
            return 'NEW';
        }

        // Check if series has changed (metadata comparison)
        if (this._hasSeriesChanged(seriesData, state)) {
            return 'SCRAPE';
        }

        // Check if episode count changed
        if (seriesData.videoCount !== undefined && seriesData.videoCount !== state.episode_count) {
            return 'SCRAPE';
        }

        // Check if latest episode date changed
        if (seriesData.latestEpisodeDate && state.last_episode_date) {
            const listDate = new Date(seriesData.latestEpisodeDate);
            const stateDate = new Date(state.last_episode_date);
            if (listDate > stateDate) {
                return 'SCRAPE';
            }
        }

        // Check if past force refresh period
        const forceRefreshDays = config.forceRefreshDays || 7;
        const daysSinceScrape = (Date.now() - new Date(state.last_scraped_at).getTime()) / (1000 * 60 * 60 * 24);

        if (daysSinceScrape > forceRefreshDays) {
            this.logger.debug(`StateManager => ${seriesData.name} past refresh threshold (${daysSinceScrape.toFixed(1)} days), will scrape`);
            return 'SCRAPE';
        }

        // No changes detected
        return 'SKIP';
    }

    /**
     * Check if series metadata has changed
     * @private
     */
    _hasSeriesChanged(seriesData, state) {
        // Check key fields for changes
        if (seriesData.name && seriesData.name !== state.series_title) return true;
        if (seriesData.poster && seriesData.poster !== state.poster) return true;

        // Generate hash comparison if available
        if (state.last_scrape_hash) {
            const newHash = this._generateHash(seriesData);
            return newHash !== state.last_scrape_hash;
        }

        return false;
    }

    /**
     * Generate hash for series data (for change detection)
     * @private
     */
    _generateHash(seriesData) {
        const hashData = {
            name: seriesData.name || '',
            description: seriesData.description || '',
            videoCount: seriesData.videoCount || 0
        };
        return crypto.createHash('sha256').update(JSON.stringify(hashData)).digest('hex');
    }

    /**
     * Update or insert state for a series after scraping
     * @param {string} seriesId - Series ID
     * @param {Object} seriesData - Series data
     * @param {string} decision - Decision result ('NEW', 'SCRAPE', 'SKIP')
     * @param {string} skipReason - Reason for skipping (if applicable)
     */
    async updateSeriesState(seriesId, seriesData, decision, skipReason = null) {
        try {
            const hash = this._generateHash(seriesData);
            const now = new Date().toISOString();

            const stateData = {
                scraper_name: this.scraperName,
                series_id: seriesId,
                series_title: seriesData.name || '',
                episode_count: seriesData.videoCount || 0,
                last_episode_date: seriesData.latestEpisodeDate || null,
                last_episode_id: seriesData.lastEpisodeId || null,
                last_scraped_at: now,
                last_scrape_hash: hash,
                is_active: true,
                skip_reason: skipReason,
                updated_at: now
            };

            // Check if exists in database
            const existing = await this._getDatabaseState(seriesId);

            if (existing) {
                // Update existing
                const { error } = await this.supabase
                    .from('scrape_state')
                    .update(stateData)
                    .eq('scraper_name', this.scraperName)
                    .eq('series_id', seriesId);

                if (error) throw error;
            } else {
                // Insert new
                const { error } = await this.supabase
                    .from('scrape_state')
                    .insert(stateData);

                if (error) throw error;
            }

            // Update cache
            this.stateCache.set(seriesId, { ...stateData, id: existing?.id });

        } catch (error) {
            this.logger.error(`StateManager => Error updating state for ${seriesId}: ${error.message}`);
            // Don't throw - state update failure shouldn't break the scraper
        }
    }

    /**
     * Get state directly from database (bypass cache)
     * @private
     */
    async _getDatabaseState(seriesId) {
        try {
            const { data, error } = await this.supabase
                .from('scrape_state')
                .select('id')
                .eq('scraper_name', this.scraperName)
                .eq('series_id', seriesId)
                .single();

            if (error && error.code !== 'PGRST116') { // PGRST116 = not found
                return null;
            }
            return data;
        } catch {
            return null;
        }
    }

    /**
     * Get statistics about current state
     * @returns {Object} Statistics object
     */
    getStats() {
        const stats = {
            total: this.stateCache.size,
            active: 0,
            withEpisodes: 0,
            scraper: this.scraperName
        };

        for (const state of this.stateCache.values()) {
            if (state.is_active) stats.active++;
            if (state.episode_count > 0) stats.withEpisodes++;
        }

        return stats;
    }

    /**
     * Mark a series as inactive (removed from source)
     * @param {string} seriesId - Series ID
     */
    async markInactive(seriesId) {
        try {
            const { error } = await this.supabase
                .from('scrape_state')
                .update({
                    is_active: false,
                    skip_reason: 'Removed from source',
                    updated_at: new Date().toISOString()
                })
                .eq('scraper_name', this.scraperName)
                .eq('series_id', seriesId);

            if (error) throw error;

            // Update cache
            const cached = this.stateCache.get(seriesId);
            if (cached) {
                cached.is_active = false;
                cached.skip_reason = 'Removed from source';
            }

        } catch (error) {
            this.logger.error(`StateManager => Error marking ${seriesId} inactive: ${error.message}`);
        }
    }

    /**
     * Clear all state for this scraper (for full scrape reset)
     */
    async clearAllState() {
        try {
            const { error } = await this.supabase
                .from('scrape_state')
                .delete()
                .eq('scraper_name', this.scraperName);

            if (error) throw error;

            this.stateCache.clear();
            this.logger.info(`StateManager => Cleared all state for ${this.scraperName}`);

        } catch (error) {
            this.logger.error(`StateManager => Error clearing state: ${error.message}`);
            throw error;
        }
    }
}

module.exports = StateManager;
