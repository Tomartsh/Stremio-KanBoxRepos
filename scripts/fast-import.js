#!/usr/bin/env node

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

console.log('🚀 Fast Database Import - Updating poster/background/streams...');
console.log('   This will take 2-3 minutes...');

async function importAll() {
    const buildDir = path.join(__dirname, '..', 'build');
    const files = fs.readdirSync(buildDir).filter(f => f.startsWith('stremio-') && f.endsWith('.json'));

    // Extract scraper type from filename
    const getScraperType = (fileName) => {
        if (fileName.includes('kandigital')) return 'kandigital';
        if (fileName.includes('kanarchive')) return 'kanarchive';
        if (fileName.includes('kankids')) return 'kankids';
        if (fileName.includes('kanteens')) return 'kanteens';
        if (fileName.includes('kan88')) return 'kan88';
        if (fileName.includes('kanpodcasts')) return 'kanpodcasts';
        if (fileName.includes('mako')) return 'mako';
        if (fileName.includes('reshet')) return 'reshet';
        return 'unknown';
    };

    let totalSeries = 0;
    let totalStreams = 0;
    let fileCount = 0;

    for (const file of files) {
        fileCount++;
        console.log(`[${fileCount}/${files.length}] Processing ${file}...`);

        try {
            const filePath = path.join(buildDir, file);
            const content = fs.readFileSync(filePath, 'utf8');
            const data = JSON.parse(content);
            const seriesData = data.data || data;
            const scraperType = getScraperType(file);

            // Batch update series (faster than individual updates)
            const seriesUpdates = [];
            const streamUpdates = [];

            for (const series of Object.values(seriesData)) {
                seriesUpdates.push({
                    id: series.id,
                    scraper: scraperType,
                    name: series.name || series.meta?.name,
                    poster: series.meta?.poster || null,
                    background: series.meta?.background || series.meta?.poster || null
                });
                totalSeries++;

                // Collect streams for batch insert
                const videos = series.meta?.videos || [];
                for (const video of videos) {
                    const streams = video.streams || [];
                    for (const stream of streams) {
                        streamUpdates.push({
                            video_id: video.id,
                            url: stream.url,
                            title: stream.name || 'Stream',
                            description: stream.description || null,
                            quality: stream.quality || null
                        });
                        totalStreams++;
                    }
                }
            }

            // Batch upsert series (100 at a time)
            const batchSize = 100;
            for (let i = 0; i < seriesUpdates.length; i += batchSize) {
                const batch = seriesUpdates.slice(i, i + batchSize);
                const { error } = await supabase.from('series').upsert(batch);
                if (error) {
                    console.log(`  ⚠️  Series batch ${Math.floor(i/batchSize) + 1} error: ${error.message}`);
                }
            }

            // Batch upsert streams (100 at a time)
            for (let i = 0; i < streamUpdates.length; i += batchSize) {
                const batch = streamUpdates.slice(i, i + batchSize);
                const { error } = await supabase.from('streams').upsert(batch);
                if (error) {
                    console.log(`  ⚠️  Streams batch ${Math.floor(i/batchSize) + 1} error: ${error.message}`);
                }
            }

            console.log(`  ✅ Updated ${seriesUpdates.length} series, ${streamUpdates.length} streams`);
        } catch (error) {
            console.log(`  ❌ Error processing ${file}: ${error.message}`);
        }
    }

    console.log(`\n📊 Results:`);
    console.log(`   Total series updated: ${totalSeries}`);
    console.log(`   Total streams imported: ${totalStreams}`);
    console.log(`\n✅ Import complete!`);
}

importAll().catch(console.error);
