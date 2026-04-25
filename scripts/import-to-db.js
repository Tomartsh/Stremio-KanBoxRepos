#!/usr/bin/env node

/**
 * DATABASE IMPORT SCRIPT
 *
 * Run this script to import existing JSON files into Supabase database.
 * This is a one-time setup script to populate the database with existing scraped data.
 *
 * Usage:
 *   node scripts/import-to-db.js
 *
 * Prerequisites:
 *   - Supabase project created
 *   - Tables created (see database schema documentation)
 *   - SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY set in .env
 */

require('dotenv').config();
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const DatabaseImporter = require('../classes/DatabaseImporter');

// Validate environment variables
if (!process.env.SUPABASE_URL) {
    console.error('❌ Missing SUPABASE_URL in .env file');
    process.exit(1);
}

// Service role key is REQUIRED for writes (anon key only has read access)
if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('❌ Missing SUPABASE_SERVICE_ROLE_KEY in .env file');
    console.error('\nThe anon key only has read access due to RLS policies.');
    console.error('You must use the service role key for database imports.');
    console.error('\nTo get your service role key:');
    console.error('1. Go to https://supabase.com/dashboard/project/YOUR-PROJECT/settings/api');
    console.error('2. Scroll down to "Project API keys"');
    console.error('3. Copy the "service_role" key (NOT the anon key)');
    console.error('4. Add it to your .env file:');
    console.error('   SUPABASE_SERVICE_ROLE_KEY=your-service-role-key-here');
    console.error('\n⚠️  WARNING: Never share or commit the service role key!');
    process.exit(1);
}

// Initialize Supabase client with service role key
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Initialize Supabase client
const supabase = createClient(
    process.env.SUPABASE_URL,
    apiKey
);

console.log('🚀 Starting Database Import...');
console.log('📦 Connecting to Supabase...');

// Create importer instance
const importer = new DatabaseImporter(supabase);

// Run the import
(async () => {
    try {
        // Validate schema first
        await importer.validateDatabaseSchema();

        // Show pre-import stats
        console.log('\n📊 Pre-Import Analysis:');
        const stats = await importer.getPreImportStats();
        console.log(`   Files:   ${stats.files.length}`);
        console.log(`   Series:  ${stats.totalSeries}`);
        console.log(`   Videos:  ${stats.totalVideos}`);
        console.log('');

        // Confirm before proceeding
        console.log('⏱️  Import will begin in 5 seconds. Press Ctrl+C to cancel...');
        await new Promise(resolve => setTimeout(resolve, 5000));

        // Perform import
        await importer.importAll();

        console.log('\n✅ Import completed successfully!');
        console.log('💡 You can now run scrapers with incremental updates.');

        process.exit(0);

    } catch (error) {
        console.error('\n❌ Import failed:', error.message);
        console.error('\n💡 Troubleshooting:');
        console.error('   1. Ensure Supabase tables exist (run schema migration)');
        console.error('   2. Check .env file has correct credentials');
        console.error('   3. Verify build/ directory has JSON files');
        console.error('   4. Check logs/database-import.log for details');

        process.exit(1);
    }
})();
