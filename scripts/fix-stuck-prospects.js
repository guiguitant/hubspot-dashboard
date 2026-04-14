// One-time fix: reset prospects with status='Message à valider' but no pending_message
// Usage: node scripts/fix-stuck-prospects.js

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY
);

async function fix() {
  // Find all prospects with status='Message à valider' + no pending_message
  const { data: rows, error: fetchErr } = await supabase
    .from('prospects')
    .select('id, pending_message')
    .eq('status', 'Message à valider');

  if (fetchErr) { console.error('Fetch error:', fetchErr.message); process.exit(1); }

  const toFix = (rows || []).filter(p => !p.pending_message);
  console.log(`Found ${toFix.length} stuck prospect(s):`, toFix.map(p => p.id));

  if (!toFix.length) { console.log('Nothing to fix.'); return; }

  const ids = toFix.map(p => p.id);
  const { error: updateErr } = await supabase
    .from('prospects')
    .update({ status: 'Invitation acceptée' })
    .eq('status', 'Message à valider')
    .in('id', ids);

  if (updateErr) { console.error('Update error:', updateErr.message); process.exit(1); }

  console.log(`Fixed ${ids.length} prospect(s) → status set to "Invitation acceptée"`);
}

fix().catch(console.error);
