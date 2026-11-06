const { envPath } = require('../loadEnv');
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  const missing = [
    !supabaseUrl && 'SUPABASE_URL',
    !supabaseKey && 'SUPABASE_KEY',
  ].filter(Boolean).join(' and ');
  console.error(`Missing ${missing} in environment variables.`);
  console.error(`Looked for them in: ${envPath}`);
  console.error("Check that this file exists and defines both keys (see .env.example).");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

module.exports = { supabase };
