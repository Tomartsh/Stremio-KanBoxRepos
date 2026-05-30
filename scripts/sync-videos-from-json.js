const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../classes/.env') });
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const AdmZip = require('adm-zip');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function syncVideosFromJson(jsonFile, scraperName) {
    console.log(`Loading JSON from ${jsonFile}...`);
    
    let jsonData;
    if (jsonFile.endsWith('.zip')) {
        const zip = new AdmZip(jsonFile);
        const entries = zip.getEntries();
        const jsonEntry = entries.find(e => e.entryName.endsWith('.json'));
        if (!jsonEntry) {
            throw new Error('No JSON file found in ZIP');
        }
        jsonData = JSON.parse(jsonEntry.getData().toString('utf8'));
    } else {
        jsonData = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
    }
    
    // Handle timestamp wrapper
    const seriesData = jsonData.data || jsonData;
    
    console.log(`Found ${Object.keys(seriesData).length} series in JSON`);
    
    let videosInserted = 0;
    let videosSkipped = 0;
    let seriesFixed = 0;
    
    for (const [seriesId, series] of Object.entries(seriesData)) {
        const videos = series.meta?.videos || [];
        
        if (videos.length === 0) continue;
        
        // Check if videos exist for this series
        const { data: existingVideos, count } = await supabase
            .from('videos')
            .select('id', { count: 'exact', head: true })
            .eq('series_id', seriesId);
        
        if (count > 0 && count === videos.length) {
            // Skip if all videos already exist
            videosSkipped += videos.length;
            continue;
        }
        
        console.log(`Syncing ${videos.length} videos for series ${seriesId} (${series.meta?.name || series.name})...`);
        
        // Delete existing videos for this series
        if (count > 0) {
            await supabase.from('videos').delete().eq('series_id', seriesId);
        }
        
        // Insert videos
        const videosToInsert = [];
        for (const video of videos) {
            videosToInsert.push({
                id: video.id,
                series_id: seriesId,
                title: video.title || video.name,
                season: video.season,
                episode: video.episode,
                description: video.description,
                thumbnail: video.thumbnail,
                episode_link: video.episodeLink,
                released: video.released && video.released !== "" ? video.released : null,
                tmdb_episode_id: video.tmdbEpisodeId
            });
        }
        
        if (videosToInsert.length > 0) {
            const { error } = await supabase.from('videos').insert(videosToInsert);
            if (error) {
                console.error(`  Error inserting videos: ${error.message}`);
            } else {
                videosInserted += videosToInsert.length;
                seriesFixed++;
                console.log(`  ✅ Inserted ${videosToInsert.length} videos`);
            }
        }
    }
    
    // Update video_count for affected series
    console.log('\nUpdating video_count for all series...');
    const { data: allSeries } = await supabase
        .from('series')
        .select('id')
        .eq('scraper', scraperName);
    
    for (const series of allSeries) {
        const { count } = await supabase
            .from('videos')
            .select('*', { count: 'exact', head: true })
            .eq('series_id', series.id);
        
        if (count !== null) {
            await supabase
                .from('series')
                .update({ video_count: count })
                .eq('id', series.id);
        }
    }
    
    console.log(`\n✅ Sync complete: ${videosInserted} videos inserted, ${videosSkipped} videos skipped, ${seriesFixed} series fixed`);
}

async function main() {
    const args = process.argv.slice(2);
    if (args.length === 0) {
        console.log('Usage: node sync-videos-from-json.js <json-file-or-zip> <scraper-name>');
        console.log('Example: node sync-videos-from-json.js ../output/stremio-kandigital.zip kandigital');
        process.exit(1);
    }
    
    const jsonFile = args[0];
    const scraperName = args[1] || 'kandigital';
    
    await syncVideosFromJson(jsonFile, scraperName);
}

main().catch(console.error);
