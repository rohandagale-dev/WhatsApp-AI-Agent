const { supabase } = require('../services/supabaseClient');

async function checkDatabase() {
  console.log("=== Checking Supabase Connection & Schema ===");
  console.log("Supabase URL:", process.env.SUPABASE_URL);

  const tables = [
    'personas',
    'contacts',
    'tags',
    'contact_tags',
    'chats',
    'insights',
    'relation_persons'
  ];

  let missingTables = [];
  let existingTables = [];
  let connectionError = null;

  for (const table of tables) {
    try {
      const { data, error } = await supabase
        .from(table)
        .select('*')
        .limit(1);

      if (error) {
        if (error.code === 'PGRST205') {
          missingTables.push(table);
        } else {
          console.error(`Error querying table '${table}':`, error);
          connectionError = error;
        }
      } else {
        existingTables.push(table);
      }
    } catch (err) {
      console.error(`Unexpected exception for table '${table}':`, err);
      connectionError = err;
    }
  }

  console.log("\n=== Results ===");
  if (connectionError) {
    console.log("❌ Connection Status: Failed to connect or encountered database errors.");
  } else if (existingTables.length === 0 && missingTables.length === 0) {
    console.log("❌ Connection Status: Could not check tables.");
  } else {
    console.log("✅ Connection Status: Connected successfully to Supabase!");
  }

  console.log(`\nExisting Tables (${existingTables.length}):`, existingTables);
  console.log(`Missing Tables (${missingTables.length}):`, missingTables);

  if (missingTables.length > 0) {
    console.log("\n👉 Action Required: It looks like the tables haven't been created yet.");
    console.log("Please copy the contents of 'supabase_schema.sql' and run it in the Supabase SQL Editor to create them.");
  } else {
    console.log("\n🎉 All tables exist and are migrated properly!");
  }
}

checkDatabase();
