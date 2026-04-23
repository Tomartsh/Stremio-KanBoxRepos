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
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('❌ Missing environment variables:');
    console.error('   SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env file');
    console.error('\nCreate a .env file with:');
    console.error('   SUPABASE_URL=https://your-project.supabase.co');
    console.error('   SUPABASE_SERVICE_ROLE_KEY=your-service-role-key');
    process.exit(1);
}

// Initialize Supabase client
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
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
