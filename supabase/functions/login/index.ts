// Log in with a Mesa username. The username is mapped to the account's email on the server,
// so email addresses never reach the client. Password checking is done by Supabase Auth.
import { createClient } from 'npm:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  let handle = '', password = '';
  try { const b = await req.json(); handle = String(b.handle || '').trim().replace(/^@/, '').toLowerCase(); password = String(b.password || ''); } catch { return json({ error: 'bad_request' }, 400); }
  if (!/^[a-z0-9_]{2,15}$/.test(handle) || !password) return json({ error: 'invalid_credentials' }, 400);

  const url = Deno.env.get('SUPABASE_URL')!;
  const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  const { data: row } = await admin.from('auth_handles').select('user_id').eq('handle', handle).maybeSingle();
  // Same response for unknown usernames and wrong passwords, so usernames can't be probed for accounts.
  if (!row) return json({ error: 'invalid_credentials' }, 400);
  const { data: u, error: ue } = await admin.auth.admin.getUserById(row.user_id);
  if (ue || !u?.user?.email) return json({ error: 'invalid_credentials' }, 400);

  const anon = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, { auth: { persistSession: false } });
  const { data, error } = await anon.auth.signInWithPassword({ email: u.user.email, password });
  if (error) {
    const notConfirmed = /confirm/i.test(error.message);
    return json({ error: notConfirmed ? 'email_not_confirmed' : 'invalid_credentials' }, 400);
  }
  return json({ access_token: data.session!.access_token, refresh_token: data.session!.refresh_token });
});
