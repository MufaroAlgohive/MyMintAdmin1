require('dotenv').config({ path: '.env' });
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function fetchSupabase(path) {
  const res = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
    headers: {
      apikey: supabaseKey,
      Authorization: `Bearer ${supabaseKey}`
    }
  });
  return res.json();
}

async function run() {
  const adminTeam = await fetchSupabase('admin_team?select=*');
  console.log(JSON.stringify(adminTeam, null, 2));
}
run();
