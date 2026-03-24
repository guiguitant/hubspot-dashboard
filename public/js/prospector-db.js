/* ============================================
   Releaf Prospector — Supabase Data Layer
   ============================================ */

const DB = (() => {
  let _sb = null;
  function sb() {
    if (!_sb) {
      const url = document.querySelector('meta[name="supabase-url"]')?.content;
      const key = document.querySelector('meta[name="supabase-key"]')?.content;
      _sb = supabase.createClient(url, key);
    }
    return _sb;
  }

  // ---- Prospects ----
  async function getProspects({ search, status, sector, geography, campaign_id, no_campaign } = {}) {
    let q = sb().from('prospects').select('*, campaigns(name)').order('created_at', { ascending: false });
    if (status) q = q.eq('status', status);
    if (sector) q = q.eq('sector', sector);
    if (geography) q = q.eq('geography', geography);
    if (campaign_id) q = q.eq('source_campaign_id', campaign_id);
    if (no_campaign) q = q.is('source_campaign_id', null);
    if (search) q = q.or(`first_name.ilike.%${search}%,last_name.ilike.%${search}%,company.ilike.%${search}%,email.ilike.%${search}%,job_title.ilike.%${search}%`);
    const { data, error } = await q;
    if (error) throw error;
    return data;
  }

  async function getProspect(id) {
    const { data, error } = await sb().from('prospects').select('*, campaigns(name)').eq('id', id).single();
    if (error) throw error;
    return data;
  }

  async function createProspect(p) {
    const { data, error } = await sb().from('prospects').insert(p).select().single();
    if (error) throw error;
    return data;
  }

  async function updateProspect(id, updates) {
    updates.updated_at = new Date().toISOString();
    const { data, error } = await sb().from('prospects').update(updates).eq('id', id).select().single();
    if (error) throw error;
    return data;
  }

  async function deleteProspect(id) {
    const { error } = await sb().from('prospects').delete().eq('id', id);
    if (error) throw error;
  }

  async function checkDuplicates(prospect, excludeId) {
    const dupes = [];
    if (prospect.email) {
      let q = sb().from('prospects').select('id, first_name, last_name, email').eq('email', prospect.email);
      if (excludeId) q = q.neq('id', excludeId);
      const { data } = await q;
      if (data?.length) dupes.push(...data);
    }
    if (prospect.linkedin_url) {
      let q = sb().from('prospects').select('id, first_name, last_name, linkedin_url').eq('linkedin_url', prospect.linkedin_url);
      if (excludeId) q = q.neq('id', excludeId);
      const { data } = await q;
      if (data?.length) {
        for (const d of data) { if (!dupes.find(x => x.id === d.id)) dupes.push(d); }
      }
    }
    if (prospect.first_name && prospect.last_name) {
      let q = sb().from('prospects').select('id, first_name, last_name')
        .ilike('first_name', prospect.first_name)
        .ilike('last_name', prospect.last_name);
      if (excludeId) q = q.neq('id', excludeId);
      const { data } = await q;
      if (data?.length) {
        for (const d of data) { if (!dupes.find(x => x.id === d.id)) dupes.push(d); }
      }
    }
    return dupes;
  }

  async function getDistinctValues(column) {
    const { data, error } = await sb().from('prospects').select(column);
    if (error) return [];
    const vals = [...new Set(data.map(r => r[column]).filter(Boolean))];
    vals.sort();
    return vals;
  }

  // ---- Campaigns ----
  async function getCampaigns() {
    const { data, error } = await sb().from('campaigns').select('*').order('created_at', { ascending: false });
    if (error) throw error;
    return data;
  }

  async function getCampaign(id) {
    const { data, error } = await sb().from('campaigns').select('*').eq('id', id).single();
    if (error) throw error;
    return data;
  }

  async function createCampaign(c) {
    const { data, error } = await sb().from('campaigns').insert(c).select().single();
    if (error) throw error;
    return data;
  }

  async function updateCampaign(id, updates) {
    const { data, error } = await sb().from('campaigns').update(updates).eq('id', id).select().single();
    if (error) throw error;
    return data;
  }

  async function getCampaignProspects(campaignId) {
    const { data, error } = await sb().from('prospects').select('*').eq('source_campaign_id', campaignId).order('created_at', { ascending: false });
    if (error) throw error;
    return data;
  }

  async function getCampaignProspectCount(campaignId) {
    const { count, error } = await sb().from('prospects').select('id', { count: 'exact', head: true }).eq('source_campaign_id', campaignId);
    if (error) return 0;
    return count || 0;
  }

  // ---- Interactions ----
  async function getInteractions(prospectId) {
    const { data, error } = await sb().from('interactions').select('*').eq('prospect_id', prospectId).order('date', { ascending: false });
    if (error) throw error;
    return data;
  }

  async function getRecentInteractions(limit = 10) {
    const { data, error } = await sb().from('interactions').select('*, prospects(first_name, last_name, company)').order('created_at', { ascending: false }).limit(limit);
    if (error) throw error;
    return data;
  }

  async function createInteraction(i) {
    const { data, error } = await sb().from('interactions').insert(i).select().single();
    if (error) throw error;
    return data;
  }

  // ---- Reminders ----
  async function getReminders({ status } = {}) {
    let q = sb().from('reminders').select('*, prospects(first_name, last_name)').order('due_date', { ascending: true });
    if (status) q = q.eq('status', status);
    const { data, error } = await q;
    if (error) throw error;
    return data;
  }

  async function getProspectReminders(prospectId) {
    const { data, error } = await sb().from('reminders').select('*').eq('prospect_id', prospectId).order('due_date', { ascending: true });
    if (error) throw error;
    return data;
  }

  async function createReminder(r) {
    const { data, error } = await sb().from('reminders').insert(r).select().single();
    if (error) throw error;
    return data;
  }

  async function markReminderDone(id) {
    const { error } = await sb().from('reminders').update({ status: 'done' }).eq('id', id);
    if (error) throw error;
  }

  async function snoozeReminder(id, days = 3) {
    const { data: rem } = await sb().from('reminders').select('due_date').eq('id', id).single();
    const d = new Date(rem.due_date);
    d.setDate(d.getDate() + days);
    const newDate = d.toISOString().split('T')[0];
    const { error } = await sb().from('reminders').update({ due_date: newDate, status: 'pending' }).eq('id', id);
    if (error) throw error;
  }

  async function getPendingReminderCount() {
    const today = new Date().toISOString().split('T')[0];
    const { count, error } = await sb().from('reminders').select('id', { count: 'exact', head: true })
      .eq('status', 'pending').lte('due_date', today);
    if (error) return 0;
    return count || 0;
  }

  // ---- Imports ----
  async function createImport(i) {
    const { data, error } = await sb().from('imports').insert(i).select().single();
    if (error) throw error;
    return data;
  }

  async function bulkInsertProspects(prospects) {
    const { data, error } = await sb().from('prospects').insert(prospects).select();
    if (error) throw error;
    return data;
  }

  // ---- Stats ----
  async function getProspectsThisWeek() {
    const now = new Date();
    const monday = new Date(now);
    monday.setDate(now.getDate() - now.getDay() + (now.getDay() === 0 ? -6 : 1));
    monday.setHours(0, 0, 0, 0);
    const { count, error } = await sb().from('prospects').select('id', { count: 'exact', head: true })
      .gte('created_at', monday.toISOString());
    if (error) return 0;
    return count || 0;
  }

  async function getTotalProspects() {
    const { count, error } = await sb().from('prospects').select('id', { count: 'exact', head: true });
    if (error) return 0;
    return count || 0;
  }

  async function getActiveCampaignCount() {
    const { count, error } = await sb().from('campaigns').select('id', { count: 'exact', head: true }).eq('status', 'Active');
    if (error) return 0;
    return count || 0;
  }

  async function getProspectCountsByStatus() {
    const { data, error } = await sb().from('prospects').select('status');
    if (error) return {};
    const counts = {};
    for (const r of data) {
      counts[r.status] = (counts[r.status] || 0) + 1;
    }
    return counts;
  }

  return {
    getProspects, getProspect, createProspect, updateProspect, deleteProspect,
    checkDuplicates, getDistinctValues, bulkInsertProspects,
    getCampaigns, getCampaign, createCampaign, updateCampaign,
    getCampaignProspects, getCampaignProspectCount,
    getInteractions, getRecentInteractions, createInteraction,
    getReminders, getProspectReminders, createReminder, markReminderDone, snoozeReminder,
    getPendingReminderCount, createImport,
    getProspectsThisWeek, getTotalProspects, getActiveCampaignCount, getProspectCountsByStatus,
  };
})();
