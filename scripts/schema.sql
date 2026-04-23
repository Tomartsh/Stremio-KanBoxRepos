-- ============================================================================
-- SUPABASE DATABASE SCHEMA FOR STREMIO ADDON
-- ============================================================================
--
-- Run this SQL in Supabase SQL Editor to create the required tables
-- https://supabase.com/dashboard/project/YOUR-PROJECT/sql/new
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
-- FUNCTIONS AND TRIGGERS
-- ============================================================================

-- Function to update updated_at timestamp automatically
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Triggers to auto-update updated_at
CREATE TRIGGER update_series_updated_at
    BEFORE UPDATE ON series
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_videos_updated_at
    BEFORE UPDATE ON videos
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- ROW LEVEL SECURITY (RLS) POLICIES
-- ============================================================================

-- Enable RLS
ALTER TABLE series ENABLE ROW LEVEL SECURITY;
ALTER TABLE videos ENABLE ROW LEVEL SECURITY;
ALTER TABLE streams ENABLE ROW LEVEL SECURITY;

-- Public read access for addon
CREATE POLICY "Enable read access for all users on series"
ON series FOR SELECT
USING (true);

CREATE POLICY "Enable read access for all users on videos"
ON videos FOR SELECT
USING (true);

CREATE POLICY "Enable read access for all users on streams"
ON streams FOR SELECT
USING (true);

-- No insert/update policies (service role only via API)
-- This prevents unauthorized writes through API

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
