#!/usr/bin/env node

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

console.log('🚀 Fast Database Import - Updating poster/background only...');
console.log('   (Streams import skipped for speed)');

async function importAll() {
    const buildDir = path.join(__dirname, '..', 'build');
    const files = fs.readdirSync(buildDir).filter(f => f.startsWith('stremio-') && f.endsWith('.json'));

    let totalSeries = 0;
    let fileCount = 0;

    for (const file of files) {
        fileCount++;
        console.log(`[${fileCount}/${files.length}] Processing ${file}...`);

        try {
            const filePath = path.join(buildDir, file);
            const content = fs.readFileSync(filePath, 'utf8');
            const data = JSON.parse(content);
            const seriesData = data.data || data;

            // Batch update series (faster than individual updates)
            const seriesUpdates = [];
            for (const series of Object.values(seriesData)) {
                if (series.meta?.poster || series.meta?.background) {
                    seriesUpdates.push({
                        id: series.id,
                        poster: series.meta?.poster || null,
                        background: series.meta?.background || null
                    });
                    totalSeries++;
                }
            }

            // Batch upsert (100 at a time)
            if (seriesUpdates.length > 0) {
                const batchSize = 100;
                for (let i = 0; i < seriesUpdates.length; i += batchSize) {
                    const batch = seriesUpdates.slice(i, i + batchSize);
                    const { error } = await supabase.from('series').upsert(batch);
                    if (error) {
                        console.log(`  ⚠️  Batch ${i/batchSize + 1} error: ${error.message}`);
                    }
                }
            }

            console.log(`  ✅ Updated ${seriesUpdates.length} series`);
        } catch (error) {
            console.log(`  ❌ Error processing ${file}: ${error.message}`);
        }
    }

    console.log(`\n📊 Results:`);
    console.log(`   Total series updated: ${totalSeries}`);
    console.log(`\n✅ Import complete!`);
    console.log(`\n💡 Note: Streams import skipped - will be added separately if needed`);
}

importAll().catch(console.error);
