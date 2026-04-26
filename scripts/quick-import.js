#!/usr/bin/env node

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

console.log('🚀 Quick Database Import - Updating poster/background/streams...');

async function importAll() {
    const buildDir = path.join(__dirname, '..', 'build');
    const files = fs.readdirSync(buildDir).filter(f => f.startsWith('stremio-') && f.endsWith('.json'));

    let totalSeries = 0;
    let totalVideos = 0;
    let totalStreams = 0;

    for (const file of files) {
        console.log(`Processing ${file}...`);
        const filePath = path.join(buildDir, file);
        const content = fs.readFileSync(filePath, 'utf8');
        const data = JSON.parse(content);
        const seriesData = data.data || data;

        for (const series of Object.values(seriesData)) {
            try {
                // Update series with poster/background
                const seriesUpdate = {
                    id: series.id,
                    poster: series.meta?.poster || null,
                    background: series.meta?.background || null,
                    description: series.meta?.description || null
                };

                await supabase.from('series').upsert(seriesUpdate);
                totalSeries++;

                // Update videos with streams
                const videos = series.meta?.videos || [];
                for (const video of videos) {
                    // Update video
                    totalVideos++;

                    // Insert streams
                    const streams = video.streams || [];
                    for (const stream of streams) {
                        const streamData = {
                            video_id: video.id,
                            url: stream.url,
                            title: stream.name || 'Stream',
                            description: stream.description || null,
                            quality: stream.quality || null
                        };

                        const { error } = await supabase.from('streams').upsert(streamData);
                        if (!error) {
                            totalStreams++;
                        }
                    }
                }
            } catch (error) {
                console.log(`  ⚠️  Error processing ${series.id}: ${error.message}`);
            }
        }

        console.log(`  ✅ ${file} complete`);
    }

    console.log(`\n📊 Results:`);
    console.log(`   Series updated: ${totalSeries}`);
    console.log(`   Videos processed: ${totalVideos}`);
    console.log(`   Streams imported: ${totalStreams}`);
    console.log(`\n✅ Import complete!`);
}

importAll().catch(console.error);
