/**
 * One-shot script: purge "Profil incomplet" prospects from campaign 6fed04c2
 * created on 2025-04-19 (the botched Task 1 run).
 *
 * Usage:
 *   node scripts/purge-incomplete-prospects.js --dry-run   # preview only
 *   node scripts/purge-incomplete-prospects.js              # actual delete
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const CAMPAIGN_ID = '6fed04c2-b6c1-4e05-9499-0b45a6be5f90';
const ACCOUNT_ID = 'c6cceb81-11e9-4bae-8b09-c55490d79646';
const CREATED_AFTER = '2026-04-19T00:00:00Z';
const CREATED_BEFORE = '2026-04-20T00:00:00Z';
const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  console.log(`\n=== Purge "Profil incomplet" prospects ===`);
  console.log(`Campaign: ${CAMPAIGN_ID}`);
  console.log(`Account:  ${ACCOUNT_ID}`);
  console.log(`Created:  ${CREATED_AFTER} → ${CREATED_BEFORE}`);
  console.log(`Mode:     ${DRY_RUN ? 'DRY RUN (preview only)' : '⚠️  LIVE DELETE'}\n`);

  // Find matching prospects
  const { data: targets, error: selectErr } = await supabaseAdmin
    .from('prospects')
    .select('id, first_name, last_name, sales_nav_url, linkedin_url, company, job_title, created_at')
    .eq('account_id', ACCOUNT_ID)
    .eq('campaign_id', CAMPAIGN_ID)
    .eq('status', 'Profil incomplet')
    .gte('created_at', CREATED_AFTER)
    .lte('created_at', CREATED_BEFORE);

  if (selectErr) {
    console.error('Select error:', selectErr.message);
    process.exit(1);
  }

  console.log(`Found ${targets.length} prospects matching criteria.\n`);

  if (!targets.length) {
    console.log('Nothing to delete.');
    process.exit(0);
  }

  // Show sample
  console.log('Sample (first 10):');
  targets.slice(0, 10).forEach(p => {
    console.log(`  - ${p.first_name} ${p.last_name} | company: "${p.company || ''}" | linkedin: ${p.linkedin_url || 'null'} | created: ${p.created_at}`);
  });
  console.log();

  // Stats
  const withLinkedin = targets.filter(p => p.linkedin_url).length;
  const withCompany = targets.filter(p => p.company).length;
  const withJobTitle = targets.filter(p => p.job_title).length;
  console.log(`Stats: ${withLinkedin}/${targets.length} have linkedin_url, ${withCompany}/${targets.length} have company, ${withJobTitle}/${targets.length} have job_title\n`);

  if (DRY_RUN) {
    console.log('DRY RUN — no changes made. Run without --dry-run to delete.');
    process.exit(0);
  }

  const ids = targets.map(p => p.id);

  // Delete related records first
  console.log('Deleting related status_history records...');
  const { error: shErr } = await supabaseAdmin.from('status_history').delete().in('prospect_id', ids);
  if (shErr) console.warn('status_history delete warning:', shErr.message);

  console.log('Deleting related interactions...');
  const { error: intErr } = await supabaseAdmin.from('interactions').delete().in('prospect_id', ids);
  if (intErr) console.warn('interactions delete warning:', intErr.message);

  console.log('Deleting related prospect_events...');
  const { error: evErr } = await supabaseAdmin.from('prospect_events').delete().in('prospect_id', ids);
  if (evErr) console.warn('prospect_events delete warning:', evErr.message);

  // Delete prospects in batches of 100
  let deleted = 0;
  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100);
    const { error: delErr } = await supabaseAdmin.from('prospects').delete()
      .eq('account_id', ACCOUNT_ID)
      .eq('campaign_id', CAMPAIGN_ID)
      .in('id', batch);
    if (delErr) {
      console.error(`Batch delete error at offset ${i}:`, delErr.message);
      process.exit(1);
    }
    deleted += batch.length;
    console.log(`  Deleted ${deleted}/${ids.length}`);
  }

  console.log(`\n✅ Done. ${deleted} prospects purged.`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
