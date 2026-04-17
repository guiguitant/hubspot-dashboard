/**
 * One-shot script: regenerate sales_nav_url for all campaigns with criteria.
 * Run: node scripts/regenerate-salesnav-urls.js
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { buildSalesNavUrl } = require('../utils/buildSalesNavUrl');

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

(async () => {
  const { data: campaigns, error } = await supabaseAdmin
    .from('campaigns')
    .select('id, name, criteria, sales_nav_url');

  if (error) { console.error('Erreur fetch campaigns:', error.message); process.exit(1); }

  let updated = 0;
  for (const c of campaigns) {
    const criteria = c.criteria || {};
    const hasCriteria = criteria.jobTitles?.length || criteria.seniorities?.length ||
      criteria.geoIds?.length || criteria.sectorIds?.length ||
      criteria.headcounts?.length || criteria.keywords?.length;

    if (!hasCriteria) {
      console.log(`  SKIP ${c.name} — criteria vide`);
      continue;
    }

    const newUrl = buildSalesNavUrl(criteria);
    const changed = newUrl !== c.sales_nav_url;

    if (changed) {
      const { error: updateErr } = await supabaseAdmin
        .from('campaigns')
        .update({ sales_nav_url: newUrl })
        .eq('id', c.id);

      if (updateErr) {
        console.error(`  ERREUR ${c.name}:`, updateErr.message);
      } else {
        console.log(`  ✓ ${c.name} — URL régénérée`);
        updated++;
      }
    } else {
      console.log(`  = ${c.name} — URL déjà à jour`);
    }
  }

  console.log(`\nTerminé: ${updated} campagne(s) mise(s) à jour sur ${campaigns.length}`);
})();
