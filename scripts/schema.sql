-- ============================================================================
-- SUPABASE DATABASE SCHEMA FOR STREMIO ADDON
-- ============================================================================
--
-- Run this SQL in the Supabase SQL Editor to create the required tables:
-- https://supabase.com/dashboard/project/YOUR-PROJECT/sql/new
--
-- Data API grants, from 30 October 2026:
-- Supabase no longer auto-grants Data API access (supabase-js, PostgREST,
-- and GraphQL) to new tables in the public schema. A new table stays
-- invisible to those APIs until it is granted explicitly. Every new table
-- must get its own GRANT lines in this same script. The ALTER DEFAULT
-- PRIVILEGES statements below only cover objects created later by the role
-- that runs this script, so they do not replace those per-table GRANTs.
-- https://supabase.com/changelog/45329-breaking-change-tables-not-exposed-to-data-and-graphql-api-automatically
--
-- Re-runs: tables and indexes use IF NOT EXISTS, the trigger function uses
-- CREATE OR REPLACE, and each trigger and policy is dropped first. Nothing
-- here changes table, column, or index definitions.
--
-- ============================================================================

-- Enable UUID extension if not already enabled
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================================
-- SERIES TABLE
-- ============================================================================
CREATE TABLE IF NOT EXISTS series (
    id VARCHAR(255) PRIMARY KEY,
    scraper VARCHAR(50) NOT NULL,
    name VARCHAR(500) NOT NULL,
    poster TEXT,
    background TEXT,
    description TEXT,
    link TEXT,
    type VARCHAR(20),
    subtype VARCHAR(10),
    genres JSONB DEFAULT '[]'::jsonb,
    tmdb_id INTEGER,
    video_count INTEGER DEFAULT 0,
    latest_episode_date TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_series_scraper ON series(scraper);
CREATE INDEX IF NOT EXISTS idx_series_latest_episode ON series(latest_episode_date DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_series_tmdb ON series(tmdb_id);
CREATE INDEX IF NOT EXISTS idx_series_updated ON series(updated_at DESC);

-- ============================================================================
-- VIDEOS/EPISODES TABLE
-- ============================================================================
CREATE TABLE IF NOT EXISTS videos (
    id VARCHAR(255) PRIMARY KEY,
    series_id VARCHAR(255) NOT NULL,
    title VARCHAR(500),
    season INTEGER,
    episode INTEGER,
    description TEXT,
    thumbnail TEXT,
    episode_link TEXT,
    released TIMESTAMPTZ,
    tmdb_episode_id INTEGER,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),

    CONSTRAINT fk_videos_series
        FOREIGN KEY (series_id)
        REFERENCES series(id)
        ON DELETE CASCADE
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_videos_series ON videos(series_id);
CREATE INDEX IF NOT EXISTS idx_videos_released ON videos(released DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_videos_series_season ON videos(series_id, season, episode);
CREATE INDEX IF NOT EXISTS idx_videos_tmdb ON videos(tmdb_episode_id);

-- ============================================================================
-- STREAMS TABLE
-- ============================================================================
CREATE TABLE IF NOT EXISTS streams (
    id SERIAL PRIMARY KEY,
    video_id VARCHAR(255) NOT NULL,
    url TEXT NOT NULL,
    title VARCHAR(500),
    description TEXT,
    quality VARCHAR(50),
    created_at TIMESTAMPTZ DEFAULT NOW(),

    CONSTRAINT fk_streams_video
        FOREIGN KEY (video_id)
        REFERENCES videos(id)
        ON DELETE CASCADE
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_streams_video ON streams(video_id);
CREATE INDEX IF NOT EXISTS idx_streams_quality ON streams(quality);

-- ============================================================================
-- SYNC LOGS TABLE (for tracking import/sync operations)
-- ============================================================================
CREATE TABLE IF NOT EXISTS sync_logs (
    id SERIAL PRIMARY KEY,
    scraper VARCHAR(50) NOT NULL,
    operation VARCHAR(20) NOT NULL, -- 'import', 'sync', 'update'
    series_processed INTEGER DEFAULT 0,
    videos_processed INTEGER DEFAULT 0,
    new_series INTEGER DEFAULT 0,
    updated_series INTEGER DEFAULT 0,
    new_videos INTEGER DEFAULT 0,
    updated_videos INTEGER DEFAULT 0,
    skipped_series INTEGER DEFAULT 0,
    errors INTEGER DEFAULT 0,
    duration_seconds DECIMAL(10,2),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sync_logs_scraper ON sync_logs(scraper);
CREATE INDEX IF NOT EXISTS idx_sync_logs_created ON sync_logs(created_at DESC);

-- ============================================================================
-- SCRAPE STATE TABLE (for incremental scraping)
-- ============================================================================
CREATE TABLE IF NOT EXISTS scrape_state (
    id BIGSERIAL PRIMARY KEY,
    scraper_name VARCHAR(50) NOT NULL,
    series_id VARCHAR(255) NOT NULL,
    series_title VARCHAR(500),
    episode_count INTEGER DEFAULT 0,
    last_episode_date TIMESTAMPTZ,
    last_episode_id VARCHAR(255),
    last_scraped_at TIMESTAMPTZ DEFAULT NOW(),
    last_scrape_hash VARCHAR(64),
    scrape_version INTEGER DEFAULT 1,
    is_active BOOLEAN DEFAULT TRUE,
    skip_reason TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(scraper_name, series_id)
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_scrape_state_lookup ON scrape_state(scraper_name, is_active);
CREATE INDEX IF NOT EXISTS idx_scrape_state_last_scraped ON scrape_state(last_scraped_at);
CREATE INDEX IF NOT EXISTS idx_scrape_state_series ON scrape_state(series_id);

-- ============================================================================
-- FUNCTIONS AND TRIGGERS
-- ============================================================================
-- The function has to exist before any trigger that calls it. The
-- scrape_state trigger used to be created above this definition.

-- Function to update updated_at timestamp automatically
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Triggers to auto-update updated_at
DROP TRIGGER IF EXISTS update_scrape_state_updated_at ON scrape_state;
CREATE TRIGGER update_scrape_state_updated_at
    BEFORE UPDATE ON scrape_state
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_series_updated_at ON series;
CREATE TRIGGER update_series_updated_at
    BEFORE UPDATE ON series
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_videos_updated_at ON videos;
CREATE TRIGGER update_videos_updated_at
    BEFORE UPDATE ON videos
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- GRANT PERMISSIONS FOR DATA API ACCESS
-- ============================================================================
-- Explicit grants for every table in this script. Required for supabase-js,
-- PostgREST, and GraphQL once a project no longer auto-exposes new public
-- tables (enforced for existing projects on 30 October 2026).

-- Public read access (for addon queries)
GRANT SELECT ON TABLE series TO anon, authenticated, service_role;
GRANT SELECT ON TABLE videos TO anon, authenticated, service_role;
GRANT SELECT ON TABLE streams TO anon, authenticated, service_role;

-- Internal tables. anon is not granted SELECT: sync_logs and scrape_state
-- are scraper bookkeeping, not part of the public read-only addon.
-- authenticated keeps SELECT. service_role keeps SELECT here and writes below.
GRANT SELECT ON TABLE sync_logs TO authenticated, service_role;
GRANT SELECT ON TABLE scrape_state TO authenticated, service_role;

-- Clear anon if a previous run of this script, or the pre-30 Oct 2026
-- Supabase default privileges, already granted Data API access. REVOKE is a
-- no-op when anon has no such privilege. Writes are included because that
-- older default granted SELECT, INSERT, UPDATE, and DELETE together.
REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLE sync_logs FROM anon;
REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLE scrape_state FROM anon;

-- Service role write access (for scraper updates)
GRANT INSERT, UPDATE, DELETE ON TABLE series TO service_role;
GRANT INSERT, UPDATE, DELETE ON TABLE videos TO service_role;
GRANT INSERT, UPDATE, DELETE ON TABLE streams TO service_role;
GRANT INSERT, UPDATE, DELETE ON TABLE sync_logs TO service_role;
GRANT INSERT, UPDATE, DELETE ON TABLE scrape_state TO service_role;

-- SERIAL / BIGSERIAL inserts that omit the id call nextval() on the backing
-- sequence. nextval() requires USAGE. service_role is the only role that
-- inserts, so it is the only role granted here. SELECT is included as well:
-- it is the sequence privilege Supabase documents alongside USAGE, and it
-- covers currval(). anon does not insert, so anon gets neither privilege.
GRANT USAGE, SELECT ON SEQUENCE streams_id_seq TO service_role;
GRANT USAGE, SELECT ON SEQUENCE sync_logs_id_seq TO service_role;
GRANT USAGE, SELECT ON SEQUENCE scrape_state_id_seq TO service_role;

-- Defaults for objects created later by the role running this script.
-- They do not change the tables above, and a new table still needs its own
-- GRANT in this file (internal tables must not inherit anon SELECT).
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT ON TABLES TO anon;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO service_role;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT USAGE, SELECT ON SEQUENCES TO service_role;

-- ============================================================================
-- ROW LEVEL SECURITY (RLS) POLICIES
-- ============================================================================

-- Enable RLS
ALTER TABLE series ENABLE ROW LEVEL SECURITY;
ALTER TABLE videos ENABLE ROW LEVEL SECURITY;
ALTER TABLE streams ENABLE ROW LEVEL SECURITY;

-- Public read access for addon
DROP POLICY IF EXISTS "Enable read access for all users on series" ON series;
CREATE POLICY "Enable read access for all users on series"
ON series FOR SELECT
USING (true);

DROP POLICY IF EXISTS "Enable read access for all users on videos" ON videos;
CREATE POLICY "Enable read access for all users on videos"
ON videos FOR SELECT
USING (true);

DROP POLICY IF EXISTS "Enable read access for all users on streams" ON streams;
CREATE POLICY "Enable read access for all users on streams"
ON streams FOR SELECT
USING (true);

-- No insert/update policies (service role only via API)
-- This prevents unauthorized writes through API

-- Enable RLS for sync_logs and scrape_state
ALTER TABLE sync_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE scrape_state ENABLE ROW LEVEL SECURITY;

-- Policies: service role only (internal scraper use)
DROP POLICY IF EXISTS "Service role can manage sync_logs" ON sync_logs;
CREATE POLICY "Service role can manage sync_logs"
ON sync_logs FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

DROP POLICY IF EXISTS "Service role can manage scrape_state" ON scrape_state;
CREATE POLICY "Service role can manage scrape_state"
ON scrape_state FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

-- ============================================================================
-- SAMPLE QUERIES FOR TESTING
-- ============================================================================

-- Check if data was imported
-- SELECT scraper, COUNT(*) as count FROM series GROUP BY scraper;

-- Get latest series from each scraper
-- SELECT DISTINCT ON (scraper) scraper, name, latest_episode_date
-- FROM series
-- ORDER BY scraper, latest_episode_date DESC;

-- Count total videos per series
-- SELECT s.id, s.name, COUNT(v.id) as video_count
-- FROM series s
-- LEFT JOIN videos v ON v.series_id = s.id
-- GROUP BY s.id, s.name
-- ORDER BY video_count DESC;
