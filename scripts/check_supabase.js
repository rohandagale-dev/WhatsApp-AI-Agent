const { supabase } = require('../services/supabaseClient');

/**
 * One line instead of a whole HTML page. When the project itself is down,
 * Cloudflare answers on its behalf and supabase-js hands that HTML error page
 * back as error.message -- printed in full, once per table, it buries the cause.
 */
function describeError(error) {
  const msg = (error && error.message) || String(error);
  if (/^\s*</.test(msg)) {
    const title = (msg.match(/<title>([^<]*)<\/title>/i) || [])[1];
    return `HTML error page instead of data${title ? `: "${title.trim()}"` : ''}`;
  }
  return msg;
}

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
          console.error(`Error querying table '${table}':`, describeError(error));
          // The full error object (often a whole HTML page) is parked behind DEBUG.
          if (process.env.DEBUG === 'true') console.error(error);
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
    // Cloudflare 52x: Supabase's edge answered, the project behind it did not.
    if (/\b52\d\b/.test(describeError(connectionError))) {
      console.log("👉 Supabase answered, but your project did not. It is usually PAUSED (free projects pause");
      console.log("   after about a week without activity) or still restarting. Open the project in the");
      console.log("   Supabase dashboard, click 'Restore project' if it offers it, wait a minute, then rerun this.");
    }
    process.exitCode = 1;
  } else if (existingTables.length === 0 && missingTables.length === 0) {
    console.log("❌ Connection Status: Could not check tables.");
  } else {
    console.log("✅ Connection Status: Connected successfully to Supabase!");
  }

  console.log(`\nExisting Tables (${existingTables.length}):`, existingTables);
  console.log(`Missing Tables (${missingTables.length}):`, missingTables);

  if (connectionError) {
    // Missing = 0 here only because nothing could be checked -- never report
    // that as "all tables exist".
    console.log("\n⚠️  Tables could not be checked until the connection works.");
  } else if (missingTables.length > 0) {
    console.log("\n👉 Action Required: It looks like the tables haven't been created yet.");
    console.log("Please copy the contents of 'supabase_schema.sql' and run it in the Supabase SQL Editor to create them.");
  } else {
    console.log("\n🎉 All tables exist and are migrated properly!");
  }
}

checkDatabase();
