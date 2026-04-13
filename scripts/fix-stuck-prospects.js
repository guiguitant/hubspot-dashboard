// One-time fix: reset prospects with status='Message à valider' but no pending_message
// Usage: node scripts/fix-stuck-prospects.js

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY
);

async function fix() {
  // Find all prospect_account rows with status='Message à valider' + no pending_message
  const { data: paRows, error: fetchErr } = await supabase
    .from('prospect_account')
    .select('prospect_id, account_id, prospects!inner(pending_message)')
    .eq('status', 'Message à valider');

  if (fetchErr) { console.error('Fetch error:', fetchErr.message); process.exit(1); }

  const toFix = (paRows || []).filter(pa => !pa.prospects.pending_message);
  console.log(`Found ${toFix.length} stuck prospect(s):`, toFix.map(pa => pa.prospect_id));

  if (!toFix.length) { console.log('Nothing to fix.'); return; }

  const ids = toFix.map(pa => pa.prospect_id);
  const { error: updateErr, count } = await supabase
    .from('prospect_account')
    .update({ status: 'Invitation acceptée' })
    .eq('status', 'Message à valider')
    .in('prospect_id', ids);

  if (updateErr) { console.error('Update error:', updateErr.message); process.exit(1); }

  console.log(`Fixed ${ids.length} prospect(s) → status set to "Invitation acceptée"`);
}

fix().catch(console.error);
