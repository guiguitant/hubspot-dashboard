/* ============================================
   Releaf Prospector — Supabase Data Layer
   ============================================ */

const DB = (() => {
  let _sb = null;
  let _lastJWT = null;

  function sb() {
    if (!_sb) {
      const url = document.querySelector('meta[name="supabase-url"]')?.content;
      const key = document.querySelector('meta[name="supabase-key"]')?.content;
      _sb = supabase.createClient(url, key);
    }

    // If JWT token is available, set it as the session auth token
    const currentJWT = typeof accountContext !== 'undefined' ? accountContext.getJWTToken() : null;
    if (currentJWT && currentJWT !== _lastJWT) {
      _lastJWT = currentJWT;
      // Set the JWT token for RLS filtering
      // The token format is: { accessToken: token, refreshToken: null, expiresIn: 86400, expiresAt: timestamp, user: { id: account_id } }
      _sb.auth.setSession({
        access_token: currentJWT,
        refresh_token: '',
        expires_in: 86400,
        expires_at: Math.floor(Date.now() / 1000) + 86400,
        token_type: 'bearer',
        user: { id: accountContext.getAccountId() }
      }).catch(err => console.warn('Failed to set auth session:', err));
    }

    return _sb;
  }

  // ---- Prospects ----
  async function getProspects({ search, status, sector, geography, campaign_id, no_campaign } = {}) {
    // Use API endpoint which handles account filtering via X-Account-Id header
    const params = new URLSearchParams();
    if (status) params.append('status', status);
    if (campaign_id) params.append('campaign_id', campaign_id);

    const url = `/api/prospector/prospects${params.size ? '?' + params : ''}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to fetch prospects: ${response.statusText}`);
    let data = await response.json();

    // Client-side filtering for fields not handled by API
    if (sector) data = data.filter(p => p.sector === sector);
    if (geography) data = data.filter(p => p.geography === geography);
    if (no_campaign) data = data.filter(p => !p.campaign_id);
    if (search) {
      const s = search.toLowerCase();
      data = data.filter(p =>
        (p.first_name?.toLowerCase().includes(s)) ||
        (p.last_name?.toLowerCase().includes(s)) ||
        (p.company?.toLowerCase().includes(s)) ||
        (p.email?.toLowerCase().includes(s)) ||
        (p.job_title?.toLowerCase().includes(s))
      );
    }

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
    // Use API endpoint which handles account filtering via X-Account-Id header
    const response = await fetch('/api/prospector/campaigns');
    if (!response.ok) throw new Error(`Failed to fetch campaigns: ${response.statusText}`);
    return await response.json();
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
    try {
      const now = new Date();
      const monday = new Date(now);
      monday.setDate(now.getDate() - now.getDay() + (now.getDay() === 0 ? -6 : 1));
      monday.setHours(0, 0, 0, 0);
      const prospects = await getProspects();
      return prospects.filter(p => new Date(p.created_at) >= monday).length;
    } catch (e) {
      console.error('Error in getProspectsThisWeek:', e);
      return 0;
    }
  }

  async function getTotalProspects() {
    try {
      const prospects = await getProspects();
      return prospects.length;
    } catch (e) {
      console.error('Error in getTotalProspects:', e);
      return 0;
    }
  }

  async function getActiveCampaignCount() {
    try {
      const campaigns = await getCampaigns();
      return campaigns.filter(c => c.status === 'Active').length;
    } catch (e) {
      console.error('Error in getActiveCampaignCount:', e);
      return 0;
    }
  }

  async function getProspectCountsByStatus() {
    try {
      const prospects = await getProspects();
      const counts = {};
      for (const p of prospects) {
        counts[p.status] = (counts[p.status] || 0) + 1;
      }
      return counts;
    } catch (e) {
      console.error('Error in getProspectCountsByStatus:', e);
      return {};
    }
  }

  // Initialize JWT token and set up account change listener
  function initializeJWTAuth() {
    if (typeof accountContext !== 'undefined') {
      // Listen for account changes to refresh JWT token
      document.addEventListener('account-changed', (event) => {
        // Force refresh of Supabase session by resetting the cached client
        // This ensures the new JWT token is used for subsequent queries
        sb(); // Call sb() to trigger JWT update logic
      });
    }
  }

  // Initialize on module load if accountContext is available
  if (typeof accountContext !== 'undefined') {
    initializeJWTAuth();
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
    initializeJWTAuth,
  };
})();
