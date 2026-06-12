#!/usr/bin/env node

/**
 * Clean Scraper Data from Database
 *
 * This script deletes all data (series, videos, streams) for a specific scraper.
 * Use this before re-running a full scrape to start fresh.
 *
 * Usage: node clean-scraper.js <scraper-name>
 *
 * Scraper names:
 *   - kandigital
 *   - kanarchive
 *   - kankids
 *   - kanteens
 *   - kan88
 *   - kanpodcasts
 *   - mako
 *   - reshet
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../classes/.env') });
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function cleanScraper(scraperName) {
    console.log(`\n🗑️  Cleaning data for scraper: ${scraperName}`);
    console.log('='.repeat(70));

    // Verify environment variables
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
        console.error('❌ SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set');
        process.exit(1);
    }

    try {
        // Step 1: Get all series IDs for this scraper
        console.log(`\n📋 Finding series for scraper: ${scraperName}...`);
        const { data: series, error: seriesError } = await supabase
            .from('series')
            .select('id, name')
            .eq('scraper', scraperName);

        if (seriesError) {
            throw new Error(`Failed to query series: ${seriesError.message}`);
        }

        if (!series || series.length === 0) {
            console.log(`✅ No series found for scraper: ${scraperName}`);
            return;
        }

        console.log(`   Found ${series.length} series:`);
        series.forEach(s => console.log(`   - ${s.name} (${s.id})`));

        // Step 2: Delete streams (via videos)
        console.log(`\n🗑️  Deleting streams...`);
        const { data: streamsBefore } = await supabase
            .from('streams')
            .select('video_id')
            .in('video_id',
                (await supabase.from('videos').select('id').in('series_id', series.map(s => s.id))).data?.map(v => v.id) || []
            );

        if (streamsBefore && streamsBefore.length > 0) {
            const { error: streamsError } = await supabase
                .from('streams')
                .delete()
                .in('video_id', streamsBefore.map(s => s.video_id));

            if (streamsError) {
                throw new Error(`Failed to delete streams: ${streamsError.message}`);
            }
            console.log(`   ✅ Deleted ${streamsBefore.length} streams`);
        } else {
            console.log(`   ✅ No streams to delete`);
        }

        // Step 3: Delete videos
        console.log(`\n🗑️  Deleting videos...`);
        const { data: videosBefore } = await supabase
            .from('videos')
            .select('id')
            .in('series_id', series.map(s => s.id));

        if (videosBefore && videosBefore.length > 0) {
            const { error: videosError } = await supabase
                .from('videos')
                .delete()
                .in('series_id', series.map(s => s.id));

            if (videosError) {
                throw new Error(`Failed to delete videos: ${videosError.message}`);
            }
            console.log(`   ✅ Deleted ${videosBefore.length} videos`);
        } else {
            console.log(`   ✅ No videos to delete`);
        }

        // Step 4: Delete series
        console.log(`\n🗑️  Deleting series...`);
        const { error: seriesDeleteError } = await supabase
            .from('series')
            .delete()
            .in('id', series.map(s => s.id));

        if (seriesDeleteError) {
            throw new Error(`Failed to delete series: ${seriesDeleteError.message}`);
        }
        console.log(`   ✅ Deleted ${series.length} series`);

        // Verify deletion
        const { count } = await supabase
            .from('series')
            .select('*', { count: 'exact', head: true })
            .eq('scraper', scraperName);

        console.log(`\n✅ Cleanup complete! Remaining series: ${count || 0}`);
        console.log(`\n💡 You can now run a full scrape for ${scraperName}`);

    } catch (error) {
        console.error(`\n❌ Error: ${error.message}`);
        process.exit(1);
    }
}

async function main() {
    const args = process.argv.slice(2);

    if (args.length === 0) {
        console.log('Usage: node clean-scraper.js <scraper-name>');
        console.log('\nAvailable scrapers:');
        console.log('  - kandigital');
        console.log('  - kanarchive');
        console.log('  - kankids');
        console.log('  - kanteens');
        console.log('  - kan88');
        console.log('  - kanpodcasts');
        console.log('  - mako');
        console.log('  - reshet');
        process.exit(1);
    }

    const scraperName = args[0];
    await cleanScraper(scraperName);
}

main().catch(console.error);
