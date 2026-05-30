#!/usr/bin/env node

/**
 * Initial Database Load Script
 *
 * This script downloads all JSON files from GitHub and populates the database
 * for the first time. Use this for fresh installations.
 *
 * Usage: node scripts/initial-load.js
 */

require('dotenv').config({ path: '../classes/.env' });
const { createClient } = require('@supabase/supabase-js');
const https = require('https');
const fs = require('fs');
const path = require('path');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY // Use service role key for bulk operations
);

// GitHub repository settings
const GITHUB_RAW_BASE = 'https://raw.githubusercontent.com/tomartsh/Stremio-KanBoxRepos/main/output';

const JSON_FILES = [
    'stremio-kandigital.json',
    'stremio-kanarchive.json',
    'stremio-kankids.json',
    'stremio-kanteens.json',
    'stremio-kan88.json',
    'stremio-kanpodcasts.json',
    'stremio-mako.json',
    'stremio-reshet.json'
];

const OUTPUT_DIR = path.join(__dirname, '..', 'output');

/**
 * Download a file from URL
 */
function downloadFile(url, filepath) {
    return new Promise((resolve, reject) => {
        console.log(`   📥 Downloading: ${path.basename(filepath)}`);

        const file = fs.createWriteStream(filepath);

        https.get(url, (response) => {
            if (response.statusCode !== 200) {
                reject(new Error(`Failed to download: ${response.statusCode}`));
                return;
            }

            response.pipe(file);

            file.on('finish', () => {
                file.close();
                resolve();
            });
        }).on('error', (err) => {
            fs.unlink(filepath, () => {}); // Delete the file on error
            reject(err);
        });
    });
}

/**
 * Download all JSON files from GitHub
 */
async function downloadAllJSON() {
    console.log('📥 Downloading JSON files from GitHub...\n');

    // Create output directory if it doesn't exist
    if (!fs.existsSync(OUTPUT_DIR)) {
        fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }

    let downloaded = 0;
    let failed = 0;

    for (const filename of JSON_FILES) {
        const url = `${GITHUB_RAW_BASE}/${filename}`;
        const filepath = path.join(OUTPUT_DIR, filename);

        try {
            await downloadFile(url, filepath);
            downloaded++;
        } catch (error) {
            console.error(`   ❌ Failed to download ${filename}: ${error.message}`);
            failed++;
        }
    }

    console.log(`\n✅ Downloaded: ${downloaded}/${JSON_FILES.length} files`);
    if (failed > 0) {
        console.log(`❌ Failed: ${failed} files`);
        return false;
    }

    return true;
}

/**
 * Load data from a JSON file into the database
 */
async function loadJSONFile(filename, scraperName) {
    console.log(`\n📄 Processing: ${filename}`);

    const filepath = path.join(OUTPUT_DIR, filename);

    if (!fs.existsSync(filepath)) {
        console.log(`   ⚠️  File not found, skipping...`);
        return { series: 0, videos: 0, streams: 0 };
    }

    try {
        const jsonData = JSON.parse(fs.readFileSync(filepath, 'utf8'));
        // Handle JSON structure with {timestamp, data} wrapper
        const seriesData = Object.values(jsonData.data || jsonData);

        console.log(`   Found ${seriesData.length} series`);

        // Prepare data for insertion
        const seriesToInsert = [];
        const videosToInsert = [];
        const streamsToInsert = [];

        for (const series of seriesData) {
            // Extract series data
            const seriesRecord = {
                id: series.id,
                name: series.name,
                type: series.type,
                subtype: series.subtype,
                link: series.link,
                poster: series.poster || series.meta?.poster || '',
                background: series.background || series.meta?.background || '',
                description: series.description || series.meta?.description || '',
                genres: Array.isArray(series.genres) ? series.genres : (series.meta?.genres || []),
                tmdb_id: series.tmdbId || series.meta?.tmdbId || null
            };

            seriesToInsert.push(seriesRecord);

            // Extract videos
            if (series.meta?.videos && Array.isArray(series.meta.videos)) {
                for (const video of series.meta.videos) {
                    const videoRecord = {
                        id: video.id,
                        series_id: series.id,
                        name: video.name,
                        season: video.season,
                        episode: video.episode,
                        description: video.description || '',
                        thumbnail: video.thumbnail || '',
                        episode_link: video.episodeLink || video.episode_link || '',
                        released: video.released || null,
                        tmdb_episode_id: video.tmdbEpisodeId || video.tmdb_episode_id || null
                    };

                    videosToInsert.push(videoRecord);

                    // Extract streams
                    if (video.streams && Array.isArray(video.streams)) {
                        for (const stream of video.streams) {
                            if (stream.url && stream.url.trim() !== '') {
                                const streamRecord = {
                                    video_id: video.id,
                                    url: stream.url,
                                    title: stream.title || stream.name || '',
                                    name: stream.name || stream.title || ''
                                };
                                streamsToInsert.push(streamRecord);
                            }
                        }
                    }
                }
            }
        }

        // Delete existing data for this scraper
        console.log(`   🗑️  Cleaning old data...`);
        await supabase.from('videos').delete().in('series_id', seriesToInsert.map(s => s.id));
        await supabase.from('series').delete().in('id', seriesToInsert.map(s => s.id));

        // Insert in batches
        const BATCH_SIZE = 100;

        console.log(`   📦 Inserting ${seriesToInsert.length} series...`);
        for (let i = 0; i < seriesToInsert.length; i += BATCH_SIZE) {
            const batch = seriesToInsert.slice(i, i + BATCH_SIZE);
            const { error } = await supabase.from('series').insert(batch);
            if (error) {
                console.error(`   ❌ Error inserting series batch: ${error.message}`);
                throw error;
            }
        }

        console.log(`   📦 Inserting ${videosToInsert.length} videos...`);
        for (let i = 0; i < videosToInsert.length; i += BATCH_SIZE) {
            const batch = videosToInsert.slice(i, i + BATCH_SIZE);
            const { error } = await supabase.from('videos').insert(batch);
            if (error) {
                console.error(`   ❌ Error inserting videos batch: ${error.message}`);
                throw error;
            }
        }

        console.log(`   📦 Inserting ${streamsToInsert.length} streams...`);
        for (let i = 0; i < streamsToInsert.length; i += BATCH_SIZE) {
            const batch = streamsToInsert.slice(i, i + BATCH_SIZE);
            const { error } = await supabase.from('streams').insert(batch);
            if (error) {
                console.error(`   ❌ Error inserting streams batch: ${error.message}`);
                throw error;
            }
        }

        console.log(`   ✅ Loaded: ${seriesToInsert.length} series, ${videosToInsert.length} videos, ${streamsToInsert.length} streams`);

        return {
            series: seriesToInsert.length,
            videos: videosToInsert.length,
            streams: streamsToInsert.length
        };

    } catch (error) {
        console.error(`   ❌ Error processing ${filename}: ${error.message}`);
        throw error;
    }
}

/**
 * Main execution
 */
async function main() {
    console.log('🚀 Initial Database Load');
    console.log('=' .repeat(70));
    console.log('');

    try {
        // Step 1: Download JSON files
        const downloadSuccess = await downloadAllJSON();
        if (!downloadSuccess) {
            console.error('\n❌ Download failed. Aborting.');
            process.exit(1);
        }

        console.log('\n' + '='.repeat(70));
        console.log('📦 Populating Database');
        console.log('='.repeat(70));

        // Step 2: Load data into database
        let totalSeries = 0;
        let totalVideos = 0;
        let totalStreams = 0;

        const scraperMap = {
            'stremio-kandigital.json': 'kandigital',
            'stremio-kanarchive.json': 'kanarchive',
            'stremio-kankids.json': 'kankids',
            'stremio-kanteens.json': 'kanteens',
            'stremio-kan88.json': 'kan88',
            'stremio-kanpodcasts.json': 'kanpodcasts',
            'stremio-mako.json': 'mako',
            'stremio-reshet.json': 'reshet'
        };

        for (const filename of JSON_FILES) {
            const scraperName = scraperMap[filename];
            const result = await loadJSONFile(filename, scraperName);

            totalSeries += result.series;
            totalVideos += result.videos;
            totalStreams += result.streams;
        }

        // Summary
        console.log('\n' + '='.repeat(70));
        console.log('✅ Initial Load Complete!');
        console.log('='.repeat(70));
        console.log(`📊 Summary:`);
        console.log(`   Series: ${totalSeries}`);
        console.log(`   Videos: ${totalVideos}`);
        console.log(`   Streams: ${totalStreams}`);
        console.log('');
        console.log('💡 Tip: You can now start the addon with: node main.js');

    } catch (error) {
        console.error('\n❌ Fatal error:', error.message);
        console.error(error.stack);
        process.exit(1);
    }
}

// Run the script
main().catch(error => {
    console.error('Unhandled error:', error);
    process.exit(1);
});
