#!/usr/bin/env node

/**
 * FAST BATCH IMPORT - Optimized for large datasets
 * Uses batching to insert data much faster than the original script
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

const scraper = process.argv[2];

if (!scraper) {
    console.error('Usage: node scripts/quick-import.js <scraper>');
    process.exit(1);
}

const fileName = `stremio-${scraper}.json`;
const buildDir = path.join(__dirname, '..', 'build');
const filePath = path.join(buildDir, fileName);

if (!fs.existsSync(filePath)) {
    console.error(`❌ File not found: ${filePath}`);
    process.exit(1);
}

async function quickImport() {
    console.log(`🚀 Quick importing ${scraper}...`);
    console.log(`📁 File: ${fileName}`);

    const content = fs.readFileSync(filePath, 'utf8');
    const data = JSON.parse(content);
    const seriesData = data.data || data;

    console.log(`\n📊 Found ${Object.keys(seriesData).length} series to import`);

    let seriesCount = 0;
    let videoCount = 0;
    let streamCount = 0;

    // Batch configuration
    const SERIES_BATCH_SIZE = 100;
    const VIDEO_BATCH_SIZE = 100;
    const STREAM_BATCH_SIZE = 100;

    const startTime = Date.now();

    // Prepare all data in memory first
    const seriesToInsert = [];
    const videosToInsert = [];
    const streamsToInsert = [];

    console.log('\n📋 Preparing data...');
    for (const [seriesId, series] of Object.entries(seriesData)) {
        // Series
        seriesToInsert.push({
            id: seriesId,
            scraper: scraper,
            name: series.meta?.name || series.name,
            poster: series.meta?.poster || series.poster,
            background: series.meta?.background || series.poster,
            description: series.meta?.description,
            link: series.link,
            type: series.type,
            subtype: series.subtype,
            genres: series.meta?.genres || [],
            tmdb_id: series.meta?.tmdbId
        });

        // Videos
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

            // Streams (deduplicated by URL)
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
                streamCount++;
            }
            videoCount++;
        }
        seriesCount++;
    }

    console.log(`   Prepared: ${seriesCount} series, ${videoCount} videos, ${streamCount} streams`);

    // Delete existing data
    console.log('\n🗑️  Clearing old data...');
    const { data: existingSeries } = await supabase.from('series').select('id').eq('scraper', scraper);
    if (existingSeries && existingSeries.length > 0) {
        const seriesIds = existingSeries.map(s => s.id);

        // Get all video IDs first
        const { data: allVideos } = await supabase.from('videos').select('id').in('series_id', seriesIds);
        if (allVideos && allVideos.length > 0) {
            const videoIds = allVideos.map(v => v.id);
            // Delete streams in batches
            for (let i = 0; i < videoIds.length; i += 1000) {
                const batch = videoIds.slice(i, i + 1000);
                await supabase.from('streams').delete().in('video_id', batch);
            }
        }

        await supabase.from('videos').delete().in('series_id', seriesIds);
        await supabase.from('series').delete().eq('scraper', scraper);
        console.log('   ✅ Old data cleared');
    }

    // Insert series in batches
    console.log('\n📥 Inserting series...');
    for (let i = 0; i < seriesToInsert.length; i += SERIES_BATCH_SIZE) {
        const batch = seriesToInsert.slice(i, i + SERIES_BATCH_SIZE);
        await supabase.from('series').insert(batch);
        console.log(`   Series: ${i + batch.length}/${seriesToInsert.length}`);
    }

    // Insert videos in batches
    console.log('\n📥 Inserting videos...');
    for (let i = 0; i < videosToInsert.length; i += VIDEO_BATCH_SIZE) {
        const batch = videosToInsert.slice(i, i + VIDEO_BATCH_SIZE);
        await supabase.from('videos').insert(batch);
        if ((i / VIDEO_BATCH_SIZE) % 10 === 0) {
            console.log(`   Videos: ${i + batch.length}/${videosToInsert.length}`);
        }
    }

    // Insert streams in batches
    console.log('\n📥 Inserting streams...');
    for (let i = 0; i < streamsToInsert.length; i += STREAM_BATCH_SIZE) {
        const batch = streamsToInsert.slice(i, i + STREAM_BATCH_SIZE);
        await supabase.from('streams').insert(batch);
        if ((i / STREAM_BATCH_SIZE) % 100 === 0) {
            console.log(`   Streams: ${i + batch.length}/${streamsToInsert.length}`);
        }
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n✅ Import complete in ${duration}s!`);
    console.log(`   Series: ${seriesCount}`);
    console.log(`   Videos: ${videoCount}`);
    console.log(`   Streams: ${streamCount}`);
}

quickImport().catch(error => {
    console.error('❌ Error:', error.message);
    process.exit(1);
});
