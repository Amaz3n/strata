const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

// Read .env.local
const envPath = path.join(__dirname, '../.env.local');
console.log('Loading env from:', envPath);
const envContent = fs.readFileSync(envPath, 'utf8');
const env = {};
envContent.split('\n').forEach(line => {
  const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
  if (match) {
    const key = match[1];
    let value = match[2] || '';
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.substring(1, value.length - 1);
    } else if (value.startsWith("'") && value.endsWith("'")) {
      value = value.substring(1, value.length - 1);
    }
    env[key] = value;
  }
});

const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Supabase URL or Key not found in .env.local');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    persistSession: false
  }
});

async function run() {
  console.log('Testing RPC get_user_sessions...');
  const { data, error } = await supabase.rpc('get_user_sessions');
  if (error) {
    console.error('RPC Error:', error);
  } else {
    console.log('RPC Data:', data);
  }

  console.log('\nTesting direct query on auth.sessions table (using service role)...');
  const authSupabase = createClient(supabaseUrl, supabaseKey, {
    db: {
      schema: 'auth'
    },
    auth: {
      persistSession: false
    }
  });

  const { data: sessions, error: sessionsError } = await authSupabase
    .from('sessions')
    .select('*')
    .limit(5);

  if (sessionsError) {
    console.error('Auth Sessions Query Error:', sessionsError);
  } else {
    console.log('Auth Sessions columns:', sessions.length > 0 ? Object.keys(sessions[0]) : 'No sessions found');
    console.log('Sample Session:', sessions[0]);
  }
}

run().catch(console.error);
