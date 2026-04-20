/* ============================================
   Releaf Prospector — Main Application Logic
   ============================================ */

const App = (() => {

  // ---- Router ----
  function router() {
    const hash = location.hash || '#dashboard';
    const [page, qs] = hash.split('?');
    const params = new URLSearchParams(qs || '');

    // Update sidebar active link
    document.querySelectorAll('.sidebar-link').forEach(a => {
      a.classList.toggle('active', a.getAttribute('href') === page || a.dataset.page === page.replace('#', ''));
    });

    const app = document.getElementById('app');

    switch (page) {
      case '#dashboard':       renderDashboard(app); break;
      case '#prospects':       renderProspects(app, params.get('status')); break;
      case '#prospect-detail': renderProspectDetail(app, params.get('id')); break;
      case '#campagnes':       renderCampagnes(app); break;
      case '#campaign-detail': renderCampaignDetail(app, params.get('id')); break;
      case '#imports':         renderImports(app); break;
      case '#logs':            renderLogs(app); break;
      case '#rappels':         renderRappels(app); break;
      case '#placeholders':    location.hash = '#campagnes'; break;
      default:                 renderDashboard(app);
    }

    updateBellBadge();
  }

  async function updateBellBadge() {
    const count = await DB.getPendingReminderCount();
    const badge = document.getElementById('bellBadge');
    if (count > 0) {
      badge.textContent = count;
      badge.style.display = 'flex';
    } else {
      badge.style.display = 'none';
    }
  }

  // ============================================================
  // DASHBOARD
  // ============================================================
  // Dashboard period helpers
  function _dashPeriod(preset) {
    const now = new Date();
    const y = now.getFullYear(), m = now.getMonth(), d = now.getDate();
    const pad = n => String(n).padStart(2, '0');
    const fmt = dt => `${dt.getFullYear()}-${pad(dt.getMonth()+1)}-${pad(dt.getDate())}`;
    switch (preset) {
      case 'week': {
        const mon = new Date(y, m, d - (now.getDay() || 7) + 1);
        return { from: fmt(mon), to: fmt(now), label: 'Semaine en cours' };
      }
      case 'month': {
        return { from: `${y}-${pad(m+1)}-01`, to: fmt(now), label: 'Mois en cours' };
      }
      case 'quarter': {
        const qStart = new Date(y, Math.floor(m / 3) * 3, 1);
        return { from: fmt(qStart), to: fmt(now), label: 'Trimestre en cours' };
      }
      case 'year': {
        return { from: `${y}-01-01`, to: fmt(now), label: 'Année en cours' };
      }
      default: return { from: `${y}-${pad(m+1)}-01`, to: fmt(now), label: 'Mois en cours' };
    }
  }

  let _currentDashPeriod = 'month';

  async function _refreshDashboardStats() {
    const { from, to } = _dashPeriod(_currentDashPeriod);
    try {
      const stats = await APIClient.get(`/api/prospector/dashboard-stats?from=${from}&to=${to}`).then(r => r.json());
      document.getElementById('statTotal').textContent = stats.total_prospects;
      document.getElementById('statEnrolled').textContent = stats.prospects_enrolled;
      document.getElementById('statAccepted').textContent = stats.invitations_accepted;
      document.getElementById('statCampaigns').textContent = stats.active_campaigns;
    } catch (e) {
      console.error('dashboard-stats error:', e);
    }
  }

  async function renderDashboard(container) {
    const period = _dashPeriod(_currentDashPeriod);
    container.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px">
        <h1 class="page-title" style="margin:0">Dashboard</h1>
        <select id="dashPeriodSelect" onchange="App._changeDashPeriod(this.value)" style="padding:6px 12px;border-radius:8px;border:1px solid var(--color-border, #e2e8f0);font-size:13px;background:white">
          <option value="week"${_currentDashPeriod==='week'?' selected':''}>Semaine en cours</option>
          <option value="month"${_currentDashPeriod==='month'?' selected':''}>Mois en cours</option>
          <option value="quarter"${_currentDashPeriod==='quarter'?' selected':''}>Trimestre en cours</option>
          <option value="year"${_currentDashPeriod==='year'?' selected':''}>Année en cours</option>
        </select>
      </div>
      <div class="stat-grid">
        <div class="stat-card stat-has-tooltip">
          <div class="sfc-icon-wrap" style="background:#DBEAFE;color:#2563EB">
            <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="5.5" cy="4.5" r="2.5"/><path d="M1 13c0-2.5 2-4.5 4.5-4.5"/><circle cx="11.5" cy="5.5" r="2"/><path d="M15 13c0-2 1.5-3.5-3.5-3.5H10"/></svg>
          </div>
          <div><div class="stat-value" id="statTotal">—</div><div class="stat-label">Total prospects</div></div>
          <div class="stat-tooltip">Hors profils non pertinents, restreints et en attente de scraping</div>
        </div>
        <div class="stat-card stat-has-tooltip">
          <div class="sfc-icon-wrap" style="background:#FCE7F3;color:#BE185D">
            <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="5.5" cy="4.5" r="2.5"/><path d="M1 13c0-2.5 2-4.5 4.5-4.5"/><circle cx="11.5" cy="5.5" r="2"/><path d="M15 13c0-2-1.5-3.5-3.5-3.5H10"/></svg>
          </div>
          <div><div class="stat-value" id="statEnrolled">—</div><div class="stat-label">Prospects enrollés</div></div>
          <div class="stat-tooltip">Prospects inscrits dans une séquence de prospection (invitation + messages) sur la période sélectionnée</div>
        </div>
        <div class="stat-card">
          <div class="sfc-icon-wrap" style="background:#D1FAE5;color:#065F46">
            <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6"/><path d="M5.5 8l2 2L11 6"/></svg>
          </div>
          <div><div class="stat-value" id="statAccepted">—</div><div class="stat-label">Invitations acceptées</div></div>
        </div>
        <div class="stat-card">
          <div class="sfc-icon-wrap" style="background:#FFEDD5;color:#EA580C">
            <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 13.5l11-5.5-11-5.5v4l7.5 1.5-7.5 1.5z"/></svg>
          </div>
          <div><div class="stat-value" id="statCampaigns">—</div><div class="stat-label">Campagnes actives</div></div>
        </div>
      </div>
      <div class="card mb-4" id="quotasCard" style="display:none">
        <div class="card-title">📊 Quotas du jour</div>
        <div class="quotas-grid">
          <div class="quota-item">
            <div class="quota-header"><span>Invitations LinkedIn</span><span id="quotaInvText">— / —</span></div>
            <div class="quota-bar"><div class="quota-fill" id="quotaInvBar" style="width:0%"></div></div>
          </div>
          <div class="quota-item">
            <div class="quota-header"><span>Messages LinkedIn</span><span id="quotaMsgText">— / —</span></div>
            <div class="quota-bar"><div class="quota-fill" id="quotaMsgBar" style="width:0%"></div></div>
          </div>
        </div>
      </div>
      <div class="dash-cols">
        <div class="card"><div class="card-title">Activité quotidienne — 30 jours</div><div class="pipeline-chart-wrap"><canvas id="pipelineChart"></canvas></div><div id="pipelineLegend" class="pipeline-legend"></div></div>
        <div class="card"><div class="card-title">Pipeline</div><ul class="pipeline-list" id="dashPipeline">${UI.loader()}</ul></div>
      </div>
      <div class="card actions-bar"><div class="card-title">📋 Actions à faire</div><div id="dashActions">${UI.loader()}</div></div>
      <div class="card activity-section"><div class="card-title">Activité récente</div><div id="dashActivity">${UI.loader()}</div></div>
    `;

    // Load stats in parallel
    const [reminders, pipeline, activity, pendingMessages, profilsAValider, profilsIncomplets, chartData] = await Promise.all([
      DB.getReminders({ status: 'pending' }),
      DB.getProspectCountsByStatus(),
      DB.getRecentInteractions(10),
      DB.getProspects({ status: 'Message à valider' }),
      DB.getProspects({ status: 'Profil à valider' }),
      APIClient.get('/api/prospector/prospects/incomplete?limit=100').then(r => r.json()).catch(() => []),
      APIClient.get('/api/prospector/daily-activity').then(r => r.json()).catch(() => ({ dates: [], series: {} })),
    ]);

    // Load dashboard stat cards (with period filter)
    _refreshDashboardStats();

    // Load quotas
    APIClient.get('/api/prospector/daily-stats').then(r => r.json()).then(stats => {
      const card = document.getElementById('quotasCard');
      if (!card || !stats.quotas) return;
      card.style.display = '';
      const inv = stats.quotas.invitations;
      const msg = stats.quotas.messages;
      document.getElementById('quotaInvText').textContent = `${inv.sent_today} / ${inv.limit}`;
      document.getElementById('quotaMsgText').textContent = `${msg.sent_today} / ${msg.limit}`;
      const invPct = Math.min(100, (inv.sent_today / inv.limit) * 100);
      const msgPct = Math.min(100, (msg.sent_today / msg.limit) * 100);
      const invBar = document.getElementById('quotaInvBar');
      const msgBar = document.getElementById('quotaMsgBar');
      invBar.style.width = invPct + '%';
      msgBar.style.width = msgPct + '%';
      invBar.className = 'quota-fill' + (invPct >= 100 ? ' quota-red' : invPct >= 75 ? ' quota-orange' : '');
      msgBar.className = 'quota-fill' + (msgPct >= 100 ? ' quota-red' : msgPct >= 75 ? ' quota-orange' : '');
    }).catch(() => {});

    // Actions à faire (rappels + messages à valider)
    const todayStr = UI.todayStr();
    const dueReminders = reminders.filter(r => r.due_date <= todayStr);

    const actionItems = [];

    // Profils à valider
    if (profilsAValider.length > 0) {
      actionItems.push(`<li class="action-item action-highlight">
        <span class="name"><a class="inline-link" href="#prospects?status=${encodeURIComponent('Profil à valider')}"><strong>${profilsAValider.length} profil(s) à valider</strong></a></span>
        ${UI.statusBadge('Profil à valider')}
        <div class="action-btns">
          <button class="btn btn-sm btn-primary" onclick="location.hash='#prospects?status=${encodeURIComponent('Profil à valider')}'">Voir</button>
        </div>
      </li>`);
    }

    // Profils incomplets à enrichir
    if (profilsIncomplets.length > 0) {
      actionItems.push(`<li class="action-item">
        <span class="name"><a class="inline-link" href="#prospects?status=${encodeURIComponent('Profil incomplet')}"><strong>${profilsIncomplets.length} profil(s) à compléter</strong></a></span>
        ${UI.statusBadge('Profil incomplet')}
        <div class="action-btns">
          <button class="btn btn-sm btn-primary" onclick="location.hash='#prospects?status=${encodeURIComponent('Profil incomplet')}'">Voir</button>
        </div>
      </li>`);
    }

    // Messages à valider
    for (const p of pendingMessages) {
      actionItems.push(`<li class="action-item">
        <span class="name"><a class="inline-link" href="#prospect-detail?id=${p.id}">${UI.esc(p.first_name)} ${UI.esc(p.last_name)}</a></span>
        ${UI.statusBadge('Message à valider')}
        <span class="note">${UI.esc(p.company || '')}</span>
        <div class="action-btns">
          <button class="btn btn-sm btn-primary" onclick="location.hash='#prospect-detail?id=${p.id}'">Voir</button>
        </div>
      </li>`);
    }

    // Rappels
    for (const r of dueReminders) {
      const name = r.prospects ? `${r.prospects.first_name} ${r.prospects.last_name}` : '—';
      const overdue = UI.isOverdue(r.due_date);
      const today = UI.isToday(r.due_date);
      actionItems.push(`<li class="action-item">
        <span class="name"><a class="inline-link" href="#prospect-detail?id=${r.prospect_id}">${UI.esc(name)}</a></span>
        ${r.type ? UI.typeBadge(r.type) : ''}
        <span class="note">${UI.esc(r.note || '')}</span>
        <span class="date ${overdue ? 'overdue' : ''} ${today ? 'today' : ''}">${UI.formatDate(r.due_date)}</span>
        <div class="action-btns">
          <button class="btn btn-sm btn-primary" onclick="App.reminderDone('${r.id}')">Fait</button>
          <button class="btn btn-sm btn-outline" onclick="App.reminderSnooze('${r.id}')">+3j</button>
        </div>
      </li>`);
    }

    if (actionItems.length === 0) {
      document.getElementById('dashActions').innerHTML = UI.emptyState('Aucune action en attente');
    } else {
      document.getElementById('dashActions').innerHTML = `<ul class="action-list">${actionItems.join('')}</ul>`;
    }

    // Pipeline list
    const statuses = UI.STATUSES;
    document.getElementById('dashPipeline').innerHTML = statuses.map(s => {
      const count = pipeline[s] || 0;
      const countCls = count > 0 ? 'pipeline-count' : 'pipeline-count pipeline-count-zero';
      return `<li class="pipeline-item" onclick="location.hash='#prospects?status=${encodeURIComponent(s)}'">${UI.statusBadge(s)} <span class="${countCls}">${count}</span></li>`;
    }).join('');

    // Daily activity chart
    const FR_MONTHS = ['jan', 'fév', 'mar', 'avr', 'mai', 'juin', 'juil', 'aoû', 'sep', 'oct', 'nov', 'déc'];
    const fmtDate = iso => { const d = new Date(iso + 'T00:00:00'); return `${d.getDate()} ${FR_MONTHS[d.getMonth()]}`; };

    const ACTIVITY_SERIES = {
      invitation_accepted: { label: 'Invitation acceptée',     color: '#10B981' },
      message_sent:        { label: 'Message envoyé',          color: '#0F766E' },
      response_received:   { label: 'Discussion en cours',     color: '#BE185D' },
      deal_won:            { label: 'Gagné',                   color: '#4D7C0F' },
    };

    const chartDates = chartData.dates || [];
    const chartSeries = chartData.series || {};
    const ctx = document.getElementById('pipelineChart');
    const legendEl = document.getElementById('pipelineLegend');

    if (ctx) {
      const seriesKeys = Object.keys(chartSeries);
      if (seriesKeys.length === 0) {
        ctx.parentElement.innerHTML = '<div class="empty-state" style="height:320px;display:flex;align-items:center;justify-content:center">Aucune activité sur les 30 derniers jours</div>';
      } else {
        if (window._pipelineChart) window._pipelineChart.destroy();

        const todayIso = new Date().toISOString().split('T')[0];
        const todayIdx = chartDates.indexOf(todayIso);

        const datasets = seriesKeys.map(key => {
          const meta = ACTIVITY_SERIES[key] || { label: key, color: '#6b7280' };
          return {
            label: meta.label,
            data: chartSeries[key],
            borderColor: meta.color,
            backgroundColor: meta.color + '18',
            borderWidth: 2,
            pointRadius: 4,
            pointHoverRadius: 6,
            pointHitRadius: 12,
            tension: 0.35,
            fill: false,
          };
        });

        const todayLinePlugin = {
          id: 'todayLine',
          afterDraw(chart) {
            if (todayIdx < 0) return;
            const { ctx: c, chartArea, scales } = chart;
            const x = scales.x.getPixelForValue(todayIdx);
            c.save();
            c.beginPath();
            c.moveTo(x, chartArea.top);
            c.lineTo(x, chartArea.bottom);
            c.strokeStyle = '#94A3B8';
            c.lineWidth = 1.5;
            c.setLineDash([4, 4]);
            c.stroke();
            c.fillStyle = '#64748B';
            c.font = '10px sans-serif';
            c.textAlign = 'center';
            c.fillText("Aujourd'hui", x, chartArea.top - 4);
            c.restore();
          },
        };

        window._pipelineChart = new Chart(ctx, {
          type: 'line',
          data: { labels: chartDates.map(fmtDate), datasets },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'nearest', intersect: false },
            plugins: {
              legend: { display: false },
              tooltip: {
                callbacks: {
                  title: () => '',
                  label: item => `${item.dataset.label} — ${item.raw} — ${fmtDate(chartDates[item.dataIndex])}`,
                },
              },
            },
            scales: {
              x: {
                grid: { display: false },
                ticks: { color: '#9ca3af', font: { size: 12 }, maxTicksLimit: 6 },
              },
              y: {
                beginAtZero: true,
                grid: { color: '#f3f4f6', drawBorder: false },
                ticks: { color: '#9ca3af', font: { size: 12 }, precision: 0 },
              },
            },
          },
          plugins: [todayLinePlugin],
        });

        // Custom pill legend (all possible types, not just active)
        if (legendEl) {
          legendEl.innerHTML = Object.entries(ACTIVITY_SERIES)
            .filter(([key]) => chartSeries[key])
            .map(([, meta]) =>
              `<span class="pipeline-legend-pill" style="background:${meta.color}22;color:${meta.color}">${UI.esc(meta.label)}</span>`
            ).join('');
        }
      }
    }

    // Activity
    if (activity.length === 0) {
      document.getElementById('dashActivity').innerHTML = UI.emptyState('Aucune activité récente');
    } else {
      document.getElementById('dashActivity').innerHTML = `
        <div class="table-wrap"><table><thead><tr><th>Date</th><th>Type</th><th>Prospect</th><th>Description</th></tr></thead><tbody>
        ${activity.map(a => {
          const pName = a.prospects ? `${a.prospects.first_name} ${a.prospects.last_name}` : '—';
          return `<tr>
            <td class="text-muted text-sm">${UI.formatDate(a.date)}</td>
            <td>${UI.typeBadge(a.type)}</td>
            <td><a class="inline-link" href="#prospect-detail?id=${a.prospect_id}">${UI.esc(pName)}</a></td>
            <td class="text-muted text-sm">${UI.esc(a.content || '')}</td>
          </tr>`;
        }).join('')}
        </tbody></table></div>`;
    }
  }

  // ============================================================
  // PROSPECTS LIST
  // ============================================================
  let _prospectFilters = {};

  let _selectedProspects = new Set();

  async function renderProspects(container, presetStatus) {
    _selectedProspects.clear();
    container.innerHTML = `
      <div class="page-header">
        <h1 class="page-title" style="margin-bottom:0">Prospects</h1>
        <div class="flex gap-2">
          <button class="btn btn-outline" onclick="location.hash='#imports'" style="display:flex;align-items:center;gap:6px">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M8 2v8M4 6l4-4 4 4"/><path d="M2 11v2a1 1 0 001 1h10a1 1 0 001-1v-2"/></svg>
            Importer
          </button>
          <button class="btn btn-primary" onclick="App.openAddProspect()" style="display:flex;align-items:center;gap:6px">+ Ajouter</button>
        </div>
      </div>
      <div class="quick-filters" id="quickFilters">
        <button class="qf-btn qf-active" data-filter="" onclick="App.quickFilter(this, '')">Tous <span class="qf-count" id="qfCount-all"></span></button>
        ${UI.STATUSES.map(s => {
          const LABELS = {
            'Profil incomplet':    'À compléter',
            'Profil à valider':    'À valider',
            'Nouveau':             'New',
            'Invitation envoyée':  'Envoyée',
            'Message à valider':   'Msg à valider',
            'Message à envoyer':   'Msg à envoyer',
            'Message envoyé':      'Msg envoyé',
            'Discussion en cours': 'En cours',
          };
          const label = LABELS[s] || s;
          return `<button class="qf-btn" data-filter="${s}" onclick="App.quickFilter(this, '${s}')">${label} <span class="qf-count" id="qfCount-${s.replace(/\s/g, '_')}"></span></button>`;
        }).join('')}
      </div>
      <div class="filter-bar">
        <div class="search-wrap">
          <svg class="search-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2"><circle cx="8.5" cy="8.5" r="5.5"/><line x1="13.5" y1="13.5" x2="18" y2="18"/></svg>
          <input id="filterSearch" placeholder="Rechercher nom, entreprise, fonction..." oninput="App.filterProspects()">
        </div>
        <select id="filterStatus" onchange="App.filterProspects()" style="display:none"><option value="">Tous les statuts</option></select>
        <select id="filterCampaign" onchange="App.filterProspects()"><option value="">Toutes les campagnes</option><option value="none">Non défini</option></select>
      </div>
      <div class="bulk-actions" id="bulkActions" style="display:none">
        <span id="bulkCount">0 sélectionné(s)</span>
        <button class="btn btn-sm" style="background:#16A34A;color:#fff" onclick="App.bulkValidate()">Valider</button>
        <button class="btn btn-sm btn-danger" onclick="App.bulkReject()">Non pertinent</button>
        <button class="btn btn-sm btn-ghost" onclick="App.clearSelection()">Désélectionner</button>
      </div>
      <div class="card"><div class="table-wrap" id="prospectsTable">${UI.loader()}</div></div>
    `;

    // Populate filter dropdowns
    const [campaigns] = await Promise.all([DB.getCampaigns()]);
    const statuses = UI.STATUSES;
    const statusSel = document.getElementById('filterStatus');
    statuses.forEach(s => { const o = document.createElement('option'); o.value = s; o.textContent = s; statusSel.appendChild(o); });
    const campSel = document.getElementById('filterCampaign');
    campaigns.forEach(c => { const o = document.createElement('option'); o.value = c.id; o.textContent = c.name; campSel.appendChild(o); });

    // Pre-select status filter if coming from pipeline click
    if (presetStatus) {
      // Add hidden status to dropdown if not already present (e.g. navigating from dashboard alert)
      if (!statusSel.querySelector(`option[value="${presetStatus}"]`)) {
        const o = document.createElement('option'); o.value = presetStatus; o.textContent = presetStatus; statusSel.appendChild(o);
      }
      statusSel.value = presetStatus;
      // Highlight the matching quick filter
      document.querySelectorAll('.qf-btn').forEach(b => { b.classList.remove('qf-active'); b.style.background = ''; b.style.color = ''; b.style.borderColor = ''; });
      const match = document.querySelector(`.qf-btn[data-filter="${presetStatus}"]`);
      if (match) { match.classList.add('qf-active'); _applyQfActiveStyle(match, presetStatus); }
    }

    // Load counts for all quick filters
    loadQuickFilterCounts();

    filterProspects();
  }

  function _applyQfActiveStyle(btn, status) {
    btn.style.background = '';
    btn.style.color = '';
    btn.style.borderColor = '';
    const countEl = btn.querySelector('.qf-count');
    if (countEl) { countEl.style.background = ''; countEl.style.color = ''; }
    if (status && UI.STATUS_COLORS[status]) {
      const sc = UI.STATUS_COLORS[status];
      btn.style.background = sc.bg;
      btn.style.color = sc.color;
      btn.style.borderColor = sc.color;
      if (countEl) { countEl.style.background = 'rgba(255,255,255,0.65)'; countEl.style.color = sc.color; }
    }
  }

  function quickFilter(btn, status) {
    document.querySelectorAll('.qf-btn').forEach(b => {
      b.classList.remove('qf-active');
      b.style.background = '';
      b.style.color = '';
      b.style.borderColor = '';
    });
    btn.classList.add('qf-active');
    _applyQfActiveStyle(btn, status);
    const statusSel = document.getElementById('filterStatus');
    if (statusSel) {
      if (status && !statusSel.querySelector(`option[value="${status}"]`)) {
        const o = document.createElement('option'); o.value = status; o.textContent = status; statusSel.appendChild(o);
      }
      statusSel.value = status;
    }
    clearSelection();
    filterProspects();
  }

  async function loadQuickFilterCounts() {
    const counts = await DB.getProspectCountsByStatus();
    let total = 0;
    for (const s of UI.STATUSES) {
      const count = counts[s] || 0;
      total += count;
      const el = document.getElementById(`qfCount-${s.replace(/\s/g, '_')}`);
      if (el) {
        el.textContent = count > 0 ? count : '';
        const sc = UI.STATUS_COLORS[s];
        if (sc) {
          const btn = el.closest('.qf-btn');
          const isActive = btn?.classList.contains('qf-active');
          if (isActive) {
            el.style.background = 'rgba(255,255,255,0.65)';
            el.style.color = sc.color;
          } else {
            el.style.background = sc.color;
            el.style.color = '#fff';
          }
        }
      }
    }
    const hiddenCount = Object.entries(counts).filter(([k]) => !UI.STATUSES.includes(k) && k !== '').reduce((a, [, v]) => a + v, 0);
    total += hiddenCount;
    const allEl = document.getElementById('qfCount-all');
    if (allEl) {
      allEl.textContent = total > 0 ? total : '';
      allEl.style.background = 'var(--color-primary)';
      allEl.style.color = '#fff';
    }
  }

  function toggleSelect(id, checked) {
    if (checked) _selectedProspects.add(id);
    else _selectedProspects.delete(id);
    updateBulkBar();
  }

  function toggleSelectAll(checked) {
    document.querySelectorAll('.prospect-cb').forEach(cb => {
      cb.checked = checked;
      if (checked) _selectedProspects.add(cb.dataset.id);
      else _selectedProspects.delete(cb.dataset.id);
    });
    updateBulkBar();
  }

  function clearSelection() {
    _selectedProspects.clear();
    document.querySelectorAll('.prospect-cb').forEach(cb => cb.checked = false);
    const sa = document.getElementById('selectAll');
    if (sa) sa.checked = false;
    updateBulkBar();
  }

  function updateBulkBar() {
    const bar = document.getElementById('bulkActions');
    const count = _selectedProspects.size;
    if (!bar) return;
    // Only show bulk actions in "Profil à valider" view
    const statusSel = document.getElementById('filterStatus');
    const isAValider = statusSel && statusSel.value === 'Profil à valider';
    bar.style.display = count > 0 && isAValider ? 'flex' : 'none';
    const el = document.getElementById('bulkCount');
    if (el) el.textContent = `${count} sélectionné(s)`;
  }

  // --- Bulk operations with confirmation modal + undo ---

  let _lastBulkOp = null; // { bulk_operation_id, count, status, timer }

  async function bulkValidate() {
    if (_selectedProspects.size === 0) return;
    // Validate = Nouveau, not a terminal status → quick confirm for >= 2
    const ids = [..._selectedProspects];
    if (ids.length >= 2) {
      showBulkConfirmModal(ids, 'Nouveau', async () => {
        await executeBulk(ids, 'Nouveau');
      });
    } else {
      await executeBulk(ids, 'Nouveau');
    }
  }

  async function bulkReject() {
    if (_selectedProspects.size === 0) return;
    const ids = [..._selectedProspects];
    // Non pertinent = terminal → always confirm for >= 2
    showBulkConfirmModal(ids, 'Non pertinent', async () => {
      await executeBulk(ids, 'Non pertinent');
    });
  }

  async function executeBulk(ids, status) {
    const resp = await APIClient.post('/api/prospector/bulk-update-status', { ids, status });
    const result = await resp.json();
    _selectedProspects.clear();
    filterProspects();
    loadQuickFilterCounts();

    // Show undo toast if we got a bulk_operation_id
    if (result.bulk_operation_id) {
      showUndoToast(result.bulk_operation_id, ids.length, status);
    } else {
      UI.toast(`${ids.length} prospect(s) mis à jour`);
    }
  }

  function showBulkConfirmModal(ids, status, onConfirm) {
    // Remove existing modal if any
    document.getElementById('bulkConfirmModal')?.remove();

    const isTerminal = ['Non pertinent', 'Perdu'].includes(status);
    const needsTyping = ids.length >= 10;

    // Get prospect names for display
    const rows = [];
    document.querySelectorAll('.prospect-cb').forEach(cb => {
      if (ids.includes(cb.dataset.id)) {
        const tr = cb.closest('tr');
        if (tr) {
          const name = tr.querySelector('td:nth-child(2)')?.textContent?.trim() || '—';
          const company = tr.querySelector('td:nth-child(4)')?.textContent?.trim() || '';
          rows.push({ name, company });
        }
      }
    });

    const previewCount = Math.min(rows.length, 5);
    const previewHtml = rows.slice(0, previewCount).map(r =>
      `<li>${UI.esc(r.name)}${r.company ? ' — ' + UI.esc(r.company) : ''}</li>`
    ).join('');
    const moreHtml = rows.length > previewCount ? `<li class="text-muted">… et ${rows.length - previewCount} autre(s)</li>` : '';

    const modal = document.createElement('div');
    modal.id = 'bulkConfirmModal';
    modal.className = 'modal-overlay';
    modal.innerHTML = `
      <div class="modal-box" style="max-width:480px">
        <h3 style="margin:0 0 12px">⚠️ Modification en masse</h3>
        <p>Vous allez changer le statut de <strong>${ids.length} prospect(s)</strong> vers <strong>"${UI.esc(status)}"</strong>.</p>
        ${isTerminal ? '<div class="bulk-warn">Attention : statut terminal — ces prospects sortiront du pipeline actif.</div>' : ''}
        <ul class="bulk-preview">${previewHtml}${moreHtml}</ul>
        ${needsTyping ? '<p class="text-sm">Pour confirmer, tapez <strong>CONFIRMER</strong> :</p><input id="bulkConfirmInput" class="input" placeholder="CONFIRMER" autocomplete="off">' : ''}
        <div class="modal-actions">
          <button class="btn btn-outline" onclick="document.getElementById('bulkConfirmModal').remove()">Annuler</button>
          <button class="btn ${isTerminal ? 'btn-danger' : 'btn-primary'}" id="bulkConfirmBtn" ${needsTyping ? 'disabled' : ''}>Confirmer</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    // Close on overlay click
    modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });

    // Typing guard
    if (needsTyping) {
      const inp = document.getElementById('bulkConfirmInput');
      const btn = document.getElementById('bulkConfirmBtn');
      inp.addEventListener('input', () => { btn.disabled = inp.value.trim() !== 'CONFIRMER'; });
    }

    // Confirm button
    document.getElementById('bulkConfirmBtn').addEventListener('click', () => {
      modal.remove();
      onConfirm();
    });
  }

  function showUndoToast(bulkOpId, count, status) {
    // Remove existing undo toast
    document.getElementById('undoToast')?.remove();
    if (_lastBulkOp?.timer) clearInterval(_lastBulkOp.timer);

    let secondsLeft = 7;
    const toast = document.createElement('div');
    toast.id = 'undoToast';
    toast.className = 'undo-toast';
    toast.innerHTML = `
      <span>✅ ${count} prospect(s) → "${UI.esc(status)}"</span>
      <button class="btn btn-sm btn-outline" id="undoBtn">Annuler (<span id="undoCountdown">${secondsLeft}</span>s)</button>
    `;
    document.body.appendChild(toast);

    const countdownEl = document.getElementById('undoCountdown');
    const timer = setInterval(() => {
      secondsLeft--;
      if (countdownEl) countdownEl.textContent = secondsLeft;
      if (secondsLeft <= 0) {
        clearInterval(timer);
        toast.remove();
        _lastBulkOp = null;
      }
    }, 1000);

    _lastBulkOp = { bulk_operation_id: bulkOpId, count, status, timer };

    document.getElementById('undoBtn').addEventListener('click', async () => {
      clearInterval(timer);
      toast.innerHTML = '<span>⏳ Annulation en cours…</span>';
      try {
        const resp = await APIClient.post('/api/prospector/undo-bulk', { bulk_operation_id: bulkOpId });
        const result = await resp.json();
        if (result.success) {
          toast.innerHTML = `<span>✅ Annulé — ${result.restored} prospect(s) restauré(s)</span>`;
          filterProspects();
          loadQuickFilterCounts();
        } else {
          toast.innerHTML = `<span>❌ Erreur : ${UI.esc(result.error || 'Échec')}</span>`;
        }
      } catch (e) {
        toast.innerHTML = `<span>❌ Erreur réseau</span>`;
      }
      setTimeout(() => toast.remove(), 4000);
      _lastBulkOp = null;
    });
  }

  async function quickValidate(id) {
    await APIClient.post('/api/prospector/bulk-update-status', { ids: [id], status: 'Nouveau' });
    UI.toast('Profil validé');
    filterProspects();
  }

  async function quickReject(id) {
    await APIClient.post('/api/prospector/bulk-update-status', { ids: [id], status: 'Non pertinent' });
    UI.toast('Profil marqué non pertinent');
    filterProspects();
  }

  function _seqBadgeHtml(s) {
    if (!s) return '<span class="badge badge-non-pertinent">Non enrôlé</span>';
    if (s.status === 'active') return `<span class="badge badge-envoye">Active — Étape ${s.current_step_order}</span>`;
    if (s.status === 'completed') return '<span class="badge badge-gagne">Terminée ✅</span>';
    if (s.status === 'stopped_reply') return '<span class="badge badge-perdu">Arrêtée ⛔</span>';
    if (s.status === 'paused') return '<span class="badge badge-a-valider">En pause</span>';
    return '<span class="badge badge-non-pertinent">Non enrôlé</span>';
  }

  async function filterProspects() {
    const search = document.getElementById('filterSearch')?.value || '';
    const status = document.getElementById('filterStatus')?.value || '';
    const campaignFilter = document.getElementById('filterCampaign')?.value || '';

    const opts = { search, status };
    if (campaignFilter === 'none') opts.no_campaign = true;
    else if (campaignFilter) opts.campaign_id = campaignFilter;

    const prospects = await DB.getProspects(opts);
    const hasValidatable = prospects.some(p => p.status === 'Profil à valider');
    const svgOpen = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2H3a1 1 0 00-1 1v10a1 1 0 001 1h10a1 1 0 001-1v-3"/><path d="M10 2h4v4"/><path d="M7 9L14 2"/></svg>`;
    const tbody = prospects.length === 0
      ? `<tr><td colspan="8">${UI.emptyState('Aucun prospect trouvé')}</td></tr>`
      : prospects.map(p => {
          const campName = p.campaign_name || 'Non défini';
          const isAValider = p.status === 'Profil à valider';
          const checked = _selectedProspects.has(p.id) ? 'checked' : '';
          const href = `#prospect-detail?id=${p.id}`;
          return `<tr class="clickable ${p.status === 'Non pertinent' ? 'row-muted' : ''} ${isAValider ? 'row-a-valider' : ''}">
          <td onclick="event.stopPropagation()"><input type="checkbox" class="prospect-cb" data-id="${p.id}" ${checked} onchange="App.toggleSelect('${p.id}', this.checked)"></td>
          <td><a href="${href}" class="row-link"><strong>${UI.esc(p.first_name)} ${UI.esc(p.last_name)}</strong></a></td>
          <td class="text-sm text-muted"><a href="${href}" class="row-link">${UI.esc(p.job_title || '')}</a></td>
          <td><a href="${href}" class="row-link"><strong>${UI.esc(p.company || '')}</strong></a></td>
          <td class="text-sm text-muted"><a href="${href}" class="row-link">${UI.esc(campName)}</a></td>
          <td><a href="${href}" class="row-link">${UI.statusBadge(p.status)}</a></td>
          <td class="text-muted text-sm"><a href="${href}" class="row-link">${UI.formatDate(p.updated_at)}</a></td>
          <td class="action-btns" onclick="event.stopPropagation()">
            ${isAValider ? `<button class="btn-icon btn-validate" onclick="App.quickValidate('${p.id}')" title="Valider">✓</button><button class="btn-icon btn-reject" onclick="App.quickReject('${p.id}')" title="Non pertinent">✕</button>` : ''}
            <a href="${href}" class="row-link-icon" title="Voir la fiche">${svgOpen}</a>
          </td>
        </tr>`;
        }).join('');

    document.getElementById('prospectsTable').innerHTML = `
      <table><thead><tr>
        <th style="width:30px"><input type="checkbox" id="selectAll" onchange="App.toggleSelectAll(this.checked)"></th>
        <th>Nom</th><th>Fonction</th><th>Entreprise</th><th>Campagne</th><th>Statut</th><th>Dernier contact</th><th></th>
      </tr></thead>
      <tbody>${tbody}</tbody></table>`;

    updateBulkBar();
    loadQuickFilterCounts();
  }

  async function openAddProspect() {
    document.getElementById('formAddProspect').reset();
    document.getElementById('dupeWarningAdd').style.display = 'none';
    const campaigns = await DB.getCampaigns();
    document.getElementById('selectCampaignAdd').innerHTML = UI.options(campaigns.map(c => c.id), '', 'Aucune');
    // Replace option text
    const sel = document.getElementById('selectCampaignAdd');
    for (const c of campaigns) {
      const opt = sel.querySelector(`option[value="${c.id}"]`);
      if (opt) opt.textContent = c.name;
    }
    UI.openModal('modalAddProspect');
  }

  async function handleAddProspect(e) {
    e.preventDefault();
    const fd = new FormData(e.target);
    const data = Object.fromEntries(fd);
    if (!data.source_campaign_id) delete data.source_campaign_id;

    // Check duplicates
    const dupes = await DB.checkDuplicates(data);
    if (dupes.length > 0) {
      const warn = document.getElementById('dupeWarningAdd');
      warn.innerHTML = `⚠️ Doublon potentiel détecté — ${dupes.map(d => `<a class="inline-link" href="#prospect-detail?id=${d.id}">${UI.esc(d.first_name)} ${UI.esc(d.last_name)}</a>`).join(', ')}`;
      warn.style.display = 'flex';
      // Allow to submit anyway on second click
      if (warn.dataset.confirmed === 'true') {
        warn.dataset.confirmed = '';
      } else {
        warn.dataset.confirmed = 'true';
        return false;
      }
    }

    await DB.createProspect(data);
    UI.closeModal('modalAddProspect');
    UI.toast('Prospect ajouté');
    filterProspects();
    return false;
  }

  // ============================================================
  // PROSPECT DETAIL
  // ============================================================
  async function renderProspectDetail(container, id) {
    if (!id) { location.hash = '#prospects'; return; }
    container.innerHTML = UI.loader();

    const [prospect, interactions, reminders, campaigns] = await Promise.all([
      DB.getProspect(id),
      DB.getInteractions(id),
      DB.getProspectReminders(id),
      DB.getCampaigns(),
    ]);

    // Enrich prospect with campaign info (from prospects table)
    const allProspects = await DB.getProspects();
    const paData = allProspects.find(p => p.id === id);
    if (paData) {
      prospect.campaign_id = paData.campaign_id;
      prospect.campaign_name = paData.campaign_name;
      prospect.status = paData.status;
    }

    // Fetch sequence preview if prospect has a campaign
    const seqResp = prospect.campaign_id
      ? await APIClient.get(`/api/sequences/preview?campaign_id=${prospect.campaign_id}&prospect_id=${id}`).catch(() => null)
      : null;

    // Check duplicates
    const dupes = await DB.checkDuplicates(prospect, id);

    const campName = prospect.campaign_name || '—';

    container.innerHTML = `
      <a class="inline-link camp-back" href="javascript:history.back()">← Retour</a>

      ${dupes.length > 0 ? `<div class="duplicate-banner">⚠️ Doublon potentiel détecté — ${dupes.map(d =>
        `<a class="inline-link" href="#prospect-detail?id=${d.id}">${UI.esc(d.first_name)} ${UI.esc(d.last_name)}</a>`).join(', ')}</div>` : ''}

      <div class="profile-card">
        <div class="profile-header">
          <div>
            <div class="profile-name">${UI.esc(prospect.first_name)} ${UI.esc(prospect.last_name)}</div>
            <div class="profile-subtitle">${UI.esc(prospect.job_title || '')}${prospect.job_title && prospect.company ? ' — ' : ''}${UI.esc(prospect.company || '')}</div>
            <div class="profile-badges mt-4">
              ${prospect.sector ? `<span class="badge badge-type">${UI.esc(prospect.sector)}</span>` : ''}
              ${prospect.geography ? `<span class="badge badge-type">${UI.esc(prospect.geography)}</span>` : ''}
              ${campName !== '—' ? `<span class="badge badge-type">${UI.esc(campName)}</span>` : ''}
              ${seqResp?.activity ? (() => {
                const a = seqResp.activity;
                const cls = a.is_relevant ? 'badge-gagne' : 'badge-non-pertinent';
                const label = a.is_relevant ? '🌱 Contexte LinkedIn personnalisé' : 'Contexte LinkedIn générique';
                const tooltip = a.icebreaker_generated ? `title="${UI.esc(a.icebreaker_generated)}"` : '';
                return `<span class="badge ${cls}" ${tooltip} style="cursor:help">${label}</span>`;
              })() : ''}
            </div>
          </div>
          <div class="flex gap-2 items-center">
            <select class="status-select" id="statusSelect-${id}" data-original="${prospect.status}">
              ${UI.DROPDOWN_STATUSES.map(s =>
                `<option ${s === prospect.status ? 'selected' : ''}>${s}</option>`).join('')}
            </select>
            <button class="btn btn-primary btn-sm" id="btnSaveStatus-${id}" style="display:none" onclick="App.saveProspectStatus('${id}')">Enregistrer</button>
            <button class="btn btn-outline btn-sm" onclick="App.openEditProspect('${id}')">Modifier</button>
            <button class="btn btn-danger btn-sm" onclick="App.deleteProspect('${id}')">Supprimer</button>
          </div>
        </div>
        <div class="profile-fields">
          <div><div class="profile-field-label">Email</div><div class="profile-field-value">${prospect.email ? `<a href="mailto:${UI.esc(prospect.email)}">${UI.esc(prospect.email)}</a>` : '—'}</div></div>
          <div><div class="profile-field-label">Téléphone</div><div class="profile-field-value">${UI.esc(prospect.phone || '—')}</div></div>
          <div><div class="profile-field-label">LinkedIn</div><div class="profile-field-value">${prospect.linkedin_url ? `<a href="${UI.esc(prospect.linkedin_url)}" target="_blank">Voir le profil ↗</a>` : '—'}</div></div>
        </div>
      </div>

      ${prospect.campaign_id && seqResp?.steps?.length > 0 && !seqResp.sequence_state
        ? `<div class="card mt-6" style="padding:16px;display:flex;align-items:center;gap:12px">
            <button class="btn btn-primary" id="btnStartSeq" onclick="App.enrollProspect('${id}', '${prospect.campaign_id}')">▶ Démarrer la séquence</button>
            <span class="text-sm text-muted">${UI.esc(seqResp.sequence?.name || 'Séquence disponible')}</span>
          </div>`
        : prospect.campaign_id && !seqResp?.steps?.length
          ? `<div class="text-sm text-muted" style="padding:8px 0">Aucune séquence configurée pour cette campagne.</div>`
          : ''}

      ${prospect.status === 'Message à valider' && prospect.pending_message ? `
        <div class="message-card">
          <div class="message-card-title" style="justify-content:space-between">
            <span>✉️ Message LinkedIn à valider</span>
            <button class="btn btn-sm btn-outline" id="btnRegenConfirm" onclick="App.regenerateMessages('${id}')">Regénérer</button>
          </div>
          <textarea class="message-textarea" id="pendingMessage">${UI.esc(prospect.pending_message)}</textarea>
          <div class="message-actions">
            <button class="btn btn-primary" onclick="App.validateMessage('${id}')">✓ Valider et envoyer</button>
            <button class="btn btn-danger btn-sm" onclick="App.rejectMessage('${id}')">✕ Rejeter</button>
          </div>
        </div>` : ''}

      <div class="dash-cols" style="grid-template-columns:1fr 1fr">
        <!-- Interactions -->
        <div class="card">
          <div class="card-title flex justify-between">
            <span>Timeline</span>
            <button class="btn btn-sm btn-primary" onclick="App.openAddInteraction('${id}')">+ Interaction</button>
          </div>
          <ul class="timeline" id="prospectTimeline">
            ${interactions.length === 0 ? UI.emptyState('Aucune interaction') : interactions.map(i => `
              <li class="timeline-item">
                <span class="timeline-date">${UI.formatDate(i.date)}</span>
                ${UI.typeBadge(i.type)}
                <span class="timeline-content">${UI.esc(i.content || '')}</span>
              </li>
            `).join('')}
          </ul>
        </div>

        <!-- Rappels -->
        <div class="card">
          <div class="card-title flex justify-between">
            <span>Rappels</span>
            <button class="btn btn-sm btn-primary" onclick="App.openAddReminder('${id}')">+ Rappel</button>
          </div>
          <div id="prospectReminders">
            ${reminders.length === 0 ? UI.emptyState('Aucun rappel') : reminders.map(r => {
              const overdue = r.status === 'pending' && UI.isOverdue(r.due_date);
              const today = r.status === 'pending' && UI.isToday(r.due_date);
              return `<div class="reminder-row ${overdue ? 'overdue' : ''} ${today ? 'today' : ''} ${!overdue && !today ? 'upcoming' : ''}">
                <div class="reminder-info">
                  ${r.type ? UI.typeBadge(r.type) : ''} <span class="text-sm text-muted">${UI.esc(r.note || '')}</span>
                </div>
                <span class="reminder-date ${overdue ? 'overdue' : ''} ${today ? 'today' : ''}">${UI.formatDate(r.due_date)}</span>
                ${r.status === 'pending' ? `
                  <div class="action-btns">
                    <button class="btn btn-sm btn-primary" onclick="App.reminderDone('${r.id}')">✓</button>
                    <button class="btn btn-sm btn-outline" onclick="App.reminderSnooze('${r.id}')">+3j</button>
                  </div>
                ` : `<span class="badge ${r.status === 'done' ? 'badge-gagne' : 'badge-contacte'}">${r.status === 'done' ? 'Fait' : 'Snoozé'}</span>`}
              </div>`;
            }).join('')}
          </div>
        </div>
      </div>

      <!-- Notes -->
      <div class="card mt-6">
        <div class="card-title">Notes</div>
        <textarea class="notes-area" id="prospectNotes" oninput="App.debounceNotes('${id}')">${UI.esc(prospect.notes || '')}</textarea>
      </div>
    `;

    initStatusSelectListener(id);
  }

  let _notesTimer = null;
  function debounceNotes(id) {
    clearTimeout(_notesTimer);
    _notesTimer = setTimeout(async () => {
      const notes = document.getElementById('prospectNotes')?.value || '';
      await DB.updateProspect(id, { notes });
    }, 1000);
  }

  function toggleRegenForm() {
    const form = document.getElementById('regenForm');
    if (form) form.style.display = form.style.display === 'none' ? '' : 'none';
  }

  async function regenerateMessages(id) {
    const btn = document.getElementById('btnRegenConfirm');
    if (btn) { btn.disabled = true; btn.textContent = 'Regénération...'; }

    try {
      const resp = await APIClient.post('/api/prospector/regenerate-icebreaker', { id });
      const result = await resp.json();
      if (!resp.ok) { UI.toast(result.error || 'Erreur', 'error'); return; }

      if (result.needs_scraping) {
        UI.toast('Aucune donnée LinkedIn en cache. Le message sera généré au prochain passage Dispatch.', 'error');
        return;
      }

      if (result.resolved_message) {
        // Update the pending message textarea if visible
        const textarea = document.getElementById('pendingMessage');
        if (textarea) textarea.value = result.resolved_message;
      }

      const mode = result.is_relevant ? 'personnalisé' : 'générique';
      UI.toast('Message regénéré');

      // Refresh the page to show updated data
      renderProspectDetail(document.getElementById('app'), id);
    } catch (err) {
      UI.toast('Erreur: ' + err.message, 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Regénérer'; }
    }
  }

  async function changeProspectStatus(id, status) {
    await DB.updateProspect(id, { status });
    UI.toast('Statut mis à jour');
  }

  async function saveProspectStatus(id) {
    const sel = document.getElementById(`statusSelect-${id}`);
    if (!sel) return;
    const newStatus = sel.value;
    const resp = await APIClient.post('/api/prospector/bulk-update-status', { ids: [id], status: newStatus });
    if (resp.error) { UI.toast('Erreur : ' + resp.error, 'error'); return; }
    sel.dataset.original = newStatus;
    document.getElementById(`btnSaveStatus-${id}`).style.display = 'none';
    UI.toast(newStatus === 'Non pertinent' ? 'Prospect marqué non pertinent' : 'Statut mis à jour');
    renderProspectDetail(document.getElementById('app'), id);
  }

  function initStatusSelectListener(id) {
    const sel = document.getElementById(`statusSelect-${id}`);
    if (!sel) return;
    sel.addEventListener('change', () => {
      const btn = document.getElementById(`btnSaveStatus-${id}`);
      btn.style.display = sel.value !== sel.dataset.original ? '' : 'none';
    });
  }

  function selectMessageVersion(id, index) {
    const prospect = document.getElementById('selectedMessageWrap');
    if (!prospect) return;
    // Get version content from the displayed version blocks
    const versionEl = document.getElementById(`msgVersion${index}`);
    const content = versionEl?.querySelector('.message-version-content')?.textContent || '';
    // Show the editable textarea with selected content
    prospect.style.display = '';
    document.getElementById('pendingMessage').value = content;
    // Highlight selected version
    document.querySelectorAll('.message-version').forEach(el => el.classList.remove('version-selected'));
    versionEl?.classList.add('version-selected');
  }

  async function validateMessage(id) {
    const msg = (document.getElementById('pendingMessage')?.value || '').trim();
    if (!msg) {
      UI.toast('Le message est vide — sélectionne ou écris un message avant de valider', 'error');
      return;
    }
    const resp = await APIClient.post('/api/prospector/update-status', { id, status: 'Message à envoyer', pending_message: msg });
    if (resp.error) { UI.toast('Erreur : ' + resp.error, 'error'); return; }
    UI.toast('Message validé — Claude Dispatch l\'enverra au prochain passage');
    renderProspectDetail(document.getElementById('app'), id);
  }

  async function rejectMessage(id) {
    await DB.updateProspect(id, { status: 'Invitation acceptée', pending_message: null });
    UI.toast('Message rejeté');
    renderProspectDetail(document.getElementById('app'), id);
  }

  async function markNonPertinent(id) {
    await DB.updateProspect(id, { status: 'Non pertinent', source_campaign_id: null });
    UI.toast('Prospect marqué non pertinent et retiré de la campagne');
    // Refresh current view
    const hash = location.hash || '';
    if (hash.startsWith('#prospect-detail')) {
      renderProspectDetail(document.getElementById('app'), id);
    } else {
      filterProspects();
    }
  }

  async function openEditProspect(id) {
    const p = await DB.getProspect(id);
    const form = document.getElementById('formEditProspect');
    form.querySelector('[name="id"]').value = p.id;
    form.querySelector('[name="first_name"]').value = p.first_name;
    form.querySelector('[name="last_name"]').value = p.last_name;
    form.querySelector('[name="company"]').value = p.company || '';
    form.querySelector('[name="job_title"]').value = p.job_title || '';
    form.querySelector('[name="email"]').value = p.email || '';
    form.querySelector('[name="phone"]').value = p.phone || '';
    form.querySelector('[name="linkedin_url"]').value = p.linkedin_url || '';
    form.querySelector('[name="sector"]').value = p.sector || '';
    form.querySelector('[name="geography"]').value = p.geography || '';
    form.querySelector('[name="notes"]').value = p.notes || '';

    const campaigns = await DB.getCampaigns();
    const sel = document.getElementById('selectCampaignEdit');
    sel.innerHTML = UI.options(campaigns.map(c => c.id), p.source_campaign_id || '', 'Aucune');
    for (const c of campaigns) {
      const opt = sel.querySelector(`option[value="${c.id}"]`);
      if (opt) opt.textContent = c.name;
    }

    UI.openModal('modalEditProspect');
  }

  async function handleEditProspect(e) {
    e.preventDefault();
    const fd = new FormData(e.target);
    const data = Object.fromEntries(fd);
    const id = data.id;
    delete data.id;
    if (!data.source_campaign_id) delete data.source_campaign_id;
    await DB.updateProspect(id, data);
    UI.closeModal('modalEditProspect');
    UI.toast('Prospect mis à jour');
    renderProspectDetail(document.getElementById('app'), id);
    return false;
  }

  async function deleteProspect(id) {
    if (!confirm('Supprimer ce prospect ? Cette action est irréversible.')) return;
    await DB.deleteProspect(id);
    UI.toast('Prospect supprimé');
    location.hash = '#prospects';
  }

  async function enrollProspect(prospectId, campaignId) {
    const btn = document.getElementById('btnStartSeq');
    if (btn) { btn.disabled = true; btn.textContent = 'Enrôlement…'; }
    const resp = await APIClient.post('/api/sequences/enroll', { prospect_id: prospectId, campaign_id: campaignId });
    if (resp.enrolled) {
      UI.toast('Prospect enrôlé dans la séquence');
      renderProspectDetail(document.getElementById('app'), prospectId);
    } else {
      UI.toast(resp.reason === 'no_active_sequence' ? 'Aucune séquence active' : 'Déjà enrôlé', 'error');
      if (btn) { btn.disabled = false; btn.textContent = '▶ Démarrer la séquence'; }
    }
  }

  async function enrollCampaign(campaignId) {
    if (!confirm('Enrôler tous les prospects de cette campagne dans la séquence selon leur statut actuel ?')) return;
    try {
      const resp = await APIClient.post('/api/sequences/enroll-campaign', { campaign_id: campaignId });
      const data = await resp.json();
      if (!resp.ok) {
        UI.toast(data.error || 'Erreur', 'error');
        return;
      }
      const details = Object.entries(data.details || {}).map(([k, v]) => `${k}: ${v}`).join(', ');
      UI.toast(`${data.enrolled} prospect(s) enrôlé(s)${details ? ' (' + details + ')' : ''}. ${data.skipped_already} déjà enrôlé(s), ${data.skipped_excluded} exclus.`);
    } catch (err) {
      UI.toast('Erreur: ' + err.message, 'error');
    }
  }

  function openAddInteraction(prospectId) {
    document.getElementById('formAddInteraction').reset();
    document.getElementById('formAddInteraction').querySelector('[name="prospect_id"]').value = prospectId;
    document.getElementById('formAddInteraction').querySelector('[name="date"]').value = UI.todayStr();
    UI.openModal('modalAddInteraction');
  }

  async function handleAddInteraction(e) {
    e.preventDefault();
    const fd = new FormData(e.target);
    const data = Object.fromEntries(fd);
    await DB.createInteraction(data);
    UI.closeModal('modalAddInteraction');
    UI.toast('Interaction enregistrée');
    renderProspectDetail(document.getElementById('app'), data.prospect_id);
    return false;
  }

  function openAddReminder(prospectId) {
    document.getElementById('formAddReminder').reset();
    document.getElementById('formAddReminder').querySelector('[name="prospect_id"]').value = prospectId;
    UI.openModal('modalAddReminder');
  }

  async function handleAddReminder(e) {
    e.preventDefault();
    const fd = new FormData(e.target);
    const data = Object.fromEntries(fd);
    await DB.createReminder(data);
    UI.closeModal('modalAddReminder');
    UI.toast('Rappel ajouté');
    renderProspectDetail(document.getElementById('app'), data.prospect_id);
    return false;
  }

  // ============================================================
  // REMINDERS
  // ============================================================
  async function renderRappels(container) {
    container.innerHTML = `
      <div class="page-header">
        <h1 class="page-title" style="margin-bottom:0">Rappels</h1>
        <select id="filterRappelStatus" onchange="App.loadRappels()">
          <option value="pending">En attente</option>
          <option value="">Tous</option>
          <option value="done">Fait</option>
          <option value="snoozed">Snoozé</option>
        </select>
      </div>
      <div id="rappelsList">${UI.loader()}</div>
    `;
    loadRappels();
  }

  async function loadRappels() {
    const status = document.getElementById('filterRappelStatus')?.value || '';
    const reminders = await DB.getReminders(status ? { status } : {});
    const el = document.getElementById('rappelsList');
    if (!el) return;

    if (reminders.length === 0) {
      el.innerHTML = UI.emptyState('Aucun rappel');
      return;
    }

    el.innerHTML = reminders.map(r => {
      const name = r.prospects ? `${r.prospects.first_name} ${r.prospects.last_name}` : '—';
      const overdue = r.status === 'pending' && UI.isOverdue(r.due_date);
      const today = r.status === 'pending' && UI.isToday(r.due_date);
      return `<div class="reminder-row ${overdue ? 'overdue' : ''} ${today ? 'today' : ''} ${!overdue && !today ? 'upcoming' : ''}">
        <div class="reminder-info">
          <span class="reminder-name"><a class="inline-link" href="#prospect-detail?id=${r.prospect_id}">${UI.esc(name)}</a></span>
          ${r.type ? UI.typeBadge(r.type) : ''}
          ${overdue ? '<span class="badge badge-overdue">En retard</span>' : ''}
          ${today ? '<span class="badge badge-today">Aujourd\'hui</span>' : ''}
          <div class="reminder-note">${UI.esc(r.note || '')}</div>
        </div>
        <span class="reminder-date">${UI.formatDate(r.due_date)}</span>
        ${r.status === 'pending' ? `
          <div class="action-btns">
            <button class="btn btn-sm btn-primary" onclick="App.reminderDone('${r.id}')">✓ Fait</button>
            <button class="btn btn-sm btn-outline" onclick="App.reminderSnooze('${r.id}')">+3j</button>
          </div>
        ` : `<span class="badge ${r.status === 'done' ? 'badge-gagne' : 'badge-contacte'}">${r.status === 'done' ? 'Fait' : 'Snoozé'}</span>`}
      </div>`;
    }).join('');
  }

  async function reminderDone(id) {
    await DB.markReminderDone(id);
    UI.toast('Rappel marqué comme fait');
    router(); // Refresh current page
  }

  async function reminderSnooze(id) {
    await DB.snoozeReminder(id);
    UI.toast('Rappel reporté de 3 jours');
    router();
  }

  // ============================================================
  // LOGS
  // ============================================================
  async function renderLogs(container) {
    container.innerHTML = `
      <div class="page-header">
        <h1 class="page-title" style="margin-bottom:0">Journal d'activité</h1>
      </div>
      <div class="filter-grid">
        <div class="filter-group">
          <label>Campagne</label>
          <select id="logsCampaignFilter" onchange="App.loadLogs()">
            <option value="">Toutes les campagnes</option>
          </select>
        </div>
        <div class="filter-group">
          <label>Du</label>
          <input type="date" id="logsFromFilter" onchange="App.loadLogs()">
        </div>
        <div class="filter-group">
          <label>Au</label>
          <input type="date" id="logsToFilter" onchange="App.loadLogs()">
        </div>
        <div class="filter-group">
          <label>Type</label>
          <select id="logsTypeFilter" onchange="App.loadLogs()">
            <option value="">Tous les types</option>
            <option value="status_change">Changement de statut</option>
            <option value="sequence">Séquences</option>
            <option value="dispatch">Dispatch (Tâche 2)</option>
          </select>
        </div>
      </div>
      <div class="card">
        <div class="table-wrap" id="logsTableWrap">
          <table id="logsTable"><thead id="logsTableHead"><tr><th>Date / Heure</th><th>Prospect</th><th>Action</th><th>Détail</th></tr></thead>
          <tbody id="logsList">${UI.loader()}</tbody></table>
        </div>
      </div>`;

    // Load campaigns for filter dropdown
    const campaignFilter = document.getElementById('logsCampaignFilter');
    try {
      const resp = await fetch('/api/prospector/campaigns');
      const camps = await resp.json();
      camps.forEach(c => {
        const opt = document.createElement('option');
        opt.value = c.id;
        opt.textContent = c.name;
        campaignFilter.appendChild(opt);
      });
    } catch(e) {}

    loadLogs();
  }

  async function loadLogs() {
    const campaignId = document.getElementById('logsCampaignFilter')?.value || '';
    const fromDate = document.getElementById('logsFromFilter')?.value || '';
    const toDate = document.getElementById('logsToFilter')?.value || '';
    const type = document.getElementById('logsTypeFilter')?.value || '';

    let url = '/api/logs';
    const params = [];
    if (campaignId) params.push(`campaign_id=${campaignId}`);
    if (fromDate) params.push(`from=${fromDate}`);
    if (toDate) params.push(`to=${toDate}`);
    if (type) params.push(`type=${type}`);
    if (params.length > 0) url += '?' + params.join('&');

    try {
      const resp = await fetch(url);
      const raw = await resp.json();
      const logs = Array.isArray(raw) ? raw : [];
      const el = document.getElementById('logsList');
      if (!el) return;

      if (!resp.ok || logs.length === 0) {
        el.innerHTML = `<tr><td colspan="4" style="text-align:center;padding:30px;color:var(--color-text-muted)">Aucun log</td></tr>`;
        return;
      }

      const isSeq = type === 'sequence';
      const isDispatch = type === 'dispatch';

      // Adapter le header du tableau selon le type
      const head = document.getElementById('logsTableHead');
      if (head) {
        if (isDispatch) {
          head.innerHTML = `<tr><th>Date / Heure</th><th>Durée</th><th>Invitations</th><th>Messages</th><th>Réponses</th><th>Quotas restants</th><th>Statut</th></tr>`;
        } else {
          head.innerHTML = `<tr><th>Date / Heure</th><th>Prospect</th><th>Action</th><th>Détail</th></tr>`;
        }
      }

      if (isDispatch) {
        const STOP_LABELS = {
          'rate_limited':    { label: 'Arrêt — rate limit (429)', cls: 'badge-perdu' },
          'session_expired': { label: 'Arrêt — session expirée', cls: 'badge-a-valider' },
          'quota_reached':   { label: 'Arrêt — quota atteint', cls: 'badge-non-pertinent' },
        };
        el.innerHTML = logs.map(log => {
          const dur = log.duration_seconds != null ? `${Math.floor(log.duration_seconds / 60)}m ${log.duration_seconds % 60}s` : '—';
          const stopInfo = log.stopped_reason ? STOP_LABELS[log.stopped_reason] || { label: log.stopped_reason, cls: 'badge-perdu' } : { label: 'Normal', cls: 'badge-gagne' };
          const quotaInv = log.quota_invitations_remaining != null ? log.quota_invitations_remaining : '—';
          const quotaMsg = log.quota_messages_remaining != null ? log.quota_messages_remaining : '—';
          return `<tr>
            <td class="text-sm">${UI.formatDate(log.ran_at)}</td>
            <td class="text-sm text-muted">${dur}</td>
            <td class="text-sm">
              <div>Envoyées : <strong>${log.invitations_sent}</strong></div>
              <div class="text-muted">Acceptées : ${log.invitations_accepted}</div>
            </td>
            <td class="text-sm">
              <div>Soumis : <strong>${log.messages_submitted}</strong></div>
              <div class="text-muted">Envoyés : ${log.messages_sent}</div>
            </td>
            <td class="text-sm"><strong>${log.replies_detected}</strong></td>
            <td class="text-sm text-muted">Inv. : ${quotaInv} — Msg : ${quotaMsg}</td>
            <td><span class="badge ${stopInfo.cls}">${UI.esc(stopInfo.label)}</span></td>
          </tr>`;
        }).join('');
      } else {
        el.innerHTML = logs.map(log => {
          const prospectName = log.prospect ? `${log.prospect.first_name} ${log.prospect.last_name}` : '—';
          const prospectCompany = log.prospect?.company ? ` (${log.prospect.company})` : '';
          let actionText = '—';
          if (isSeq) {
            const statusMap = {
              'active': `Étape ${log.current_step_order} en cours`,
              'completed': 'Séquence terminée',
              'stopped_reply': 'Arrêtée — réponse reçue',
              'paused': 'Mise en pause'
            };
            actionText = statusMap[log.status] || log.status;
          } else {
            actionText = log.new_status ? `${log.old_status} → ${log.new_status}` : '—';
          }
          return `<tr>
            <td class="text-sm">${UI.formatDate(log.created_at)}</td>
            <td><strong>${UI.esc(prospectName)}</strong><div class="text-sm text-muted">${UI.esc(prospectCompany)}</div></td>
            <td>${actionText}</td>
            <td class="text-sm text-muted">${log.source || '—'}</td>
          </tr>`;
        }).join('');
      }
    } catch(e) {
      const el = document.getElementById('logsList');
      if (el) el.innerHTML = `<tr><td colspan="4" style="text-align:center;padding:30px;color:#EF4444">Erreur : ${e.message}</td></tr>`;
    }
  }

  // ============================================================
  // CAMPAGNES
  // ============================================================
  let _campTab = 'active'; // 'active' or 'archived'

  async function renderCampagnes(container) {
    const svgLink = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#2D6A4F" stroke-width="2" stroke-linecap="round"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg>`;
    container.innerHTML = `
      <div class="page-header">
        <div class="flex items-center gap-3">
          <div class="sfc-icon-wrap" style="background:var(--color-primary-light);color:var(--color-primary)">${svgLink}</div>
          <h1 class="page-title" style="margin-bottom:0">Mes campagnes LinkedIn</h1>
        </div>
        <button class="btn btn-primary" onclick="window.location.href='/campaigns/new'">+ Créer une nouvelle campagne</button>
      </div>
      <div class="tab-bar" id="campTabs">
        <button class="tab-btn tab-active" data-tab="active" onclick="App.switchCampTab('active')">Actives</button>
        <button class="tab-btn" data-tab="archived" onclick="App.switchCampTab('archived')">Archivées</button>
      </div>
      <div id="campagnesTable">${UI.loader()}</div>
    `;
    document.querySelectorAll('.camp-status-select').forEach(sel => {
      sel.innerHTML = '';
      UI.CAMP_STATUSES.filter(s => s !== 'Archivée').forEach(s => { const o = document.createElement('option'); o.value = s; o.textContent = s; sel.appendChild(o); });
    });
    _campTab = 'active';
    loadCampagnes();
  }

  function switchCampTab(tab) {
    _campTab = tab;
    document.querySelectorAll('#campTabs .tab-btn').forEach(b => {
      b.classList.toggle('tab-active', b.dataset.tab === tab);
    });
    loadCampagnes();
  }

  let _campaignsCache = [];

  async function loadCampagnes() {
    const url = _campTab === 'archived'
      ? '/api/prospector/campaigns?status=Archiv%C3%A9e'
      : '/api/prospector/campaigns?active=true';
    try {
      const resp = await fetch(url);
      if (!resp.ok) {
        _campaignsCache = [];
        renderCampaignCards();
        return;
      }
      const campaigns = await resp.json();
      _campaignsCache = Array.isArray(campaigns) ? campaigns : [];
      renderCampaignCards();
    } catch (err) {
      console.error('Error loading campaigns:', err);
      _campaignsCache = [];
      renderCampaignCards();
    }
  }

  function renderCampaignCards() {
    const el = document.getElementById('campagnesTable');
    if (!el) return;

    if (_campaignsCache.length === 0) {
      el.innerHTML = UI.emptyState('Aucune campagne');
      return;
    }

    const svgInv = `<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="5.5" cy="4.5" r="2.5"/><path d="M1 13c0-2.5 2-4.5 4.5-4.5"/><circle cx="11.5" cy="5.5" r="2"/><path d="M15 13c0-2-1.5-3.5-3.5-3.5H10"/></svg>`;
    const svgAcc = `<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6"/><path d="M5.5 8l2 2L11 6"/></svg>`;
    const svgMsg = `<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3h10a1 1 0 011 1v6a1 1 0 01-1 1H9l-3 2.5V11H3a1 1 0 01-1-1V4a1 1 0 011-1z"/></svg>`;
    const svgReply = `<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M2 3h9a1 1 0 011 1v5a1 1 0 01-1 1H8l-3 2v-2H3a1 1 0 01-1-1V4a1 1 0 011-1z"/></svg>`;

    el.innerHTML = `<div class="card" style="padding:0;overflow:hidden">
      <div class="table-wrap">
        <table class="camp-table">
          <thead><tr>
            <th>Status</th>
            <th>Nom</th>
            <th class="text-center"><span class="th-icon">${svgInv}</span> Invitations</th>
            <th class="text-center"><span class="th-icon">${svgAcc}</span> Acceptées</th>
            <th class="text-center"><span class="th-icon">${svgMsg}</span> Envoyés</th>
            <th class="text-center"><span class="th-icon">${svgReply}</span> Réponses</th>
          </tr></thead>
          <tbody>${_campaignsCache.map(c => {
            const sc = c.status_counts || {};
            const inv = (sc['Invitation envoyée'] || 0) + (sc['Invitation acceptée'] || 0) + (sc['Message à valider'] || 0) + (sc['Message à envoyer'] || 0) + (sc['Message envoyé'] || 0) + (sc['Discussion en cours'] || 0) + (sc['Gagné'] || 0);
            const acc = (sc['Invitation acceptée'] || 0) + (sc['Message à valider'] || 0) + (sc['Message à envoyer'] || 0) + (sc['Message envoyé'] || 0) + (sc['Discussion en cours'] || 0) + (sc['Gagné'] || 0);
            const msg = (sc['Message envoyé'] || 0) + (sc['Discussion en cours'] || 0) + (sc['Gagné'] || 0);
            const rep = (sc['Discussion en cours'] || 0) + (sc['Gagné'] || 0);
            const cellCls = n => n > 0 ? 'camp-stat' : 'camp-stat camp-stat-zero';
            return `<tr class="clickable" onclick="location.hash='#campaign-detail?id=${c.id}'">
              <td>${UI.campStatusBadge(c.status)}</td>
              <td>
                <div class="camp-row-name">${UI.esc(c.name)}</div>
                <div class="text-sm text-muted">Créée le ${UI.formatDate(c.created_at)}</div>
              </td>
              <td class="${cellCls(inv)}">${inv}</td>
              <td class="${cellCls(acc)}">${acc}</td>
              <td class="${cellCls(msg)}">${msg}</td>
              <td class="${cellCls(rep)}">${rep}</td>
            </tr>`;
          }).join('')}</tbody>
        </table>
      </div>
    </div>`;
  }

  function initCardDrag() {
    const list = document.getElementById('campCardsList');
    if (!list) return;
    let dragCard = null;

    list.querySelectorAll('.camp-card').forEach(card => {
      card.addEventListener('click', e => {
        if (card._dragged) return;
        location.hash = `#campaign-detail?id=${card.dataset.id}`;
      });

      card.addEventListener('dragstart', e => {
        dragCard = card;
        card.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        card._dragged = true;
      });

      card.addEventListener('dragend', () => {
        card.classList.remove('dragging');
        list.querySelectorAll('.drag-over').forEach(c => c.classList.remove('drag-over'));
        setTimeout(() => { card._dragged = false; }, 50);
        dragCard = null;
      });

      card.addEventListener('dragover', e => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        if (card !== dragCard) {
          list.querySelectorAll('.drag-over').forEach(c => c.classList.remove('drag-over'));
          card.classList.add('drag-over');
        }
      });

      card.addEventListener('dragleave', () => card.classList.remove('drag-over'));

      card.addEventListener('drop', async e => {
        e.preventDefault();
        card.classList.remove('drag-over');
        if (!dragCard || dragCard === card) return;

        const fromIdx = parseInt(dragCard.dataset.idx);
        const toIdx = parseInt(card.dataset.idx);
        if (fromIdx === toIdx) return;

        const moved = _campaignsCache.splice(fromIdx, 1)[0];
        _campaignsCache.splice(toIdx, 0, moved);

        renderCampaignCards();

        const updates = _campaignsCache.map((c, i) => ({ id: c.id, priority: i + 1 }));
        for (const u of updates) {
          await APIClient.put(`/api/prospector/campaigns/${u.id}`, { priority: u.priority });
        }
      });
    });
  }

  function buildCampaignBody(raw, jobTagsId, exclTagsId, objTagsId) {
    return {
      name: raw.name,
      status: raw.status || 'À lancer',
      priority: parseInt(raw.priority) || 1,
      sector: raw.sector || null,
      geography: raw.geography || null,
      details: raw.details || null,
      excluded_keywords: UI.getTagValues(exclTagsId),
      objectives: UI.getTagValues(objTagsId),
      criteria: {
        sector: raw.sector || null,
        geography: raw.geography || null,
        job_titles: UI.getTagValues(jobTagsId),
        revenue_min: raw.revenue_min ? parseInt(raw.revenue_min) : null,
        revenue_max: raw.revenue_max ? parseInt(raw.revenue_max) : null,
        employees_min: raw.employees_min ? parseInt(raw.employees_min) : null,
        employees_max: raw.employees_max ? parseInt(raw.employees_max) : null,
      },
    };
  }

  async function handleAddCampaign(e) {
    e.preventDefault();
    const fd = new FormData(e.target);
    const raw = Object.fromEntries(fd);
    const errEl = document.getElementById('campaignError');
    errEl.style.display = 'none';

    const body = buildCampaignBody(raw, 'addJobTags', 'addExclTags', 'addObjTags');

    const resp = await APIClient.post('/api/prospector/campaigns', body);
    const result = await resp.json();
    if (!resp.ok) {
      errEl.textContent = result.error || 'Erreur';
      errEl.style.display = 'block';
      return false;
    }

    UI.closeModal('modalAddCampaign');
    UI.toast('Campagne créée');
    renderCampagnes(document.getElementById('app'));
    return false;
  }

  function openAddCampaign() {
    document.getElementById('formAddCampaign').reset();
    initAddCampaignTags();
    UI.openModal('modalAddCampaign');
  }

  function initAddCampaignTags() {
    document.getElementById('addJobTags').innerHTML = '';
    document.getElementById('addObjTags').innerHTML = '';
    document.getElementById('addExclTags').innerHTML = '';
    UI.initTagsInput('addJobInput', 'addJobTags', '');
    UI.initTagsInput('addObjInput', 'addObjTags', 'tag-obj');
    UI.initTagsInput('addExclInput', 'addExclTags', 'tag-excl');
  }

  async function openEditCampaign(id) {
    const c = await DB.getCampaign(id);
    const criteria = c.criteria || {};
    const form = document.getElementById('formEditCampaign');
    form.querySelector('[name="id"]').value = c.id;
    form.querySelector('[name="name"]').value = c.name;
    form.querySelector('[name="priority"]').value = c.priority || '';
    form.querySelector('[name="status"]').value = c.status || 'À lancer';
    form.querySelector('[name="sector"]').value = c.sector || criteria.sector || '';
    form.querySelector('[name="geography"]').value = c.geography || criteria.geography || '';
    form.querySelector('[name="revenue_min"]').value = criteria.revenue_min || '';
    form.querySelector('[name="revenue_max"]').value = criteria.revenue_max || '';
    form.querySelector('[name="employees_min"]').value = criteria.employees_min || '';
    form.querySelector('[name="employees_max"]').value = criteria.employees_max || '';
    form.querySelector('[name="details"]').value = c.details || '';

    // Populate tags
    UI.setTags('editJobTags', criteria.job_titles || [], '');
    UI.setTags('editObjTags', c.objectives || [], 'tag-obj');
    UI.setTags('editExclTags', c.excluded_keywords || [], 'tag-excl');
    UI.initTagsInput('editJobInput', 'editJobTags', '');
    UI.initTagsInput('editObjInput', 'editObjTags', 'tag-obj');
    UI.initTagsInput('editExclInput', 'editExclTags', 'tag-excl');

    document.getElementById('campaignEditError').style.display = 'none';
    UI.openModal('modalEditCampaign');
  }

  async function handleEditCampaign(e) {
    e.preventDefault();
    const fd = new FormData(e.target);
    const raw = Object.fromEntries(fd);
    const id = raw.id;
    const errEl = document.getElementById('campaignEditError');
    errEl.style.display = 'none';

    const body = buildCampaignBody(raw, 'editJobTags', 'editExclTags', 'editObjTags');

    const resp = await APIClient.put(`/api/prospector/campaigns/${id}`, body);
    const result = await resp.json();
    if (!resp.ok) {
      errEl.textContent = result.error || 'Erreur';
      errEl.style.display = 'block';
      return false;
    }

    UI.closeModal('modalEditCampaign');
    UI.toast('Campagne mise à jour');
    renderCampaignDetail(document.getElementById('app'), id);
    return false;
  }

  async function archiveCampaign(id, archive) {
    const newStatus = archive ? 'Archivée' : 'À lancer';
    try {
      const resp = await APIClient.put(`/api/prospector/campaigns/${id}`, { status: newStatus });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        console.error('Archive failed:', resp.status, err);
        throw new Error(err.error || 'Failed');
      }
      UI.toast(archive ? 'Campagne archivée' : 'Campagne désarchivée');
      location.hash = '#campagnes';
    } catch (err) {
      console.error('archiveCampaign error:', err);
      UI.toast('Erreur lors de l\'archivage: ' + err.message, 'error');
    }
  }

  async function renderCampaignDetail(container, id) {
    if (!id) { location.hash = '#campagnes'; return; }
    container.innerHTML = UI.loader();

    const [campaign, prospects] = await Promise.all([
      DB.getCampaign(id),
      DB.getProspects({ campaign_id: id }),
    ]);

    const criteria = campaign.criteria || {};
    const statusCounts = {};
    for (const p of prospects) {
      statusCounts[p.status] = (statusCounts[p.status] || 0) + 1;
    }

    // Format CA range (compact notation)
    const fmtRev = n => n ? new Intl.NumberFormat('fr-FR', { notation: 'compact', maximumSignificantDigits: 2 }).format(n) + '€' : null;
    const caMin = fmtRev(criteria.revenue_min), caMax = fmtRev(criteria.revenue_max);
    const caStr = caMin || caMax ? (caMin && caMax ? `${caMin} — ${caMax}` : caMin ? `${caMin}+` : `< ${caMax}`) : null;

    // Format effectif range
    const empMin = criteria.employees_min, empMax = criteria.employees_max;
    const empStr = empMin || empMax ? (empMin && empMax ? `${empMin} — ${empMax}` : empMin ? `${empMin}+` : `< ${empMax}`) : null;

    // SVG icons for meta chips
    const svgQuota = `<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M9 2L6 9h4l-3 5"/></svg>`;
    const svgCa    = `<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="8" cy="8" r="6"/><path d="M5.5 9.5a2.5 2.5 0 005 0c0-1.5-1-2.5-2.5-2.5S5.5 6 5.5 5a2.5 2.5 0 015 0M8 3v1M8 12v1"/></svg>`;
    const svgEmp   = `<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="5.5" cy="4.5" r="2.5"/><path d="M1 13c0-2.5 2-4.5 4.5-4.5"/><circle cx="11.5" cy="5.5" r="2"/><path d="M15 13c0-2-1.5-3.5-3.5-3.5H10"/></svg>`;
    const svgEdit  = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11.5 2.5a1.4 1.4 0 012 2L5 13H2v-3L11.5 2.5z"/></svg>`;
    const svgArch  = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="12" height="8" rx="1"/><path d="M1 6h14M6 10h4"/><path d="M5 6V4h6v2"/></svg>`;
    const svgTarget = `<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="8" cy="8" r="6"/><circle cx="8" cy="8" r="2.5"/><path d="M8 2v2M8 12v2M2 8h2M12 8h2"/></svg>`;

    // Ciblage content
    const hasCiblage = !!(criteria.sector || campaign.sector || criteria.geography || campaign.geography
      || (criteria.job_titles || []).length || (campaign.excluded_keywords || []).length);

    container.innerHTML = `
      <a class="inline-link camp-back" href="#campagnes">← Campagnes</a>

      <div class="camp-header">
        <div class="camp-title-row">
          <div class="camp-title-block">
            <h1 class="camp-title">${UI.esc(campaign.name)}</h1>
            ${UI.campStatusBadge(campaign.status)}
          </div>
          <div class="flex gap-2 items-center">
            <button class="btn btn-outline" onclick="window.location.href='/campaigns/edit/${id}'" style="display:flex;align-items:center;gap:6px">
              ${svgEdit} Modifier
            </button>
            ${campaign.status !== 'Archivée'
              ? `<button class="btn btn-ghost" onclick="App.archiveCampaign('${id}', true)" style="display:flex;align-items:center;gap:6px">${svgArch} Archiver</button>`
              : `<button class="btn btn-outline" onclick="App.archiveCampaign('${id}', false)">Désarchiver</button>`
            }
          </div>
        </div>

        <div class="camp-meta-chips">
          <span class="camp-meta-chip">${svgQuota} ${campaign.daily_quota || 20}/j quota</span>
          ${caStr ? `<span class="camp-meta-chip">${svgCa} ${caStr} CA</span>` : ''}
          ${empStr ? `<span class="camp-meta-chip">${svgEmp} ${empStr} salariés</span>` : ''}
        </div>

        ${hasCiblage ? `<details class="camp-ciblage">
          <summary>${svgTarget} Voir ciblage et exclusions</summary>
          <div class="camp-ciblage-body">
            <div class="camp-ciblage-section">
              <div class="camp-ciblage-label">CIBLAGE</div>
              <div class="camp-ciblage-tags">
                <span class="badge badge-type">Priorité ${campaign.priority || '—'}</span>
                ${criteria.sector || campaign.sector ? `<span class="badge badge-type">${UI.esc(criteria.sector || campaign.sector)}</span>` : ''}
                ${criteria.geography || campaign.geography ? `<span class="badge badge-type">${UI.esc(criteria.geography || campaign.geography)}</span>` : ''}
                ${(criteria.job_titles || []).map(j => `<span class="badge badge-type">${UI.esc(j)}</span>`).join('')}
              </div>
            </div>
            ${(campaign.excluded_keywords || []).length ? `<div class="camp-ciblage-section">
              <div class="camp-ciblage-label">EXCLUSIONS</div>
              <div class="camp-ciblage-tags">
                ${campaign.excluded_keywords.map(k => `<span class="badge tag-excl">${UI.esc(k)}</span>`).join('')}
              </div>
            </div>` : ''}
          </div>
        </details>` : ''}

        ${campaign.details ? `<p class="text-sm text-muted" style="white-space:pre-wrap;margin-top:12px">${UI.esc(campaign.details)}</p>` : ''}
      </div>

      <div class="tab-bar mt-6">
        <button class="tab-btn tab-active" data-tab="prospects" onclick="App.switchCampaignTab(this, 'prospects', '${id}')">Prospects</button>
        <button class="tab-btn" data-tab="sequence" onclick="App.switchCampaignTab(this, 'sequence', '${id}')">Séquence</button>
        <button class="tab-btn" data-tab="review" onclick="App.switchCampaignTab(this, 'review', '${id}')" id="tabBtnReview">Review</button>
      </div>
      <div id="campaignTabContent"></div>
    `;

    _campDetailCache[id] = { prospects, statusCounts };
    renderProspectsTab(id, prospects, statusCounts);
  }

  let _campActiveStatus = null;

  function renderProspectsTab(id, prospects, statusCounts) {
    _campActiveStatus = null;
    const el = document.getElementById('campaignTabContent');
    if (!el) return;

    const total = prospects.length;

    const SFC_LABELS = {
      'Profil incomplet':    'À compléter',
      'Profil à valider':    'À valider',
      'Nouveau':             'New',
      'Invitation envoyée':  'Envoyée',
      'Invitation acceptée': 'Acceptée',
      'Message à valider':   'Msg à valider',
      'Message à envoyer':   'Msg à envoyer',
      'Message envoyé':      'Msg envoyé',
      'Discussion en cours': 'En cours',
    };

    // Ordered statuses for campaign filter cards
    // "Invitation acceptée" inserted before "Message à valider" if it has prospects
    // "Profil incomplet" shown conditionally, "Profil restreint" excluded
    const baseStatuses = [...UI.STATUSES];
    // Insert "Invitation acceptée" before "Message à valider" if it has prospects
    if (statusCounts['Invitation acceptée']) {
      const msgIdx = baseStatuses.indexOf('Message à valider');
      if (msgIdx !== -1) baseStatuses.splice(msgIdx, 0, 'Invitation acceptée');
      else baseStatuses.push('Invitation acceptée');
    }
    // Append "Profil incomplet" at the end if it has prospects
    const orderedStatuses = [
      ...baseStatuses,
    ];

    el.innerHTML = `
      <div class="sfc-grid mt-6" id="sfcGrid">
        ${_sfcCard(null, total, 'Tous', true)}
        ${orderedStatuses.map(s => _sfcCard(s, statusCounts[s], SFC_LABELS[s] || s, false)).join('')}
      </div>
      <div class="card" id="campProspectsCard">
        <div class="table-wrap">
          ${_renderCampTable(prospects, null)}
        </div>
      </div>
    `;
  }

  function _sfcCard(status, count, label, active) {
    const meta = status ? (UI.STATUS_COLORS[status] || { color: '#64748B', bg: '#F1F5F9' }) : { color: '#1E293B', bg: '#E2E8F0' };
    const iconPath = UI.STATUS_ICONS[status || '_tous'] || '';
    const activeStyle = active ? `style="background:${meta.bg};border-color:${meta.color}"` : '';
    return `<div class="sfc${active ? ' sfc-active' : ''}" data-status="${UI.esc(status || '')}" data-color="${meta.color}" data-bg="${meta.bg}" onclick="App._filterCampByStatus(this)" ${activeStyle}>
      <div class="sfc-icon-wrap" style="background:${meta.bg};color:${meta.color}">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${iconPath}</svg>
      </div>
      <div class="sfc-info">
        <div class="sfc-count">${count ?? 0}</div>
        <div class="sfc-label">${UI.esc(label)}</div>
      </div>
    </div>`;
  }

  function _filterCampByStatus(el) {
    const status = el.dataset.status || null;
    const grid = document.getElementById('sfcGrid');
    if (!grid) return;

    const wasActive = el.classList.contains('sfc-active');

    // Reset all cards
    grid.querySelectorAll('.sfc').forEach(card => {
      card.classList.remove('sfc-active');
      card.style.background = '';
      card.style.borderColor = '';
    });

    if (!wasActive) {
      // Activate clicked card
      el.classList.add('sfc-active');
      el.style.background = el.dataset.bg;
      el.style.borderColor = el.dataset.color;
      _campActiveStatus = status;
    } else {
      // Re-click → back to "Tous"
      const tousCard = grid.querySelector('[data-status=""]');
      if (tousCard) {
        tousCard.classList.add('sfc-active');
        tousCard.style.background = tousCard.dataset.bg;
        tousCard.style.borderColor = tousCard.dataset.color;
      }
      _campActiveStatus = null;
    }

    const campId = new URLSearchParams((location.hash.split('?')[1] || '')).get('id');
    if (!campId || !_campDetailCache[campId]) return;
    const card = document.getElementById('campProspectsCard');
    if (!card) return;
    card.querySelector('.table-wrap').innerHTML = _renderCampTable(_campDetailCache[campId].prospects, _campActiveStatus);
  }

  function _renderCampTable(prospects, statusFilter) {
    const rows = statusFilter ? prospects.filter(p => p.status === statusFilter) : prospects;
    if (rows.length === 0) return UI.emptyState(statusFilter ? `Aucun prospect avec le statut "${statusFilter}"` : 'Aucun prospect dans cette campagne');
    const isAValiderFilter = statusFilter === 'Profil à valider';
    const campId = new URLSearchParams((location.hash.split('?')[1] || '')).get('id');
    return `<table><thead><tr><th>Nom</th><th>Entreprise</th><th>Poste</th><th>Statut</th><th>Dernier contact</th>${isAValiderFilter ? '<th></th>' : ''}</tr></thead>
      <tbody>${rows.map(p => `<tr class="clickable ${isAValiderFilter ? 'row-a-valider' : ''}" onclick="location.hash='#prospect-detail?id=${p.id}'">
        <td><strong>${UI.esc(p.first_name)} ${UI.esc(p.last_name)}</strong></td>
        <td>${UI.esc(p.company || '')}</td>
        <td class="text-sm text-muted">${UI.esc(p.job_title || '')}</td>
        <td>${UI.statusBadge(p.status)}</td>
        <td class="text-muted text-sm">${UI.formatDate(p.updated_at)}</td>
        ${isAValiderFilter ? `<td class="action-btns" onclick="event.stopPropagation()"><button class="btn-icon btn-validate" onclick="App.quickValidateInCampaign('${p.id}','${campId}')" title="Valider">✓</button><button class="btn-icon btn-reject" onclick="App.quickRejectInCampaign('${p.id}','${campId}')" title="Non pertinent">✕</button></td>` : ''}
      </tr>`).join('')}</tbody></table>`;
  }

  async function quickValidateInCampaign(id, campaignId) {
    await APIClient.post('/api/prospector/bulk-update-status', { ids: [id], status: 'Nouveau' });
    UI.toast('Profil validé');
    await _refreshCampProspects(campaignId);
  }

  async function quickRejectInCampaign(id, campaignId) {
    await APIClient.post('/api/prospector/bulk-update-status', { ids: [id], status: 'Non pertinent' });
    UI.toast('Profil marqué non pertinent');
    await _refreshCampProspects(campaignId);
  }

  async function _refreshCampProspects(campaignId) {
    const prospects = await DB.getProspects({ campaign_id: campaignId });
    const statusCounts = {};
    for (const p of prospects) {
      statusCounts[p.status] = (statusCounts[p.status] || 0) + 1;
    }
    _campDetailCache[campaignId] = { ..._campDetailCache[campaignId], prospects, statusCounts };
    renderProspectsTab(campaignId, prospects, statusCounts);
  }

  // Cache for tab data so we don't refetch when switching back
  let _campDetailCache = {};

  function switchCampaignTab(btn, tab, campaignId) {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('tab-active'));
    btn.classList.add('tab-active');
    if (tab === 'prospects') {
      if (_campDetailCache[campaignId]) {
        const c = _campDetailCache[campaignId];
        renderProspectsTab(campaignId, c.prospects, c.statusCounts);
      }
    } else if (tab === 'sequence') {
      _seqActiveStepId = null;
      renderSequenceTab(campaignId);
    } else if (tab === 'review') {
      renderReviewTab(campaignId);
    }
  }

  // ============================================================
  // SEQUENCE EDITOR — Split panel v2
  // ============================================================

  const STEP_TYPES = {
    send_invitation: { icon: '🤝', label: 'Invitation' },
    send_message: { icon: '💬', label: 'Message' },
  };

  let _seqActiveStepId = null; // currently selected step in split panel
  let _placeholdersCache = null;
  let _seqStatesCache = null; // prospect sequence states for list badges

  async function renderSequenceTab(campaignId) {
    const el = document.getElementById('campaignTabContent');
    if (!el) return;
    el.innerHTML = UI.loader();

    // Load placeholders cache
    if (!_placeholdersCache) {
      const phResp = await fetch('/api/placeholders');
      _placeholdersCache = await phResp.json();
    }

    const resp = await fetch(`/api/sequences?campaign_id=${campaignId}`);
    const sequence = await resp.json();
    _seqCache = sequence; // Cache for instant step switching

    if (!sequence) {
      el.innerHTML = `
        <div class="card mt-6" style="text-align:center;padding:60px 20px">
          <div style="font-size:48px;margin-bottom:16px">📋</div>
          <div style="font-size:16px;font-weight:600;margin-bottom:8px">Aucune séquence configurée</div>
          <div class="text-sm text-muted" style="margin-bottom:20px">Définissez les étapes à automatiser pour cette campagne.</div>
          <button class="btn btn-primary" onclick="App.createSequence('${campaignId}')">Créer une séquence</button>
        </div>`;
      return;
    }

    const steps = sequence.sequence_steps || [];
    _seqActiveStepId = _seqActiveStepId || (steps[0]?.id || null);

    el.innerHTML = `
      <div class="seq-header mt-6">
        <div class="flex items-center gap-2">
          <input class="seq-name-input" value="${UI.esc(sequence.name)}" onblur="App.updateSequenceName('${sequence.id}', this.value)">
          <span class="badge badge-type">v${sequence.version}</span>
        </div>
        <div class="flex gap-2">
          <button class="btn btn-primary btn-sm" onclick="App.enrollCampaign('${campaignId}')">Enrôler la campagne</button>
          <button class="btn btn-outline btn-sm" onclick="App.createNewVersion('${campaignId}', ${sequence.version})">Nouvelle version</button>
        </div>
      </div>
      <div class="seq-split">
        <div class="seq-left" id="seqStepsList">
          ${steps.map((s, i) => {
            const meta = STEP_TYPES[s.type] || { icon: '❓', label: s.type };
            const label = s.message_label || meta.label;
            const isActive = s.id === _seqActiveStepId ? ' seq-step-active' : '';
            const delayHtml = i > 0 ? _delayHtml(s.delay_days) : '';
            const stepStatus = _getStepStatus(s);
            const statusClass = `step-status-${stepStatus}`;
            return `${delayHtml}<div class="seq-step-card${isActive}" draggable="true" data-step-id="${s.id}" data-idx="${i}" onclick="App.selectStep('${s.id}', '${campaignId}')">
              <span class="seq-step-drag" title="Glisser pour réordonner">⠿</span>
              <span class="seq-step-num ${statusClass}">${i + 1}</span>
              <span class="seq-step-icon">${meta.icon}</span>
              <span class="seq-step-label">${UI.esc(label)}</span>
              <button class="btn-icon" onclick="event.stopPropagation();App.deleteStep('${sequence.id}','${s.id}')" title="Supprimer">🗑️</button>
            </div>`;
          }).join('')}
          ${steps.length === 0 ? '<div class="text-sm text-muted" style="padding:20px;text-align:center">Aucune étape</div>' : ''}
          <div class="seq-add-step">
            ${!steps.some(s => s.type === 'send_invitation') ? `<button class="btn btn-outline btn-sm" onclick="App.addStep('${sequence.id}', 'send_invitation')">🤝 Invitation</button>` : ''}
            <button class="btn btn-outline btn-sm" onclick="App.addStep('${sequence.id}', 'send_message')">💬 Message</button>
          </div>
        </div>
        <div class="seq-right" id="seqStepConfig">${UI.loader()}</div>
      </div>`;

    initStepDrag(sequence.id);
    if (_seqActiveStepId) {
      const activeStep = steps.find(s => s.id === _seqActiveStepId);
      if (activeStep) renderStepConfig(activeStep, sequence.id, campaignId);
      else document.getElementById('seqStepConfig').innerHTML = '<div class="text-sm text-muted" style="padding:30px;text-align:center">Sélectionnez une étape</div>';
    } else {
      document.getElementById('seqStepConfig').innerHTML = '<div class="text-sm text-muted" style="padding:30px;text-align:center">Sélectionnez une étape</div>';
    }
  }

  // Determine step completion status for color coding
  function _getStepStatus(step) {
    if (step.type === 'send_invitation') {
      return 'complete'; // green — invitation is always ready
    }
    if (step.type === 'send_message') {
      const params = step.message_params || {};
      if (!params.angle && !params.tone && !params.objective) {
        return 'new'; // gray — never configured
      }
      if (!params.angle || !params.tone || !params.objective) {
        return 'incomplete'; // orange — at least one required param missing
      }
      return 'complete'; // green — all required params filled
    }
    return 'complete';
  }

  function _delayHtml(days) {
    let text;
    if (days === 0) text = 'Immédiatement';
    else if (days === 1) text = 'Attendre 1 jour';
    else text = `Attendre ${days} jours`;
    const tooltip = days > 1 ? ` title="Exécution entre J+${Math.round(days * 0.83)} et J+${Math.round(days * 1.17)} (randomisé ±17%)"` : '';
    return `<div class="seq-delay-divider"${tooltip}><span class="seq-delay-line"></span><span class="seq-delay-text">${text}</span><span class="seq-delay-line"></span></div>`;
  }

  let _seqCache = null; // Cache sequence data to avoid re-fetching on each step click

  function selectStep(stepId, campaignId) {
    _seqActiveStepId = stepId;
    document.querySelectorAll('.seq-step-card').forEach(c => c.classList.remove('seq-step-active'));
    document.querySelector(`.seq-step-card[data-step-id="${stepId}"]`)?.classList.add('seq-step-active');

    // Use cached sequence data if available (instant)
    if (_seqCache) {
      const step = (_seqCache.sequence_steps || []).find(s => s.id === stepId);
      if (step) { renderStepConfig(step, _seqCache.id, campaignId); return; }
    }

    // Fallback: fetch from API
    fetch(`/api/sequences?campaign_id=${campaignId}`).then(r => r.json()).then(seq => {
      _seqCache = seq;
      const step = (seq?.sequence_steps || []).find(s => s.id === stepId);
      if (step) renderStepConfig(step, seq.id, campaignId);
    });
  }

  function renderStepConfig(step, sequenceId, campaignId) {
    const el = document.getElementById('seqStepConfig');
    if (!el) return;
    const meta = STEP_TYPES[step.type] || { icon: '❓', label: step.type };
    const params = step.message_params || {};
    const mode = step.message_mode || 'manual';

    if (step.type === 'send_invitation') {
      const hasNote = step.has_note || false;
      const noteContent = step.note_content || '';
      const phGroups = {};
      for (const ph of (_placeholdersCache || [])) {
        if (!phGroups[ph.source]) phGroups[ph.source] = [];
        phGroups[ph.source].push(ph);
      }
      const phBarHtml = hasNote ? Object.entries(phGroups).map(([src, phs]) =>
        `<div class="ph-group"><span class="ph-group-label">${src}</span>${phs.map(p => `<button class="ph-btn" onclick="App._insertPlaceholder('{{${p.key}}}')" title="${UI.esc(p.description || p.label)}">${UI.esc(p.label)}</button>`).join('')}</div>`
      ).join('') : '';

      el.innerHTML = `
        <div class="seq-config-inner">
          <h3>${meta.icon} ${meta.label}</h3>
          <div class="form-group"><label>Libellé</label><input id="cfgLabel" value="${UI.esc(step.message_label || 'Invitation LinkedIn')}" placeholder="Invitation LinkedIn"></div>
          <div class="form-group"><label>Délai (jours)</label><input type="number" id="cfgDelay" min="0" value="${step.delay_days}"><div class="text-sm text-muted" style="margin-top:4px">0 = immédiatement</div></div>

          <div class="form-group">
            <label class="checkbox-inline">
              <input type="checkbox" id="cfgHasNote" ${hasNote ? 'checked' : ''} onchange="App._toggleInvitationNote()">
              <span>Inclure une note personnalisée</span>
            </label>
          </div>

          <div id="invitationNotePanel" style="display:${hasNote ? 'block' : 'none'}">
            <div class="ph-bar">${phBarHtml}</div>
            <div class="form-group">
              <textarea id="cfgNoteContent" rows="4" maxlength="300" placeholder="Votre note personnalisée…" oninput="App._updateNoteCharCount()">${UI.esc(noteContent)}</textarea>
              <div class="char-counter"><span id="noteCharCount">${noteContent.length}</span> / 300</div>
              <div id="noteWarning" style="display:${noteContent.length > 300 ? 'block' : 'none'};color:#EF4444;font-size:13px;margin-top:4px">⚠️ Limite LinkedIn dépassée (max 300 caractères)</div>
            </div>
          </div>

          <div id="invitationNoNotePanel" style="display:${!hasNote ? 'block' : 'none'};text-align:center">
            <div class="text-sm text-muted" style="background:#F0FDF4;padding:10px;border-radius:6px">L'invitation sera envoyée sans note.</div>
          </div>

          <button class="btn btn-primary" onclick="App._saveStepConfig('${sequenceId}','${step.id}')">Sauvegarder</button>
        </div>`;
      return;
    }

    // send_message — parameter-based config (Claude generates full message at execution)
    el.innerHTML = `
      <div class="seq-config-inner">
        <h3>${meta.icon} Message</h3>
        <div class="form-group"><label>Délai (jours)</label><input type="number" id="cfgDelay" min="1" value="${step.delay_days}"><div class="text-sm text-muted" style="margin-top:4px">Délai après l'étape précédente. Minimum 1 jour.</div></div>

        <div style="padding:16px;background:var(--color-bg);border-radius:var(--radius);border:1px solid var(--color-border-light);margin-bottom:16px">
          <div style="font-weight:600;margin-bottom:12px">Paramètres de génération Claude</div>
          <div class="text-sm text-muted" style="margin-bottom:16px">Ces paramètres guident Claude pour générer un message personnalisé pour chaque prospect. Le message sera créé avec les données du prospect et son contexte LinkedIn (posts récents).</div>

          <div class="form-row">
            <div class="form-group"><label>Angle</label>
              <select id="aiAngle">
                <option value="problème" ${(params.angle || '') === 'problème' ? 'selected' : ''}>Problème</option>
                <option value="opportunité" ${params.angle === 'opportunité' ? 'selected' : ''}>Opportunité</option>
                <option value="curiosité" ${params.angle === 'curiosité' ? 'selected' : ''}>Curiosité</option>
              </select>
            </div>
            <div class="form-group"><label>Ton</label><input id="aiTone" value="${UI.esc(params.tone || '')}" placeholder="ex: conversationnel, direct, chaleureux..."></div>
          </div>
          <div class="form-row">
            <div class="form-group"><label>Objectif du message</label><input id="aiObjective" value="${UI.esc(params.objective || '')}" placeholder="ex: Décrocher un call de 15 min"></div>
            <div class="form-group"><label>Max caractères</label><input type="number" id="aiMaxChars" min="50" max="1000" value="${params.max_chars || 300}" placeholder="300"></div>
          </div>
          <div class="form-group"><label>Contexte / thématique</label><input id="aiContext" value="${UI.esc(params.context || '')}" placeholder="ex: Réglementation CSRD, bilan carbone BTP..."></div>
          <div class="form-group"><label>Instructions libres (optionnel)</label><textarea id="aiInstructions" rows="3" placeholder="Instructions spécifiques pour Claude : points à mentionner, à éviter, structure souhaitée...">${UI.esc(params.instructions || '')}</textarea></div>
        </div>

        <div style="margin-top:16px">
          <button class="btn btn-primary" onclick="App._saveStepConfig('${sequenceId}','${step.id}')">Sauvegarder</button>
        </div>
      </div>`;
  }

  function _insertPlaceholder(placeholder) {
    const ta = document.getElementById('stepContent') || document.getElementById('aiResultContent') || document.getElementById('cfgNoteContent');
    if (!ta) return;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    ta.value = ta.value.substring(0, start) + placeholder + ta.value.substring(end);
    ta.selectionStart = ta.selectionEnd = start + placeholder.length;
    ta.focus();
    // Update appropriate character counter
    if (ta.id === 'cfgNoteContent') {
      _updateNoteCharCount();
    } else {
      _updateCharCount();
    }
  }

  function initStepDrag(sequenceId) {
    const list = document.getElementById('seqStepsList');
    if (!list) return;
    let dragCard = null;

    list.querySelectorAll('.seq-step-card').forEach(card => {
      card.addEventListener('dragstart', e => {
        dragCard = card;
        card.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/html', card.innerHTML);
        e.stopPropagation();
      });
      card.addEventListener('dragend', e => {
        card.classList.remove('dragging');
        list.querySelectorAll('.drag-over').forEach(c => c.classList.remove('drag-over'));
        dragCard = null;
        e.stopPropagation();
      });
      card.addEventListener('dragover', e => {
        e.preventDefault();
        e.stopPropagation();
        if (card !== dragCard && card.classList.contains('seq-step-card')) {
          list.querySelectorAll('.drag-over').forEach(c => c.classList.remove('drag-over'));
          card.classList.add('drag-over');
        }
      });
      card.addEventListener('dragleave', e => {
        card.classList.remove('drag-over');
        e.stopPropagation();
      });
      card.addEventListener('drop', async e => {
        e.preventDefault();
        e.stopPropagation();
        card.classList.remove('drag-over');
        if (!dragCard || dragCard === card) return;
        const ordered_ids = [...list.querySelectorAll('.seq-step-card')].map(c => c.dataset.stepId);
        const fromIdx = ordered_ids.indexOf(dragCard.dataset.stepId);
        const toIdx = ordered_ids.indexOf(card.dataset.stepId);
        ordered_ids.splice(fromIdx, 1);
        ordered_ids.splice(toIdx, 0, dragCard.dataset.stepId);
        await fetch(`/api/sequences/${sequenceId}/steps/reorder`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ordered_ids }),
        });
        renderSequenceTab(_currentCampaignId());
      });
    });
  }

  function _currentCampaignId() {
    const match = location.hash.match(/campaign-detail\?id=([^&]+)/);
    return match ? match[1] : null;
  }

  async function createSequence(campaignId) {
    await fetch('/api/sequences', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ campaign_id: campaignId }) });
    renderSequenceTab(campaignId);
  }

  async function createNewVersion(campaignId, currentVersion) {
    document.getElementById('bulkConfirmModal')?.remove();
    const modal = document.createElement('div');
    modal.id = 'bulkConfirmModal';
    modal.className = 'modal-overlay';
    modal.innerHTML = `<div class="modal-box" style="max-width:440px">
      <h3 style="margin:0 0 12px">⚠️ Nouvelle version de séquence</h3>
      <p>Cette action créera la <strong>version ${currentVersion + 1}</strong>.</p>
      <p class="text-sm text-muted">Les prospects en cours continueront sur la v${currentVersion}. Les nouveaux suivront la v${currentVersion + 1}.</p>
      <div class="modal-actions"><button class="btn btn-outline" onclick="document.getElementById('bulkConfirmModal').remove()">Annuler</button><button class="btn btn-primary" id="confirmNewVersion">Créer la v${currentVersion + 1}</button></div>
    </div>`;
    document.body.appendChild(modal);
    modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
    document.getElementById('confirmNewVersion').addEventListener('click', async () => {
      modal.remove();
      _seqActiveStepId = null;
      await fetch('/api/sequences', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ campaign_id: campaignId }) });
      renderSequenceTab(campaignId);
    });
  }

  async function updateSequenceName(seqId, name) {
    if (!name.trim()) return;
    await fetch(`/api/sequences/${seqId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name.trim() }) });
  }

  async function addStep(sequenceId, type) {
    const body = { type, delay_days: type === 'send_message' ? 1 : 0 };
    if (type === 'send_message') { body.message_mode = 'ai_generated'; body.message_label = ''; }
    const resp = await fetch(`/api/sequences/${sequenceId}/steps`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const result = await resp.json();
    if (resp.ok) {
      _seqActiveStepId = result.id;
      renderSequenceTab(_currentCampaignId());
    } else {
      UI.toast(result.error || 'Erreur');
    }
  }

  async function deleteStep(sequenceId, stepId) {
    if (!confirm('Supprimer cette étape ?')) return;
    if (_seqActiveStepId === stepId) _seqActiveStepId = null;
    await fetch(`/api/sequences/${sequenceId}/steps/${stepId}`, { method: 'DELETE' });
    renderSequenceTab(_currentCampaignId());
  }

  function _onStepTypeChange() {} // no longer needed in split panel

  function _switchMsgTab(tab) {
    const manualZone = document.getElementById('msgTabManual');
    const aiZone = document.getElementById('msgTabAI');

    if (tab === 'manual') {
      if (manualZone) {
        manualZone.style.display = 'block';
        manualZone.classList.remove('msg-zone-inactive');
        manualZone.classList.add('msg-zone-active');
      }
      if (aiZone) {
        aiZone.style.display = 'none';
        aiZone.classList.remove('msg-zone-active');
        aiZone.classList.add('msg-zone-inactive');
      }
    } else {
      if (aiZone) {
        aiZone.style.display = 'block';
        aiZone.classList.remove('msg-zone-inactive');
        aiZone.classList.add('msg-zone-active');
      }
      if (manualZone) {
        manualZone.style.display = 'none';
        manualZone.classList.remove('msg-zone-active');
        manualZone.classList.add('msg-zone-inactive');
      }
    }
  }

  function _updateCharCount() {
    const ta = document.getElementById('stepContent');
    const el = document.getElementById('charCount');
    if (ta && el) {
      el.textContent = ta.value.length;
    }

    const taAI = document.getElementById('aiResultContent');
    const elAI = document.getElementById('charCountAI');
    if (taAI && elAI) {
      elAI.textContent = taAI.value.length;
    }
  }

  function _toggleInvitationNote() {
    const hasNote = document.getElementById('cfgHasNote')?.checked || false;
    document.getElementById('invitationNotePanel').style.display = hasNote ? 'block' : 'none';
    document.getElementById('invitationNoNotePanel').style.display = hasNote ? 'none' : 'block';
  }

  function _updateNoteCharCount() {
    const ta = document.getElementById('cfgNoteContent');
    const el = document.getElementById('noteCharCount');
    const warning = document.getElementById('noteWarning');
    if (ta && el) {
      el.textContent = ta.value.length;
      if (warning) warning.style.display = ta.value.length > 300 ? 'block' : 'none';
    }
  }

  async function _saveStepConfig(sequenceId, stepId) {
    const delay_days = parseInt(document.getElementById('cfgDelay')?.value) || 0;

    const body = { delay_days };

    // Check if this is a send_invitation step (has note panel)
    const hasNoteCheckbox = document.getElementById('cfgHasNote');
    if (hasNoteCheckbox) {
      body.message_label = document.getElementById('cfgLabel')?.value || 'Invitation LinkedIn';
      body.has_note = hasNoteCheckbox.checked;
      if (hasNoteCheckbox.checked) {
        const noteContent = document.getElementById('cfgNoteContent')?.value || '';
        if (noteContent.length > 300) {
          UI.toast('Note trop longue (max 300 caractères LinkedIn)');
          return;
        }
        body.note_content = noteContent;
      } else {
        body.note_content = null;
      }
    }

    // Message step — save params (Claude generates full message at execution)
    const angleEl = document.getElementById('aiAngle');
    if (angleEl) {
      body.message_mode = 'ai_generated';
      body.message_params = {
        angle: angleEl.value || 'problème',
        tone: document.getElementById('aiTone')?.value || 'conversationnel',
        objective: document.getElementById('aiObjective')?.value || '',
        context: document.getElementById('aiContext')?.value || '',
        max_chars: parseInt(document.getElementById('aiMaxChars')?.value) || 300,
        instructions: document.getElementById('aiInstructions')?.value || '',
      };

      if (delay_days < 1) {
        UI.toast('Délai minimum 1 jour pour un message');
        return;
      }
    }

    const res = await fetch(`/api/sequences/${sequenceId}/steps/${stepId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error('Erreur PUT step:', err);
      UI.toast('Erreur lors de la sauvegarde : ' + (err || res.statusText));
      return;
    }

    UI.toast('Étape sauvegardée');
    _seqCache = null; // Invalidate cache
    renderSequenceTab(_currentCampaignId());
  }

  // ============================================================
  // REVIEW TAB
  // ============================================================

  async function renderReviewTab(campaignId) {
    const el = document.getElementById('campaignTabContent');
    if (!el) return;
    el.innerHTML = UI.loader();

    const allProspects = await DB.getProspects({ campaign_id: campaignId });

    // Split into actionable groups
    const toReview = allProspects.filter(p => p.status === 'Message à valider' && p.pending_message);
    const reviewed = allProspects.filter(p => p.status === 'Message à envoyer');
    const stuck = allProspects.filter(p => p.status === 'Message à valider' && !p.pending_message);
    const totalActionable = toReview.length + reviewed.length;

    // Update badge on Review tab
    const tabBtn = document.getElementById('tabBtnReview');
    if (tabBtn) {
      tabBtn.innerHTML = toReview.length > 0
        ? `Review <span class="tab-badge">${toReview.length}</span>`
        : 'Review';
    }

    // Progress bar
    const progressPct = totalActionable > 0 ? Math.round((reviewed.length / totalActionable) * 100) : 100;

    // Render prospect item helper
    function _reviewItem(p, type) {
      const dotCls = type === 'to-review' ? 'review-dot-orange' : 'review-dot-green';
      return `<div class="review-prospect-item" data-id="${p.id}" data-type="${type}" onclick="App._selectReviewProspect('${p.id}', '${campaignId}')">
        <div class="review-item-row">
          <div>
            <strong>${UI.esc(p.first_name)} ${UI.esc(p.last_name)}</strong>
            <span class="text-sm text-muted">${UI.esc(p.company || '')}</span>
          </div>
          <span class="review-dot ${dotCls}"></span>
        </div>
      </div>`;
    }

    const hasWork = totalActionable > 0;
    const firstProspect = toReview[0] || reviewed[0];

    el.innerHTML = `
      ${hasWork ? `<div class="review-progress-card mt-6">
        <div class="review-progress-header">
          <span>${toReview.length} message${toReview.length !== 1 ? 's' : ''} à valider</span>
          <span class="text-sm text-muted">${reviewed.length}/${totalActionable} validé${reviewed.length !== 1 ? 's' : ''}</span>
        </div>
        <div class="review-progress-bar"><div class="review-progress-fill" style="width:${progressPct}%"></div></div>
      </div>` : ''}
      <div class="seq-split${hasWork ? '' : ' mt-6'}">
        <div class="seq-left">
          <div class="search-wrap" style="margin-bottom:10px">
            <svg class="search-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2"><circle cx="8.5" cy="8.5" r="5.5"/><line x1="13.5" y1="13.5" x2="18" y2="18"/></svg>
            <input id="reviewSearch" placeholder="Rechercher…" oninput="App._filterReviewList()">
          </div>
          <div id="reviewList" class="review-prospect-list">
            ${toReview.length > 0 ? `
              <div class="review-section-label">À valider</div>
              ${toReview.map(p => _reviewItem(p, 'to-review')).join('')}
            ` : ''}
            ${reviewed.length > 0 ? `
              <div class="review-section-label review-section-done">Validés — en attente d'envoi</div>
              ${reviewed.map(p => _reviewItem(p, 'reviewed')).join('')}
            ` : ''}
            ${stuck.length > 0 ? `
              <div class="review-section-label" style="color:var(--color-text-muted)">Statut incorrect — sans message</div>
              ${stuck.map(p => `<div class="review-prospect-item" data-id="${p.id}" style="opacity:0.6">
                <div class="review-item-row">
                  <div>
                    <strong>${UI.esc(p.first_name)} ${UI.esc(p.last_name)}</strong>
                    <span class="text-sm text-muted">${UI.esc(p.company || '')}</span>
                  </div>
                  <button class="btn btn-ghost btn-sm" style="font-size:11px;padding:2px 6px" onclick="event.stopPropagation();App._resetStuckProspect('${p.id}', '${campaignId}')">Reset</button>
                </div>
              </div>`).join('')}
            ` : ''}
            ${totalActionable === 0 && stuck.length === 0 ? '<div class="review-empty">Aucun message en attente de validation</div>' : ''}
          </div>
        </div>
        <div class="seq-right" id="reviewPreview">${firstProspect ? UI.loader() : ''}</div>
      </div>`;

    if (firstProspect) _selectReviewProspect(firstProspect.id, campaignId);
  }

  async function _selectReviewProspect(prospectId, campaignId) {
    document.querySelectorAll('.review-prospect-item').forEach(el => el.classList.remove('review-active'));
    document.querySelector(`.review-prospect-item[data-id="${prospectId}"]`)?.classList.add('review-active');

    const panel = document.getElementById('reviewPreview');
    if (!panel) return;
    panel.innerHTML = UI.loader();

    const resp = await fetch(`/api/sequences/preview?campaign_id=${campaignId}&prospect_id=${prospectId}`);
    const data = await resp.json();

    if (!data.steps?.length) {
      panel.innerHTML = '<div class="text-sm text-muted" style="padding:30px;text-align:center">Aucune séquence active</div>';
      return;
    }

    const prospect = document.querySelector(`.review-prospect-item[data-id="${prospectId}"]`);
    const name = prospect?.querySelector('strong')?.textContent || '';
    const seqState = data.sequence_state || null;
    const sentMessages = data.sent_messages || [];
    // Index sent messages by step_order for exact matching; fallback queue for legacy (no step_order)
    const sentByStep = {};
    const sentFallback = [];
    for (const m of sentMessages) {
      if (m.step_order != null) sentByStep[m.step_order] = m;
      else sentFallback.push(m);
    }
    let fallbackIdx = 0;

    // Helper: render status banner
    function _seqBanner(state, steps) {
      if (!state) return `<div class="seq-status-banner seq-not-started">Pas encore démarré</div>`;
      const { status, current_step_order, next_action_at, enrolled_at } = state;
      if (status === 'active') {
        const daysUntil = Math.ceil((new Date(next_action_at) - Date.now()) / 86400000);
        const nextStep = steps.find(s => s.step_order === current_step_order);
        const nextLabel = nextStep ? (nextStep.message_label || STEP_TYPES[nextStep.type]?.label || nextStep.type) : '';
        return `<div class="seq-status-banner seq-active">
          <strong>En cours — Étape ${current_step_order}/${steps.length}</strong>
          <div>Prochaine action : ${UI.esc(nextLabel)} — ${daysUntil <= 0 ? 'maintenant' : 'dans ' + daysUntil + ' jour' + (daysUntil > 1 ? 's' : '')} (le ${UI.formatDate(next_action_at)})</div>
        </div>`;
      }
      if (status === 'stopped_reply') return `<div class="seq-status-banner seq-stopped">⛔ Séquence arrêtée — réponse reçue</div>`;
      if (status === 'completed') return `<div class="seq-status-banner seq-completed">✅ Séquence terminée</div>`;
      if (status === 'paused') return `<div class="seq-status-banner seq-paused">⏸️ Mise en pause</div>`;
      return '';
    }

    // Helper: step state class
    function _stepStateCls(stepOrder, state) {
      if (!state || state.status === 'stopped_reply') return 'step-locked';
      if (state.status === 'completed') return 'step-done';
      if (stepOrder < state.current_step_order) return 'step-done';
      if (stepOrder === state.current_step_order) return 'step-active';
      return 'step-locked';
    }

    // Helper: step icon
    function _stepIcon(stepOrder, state) {
      if (!state) return '🔒';
      if (state.status === 'stopped_reply') return '⛔';
      if (state.status === 'completed') return '✓';
      if (stepOrder < state.current_step_order) return '✓';
      if (stepOrder === state.current_step_order) return '⏳';
      return '🔒';
    }

    // Fetch prospect's pending_message and status
    const paResp = await fetch(`/api/prospector/prospects?campaign_id=${campaignId}`);
    const allProspects = await paResp.json();
    const prospectData = allProspects.find(p => p.id === prospectId) || {};
    const prospectStatus = prospectData.status || '';
    const pendingMsg = prospectData.pending_message || '';
    const isEditable = !!pendingMsg || ['Message à valider', 'Message à envoyer'].includes(prospectStatus);
    const needsValidation = !!pendingMsg && prospectStatus !== 'Message à envoyer';

    // Build prospect info card
    const jobTitle = prospectData.job_title || '';
    const company = prospectData.company || '';
    const sector = prospectData.sector || '';
    const geography = prospectData.geography || '';
    const notes = prospectData.notes || '';
    const mainParts = [jobTitle, company].filter(Boolean);
    const metaParts = [sector, geography].filter(Boolean);
    const prospectCardHtml = (mainParts.length || metaParts.length || notes) ? `
      <div class="review-prospect-card">
        ${mainParts.length ? `<div class="review-prospect-main">${mainParts.map(UI.esc).join(' · ')}</div>` : ''}
        ${metaParts.length ? `<div class="review-prospect-meta">${metaParts.map(UI.esc).join(' · ')}</div>` : ''}
        ${notes ? `<div class="review-prospect-notes">${UI.esc(notes)}</div>` : ''}
      </div>` : '';

    panel.innerHTML = `
      <div class="seq-config-inner">
        <h3>Prévisualisation pour ${UI.esc(name)}</h3>
        ${prospectCardHtml}
        ${_seqBanner(seqState, data.steps)}
        ${data.steps.map((s, i) => {
          const meta = STEP_TYPES[s.type] || { icon: '❓', label: s.type };
          const label = s.message_label || meta.label;
          const stepOrder = s.step_order || (i + 1);
          const icon = _stepIcon(stepOrder, seqState);
          const cls = _stepStateCls(stepOrder, seqState);
          const delayHtml = i > 0 ? `<div class="review-delay">${s.delay_days === 0 ? 'Immédiatement' : `Attendre ${s.delay_days} jour${s.delay_days > 1 ? 's' : ''}`}</div>` : '';

          let contentHtml = '';
          const isStepDone = cls === 'step-done';
          if (s.type === 'send_message') {
            const sentForStep = sentByStep[stepOrder] || (isStepDone && fallbackIdx < sentFallback.length ? sentFallback[fallbackIdx++] : null);
            if (isStepDone && sentForStep) {
              // Step completed — show the sent message
              const sent = sentForStep;
              contentHtml = `
                <div class="review-msg-preview" style="border-left:3px solid var(--color-success, #16a34a);padding-left:12px;opacity:0.85">
                  <div style="font-size:11px;color:var(--color-text-muted);margin-bottom:4px">Envoyé le ${UI.formatDate(sent.date)}</div>
                  ${UI.esc(sent.content)}
                </div>`;
            } else if (pendingMsg && stepOrder === (seqState?.current_step_order || 0)) {
              // Message already generated — show it with edit/regen options
              contentHtml = `
                <div class="review-msg-preview" id="reviewMsgPreview">${UI.esc(pendingMsg)}</div>
                ${isEditable ? `
                  <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">
                    ${needsValidation ? `<button class="btn btn-primary btn-sm" onclick="App._validateReviewMessage('${prospectId}', '${campaignId}')">✓ Valider</button>` : ''}
                    <button class="btn btn-outline btn-sm" onclick="App._editReviewMessage('${prospectId}')">Modifier</button>
                    <button class="btn btn-outline btn-sm" id="btnReviewRegen" onclick="App._regenReviewMessage('${prospectId}', '${campaignId}')">Regénérer</button>
                  </div>
                  <div id="reviewEditPanel" style="display:none;margin-top:10px">
                    <textarea id="reviewEditText" class="msg-textarea" rows="5">${UI.esc(pendingMsg)}</textarea>
                    <div style="display:flex;gap:8px;margin-top:8px">
                      <button class="btn btn-primary btn-sm" onclick="App._saveReviewMessage('${prospectId}', '${campaignId}')">Enregistrer</button>
                      <button class="btn btn-ghost btn-sm" onclick="document.getElementById('reviewEditPanel').style.display='none'">Annuler</button>
                    </div>
                  </div>
                  <div id="reviewRegenPanel" style="display:none;margin-top:10px">
                    <textarea id="reviewRegenInstructions" class="msg-textarea" rows="2" placeholder="Instructions pour Claude (ex: ton plus direct, mentionner la CSRD...)"></textarea>
                    <div style="display:flex;gap:8px;margin-top:8px">
                      <button class="btn btn-primary btn-sm" id="btnRegenConfirm" onclick="App._confirmRegenReview('${prospectId}', '${campaignId}', ${stepOrder})">Regénérer</button>
                      <button class="btn btn-ghost btn-sm" onclick="document.getElementById('reviewRegenPanel').style.display='none'">Annuler</button>
                    </div>
                  </div>
                ` : ''}`;
            } else if (s.message_preview) {
              contentHtml = `<div class="review-msg-preview">${UI.esc(s.message_preview).replace(/⚠️\{\{(\w+)\}\}/g, '<span class="ph-missing">{{$1}}</span>')}</div>`;
            } else {
              const params = s.message_params || {};
              contentHtml = `<div class="review-msg-preview" style="color:var(--color-text-muted);font-style:italic">
                Le message sera généré par Claude au moment de l'exécution.<br>
                Paramètres : ${params.angle || 'problème'} / ${params.tone || 'conversationnel'}${params.max_chars ? ' / max ' + params.max_chars + ' car.' : ''}
              </div>`;
            }
          } else if (s.type === 'send_invitation') {
            if (s.has_note && s.note_content) {
              contentHtml = `<div class="review-msg-preview">${UI.esc(s.note_content)}</div>`;
            }
          }

          return `${delayHtml}<div class="review-step ${cls}"><div class="review-step-header">${icon} Etape ${stepOrder} — ${UI.esc(label)}</div>${contentHtml}</div>`;
        }).join('')}
      </div>`;
  }

  function _editReviewMessage(_prospectId) {
    document.getElementById('reviewEditPanel').style.display = 'block';
    document.getElementById('reviewRegenPanel').style.display = 'none';
  }

  function _regenReviewMessage(_prospectId, _campaignId) {
    document.getElementById('reviewRegenPanel').style.display = 'block';
    document.getElementById('reviewEditPanel').style.display = 'none';
  }

  async function _validateReviewMessage(prospectId, campaignId) {
    try {
      const r = await fetch('/api/prospector/update-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: prospectId, status: 'Message à envoyer' })
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      UI.toast('Message validé — sera envoyé au prochain passage');
      await renderReviewTab(campaignId);
    } catch (err) {
      UI.toast('Erreur: ' + err.message, 'error');
    }
  }

  async function _resetStuckProspect(prospectId, campaignId) {
    try {
      const r = await fetch('/api/prospector/update-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: prospectId, status: 'Invitation acceptée' })
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      UI.toast('Statut réinitialisé — "Invitation acceptée"');
      await renderReviewTab(campaignId);
    } catch (err) {
      UI.toast('Erreur: ' + err.message, 'error');
    }
  }

  async function _rejectReviewMessage(prospectId, campaignId, targetStatus) {
    const status = targetStatus || 'Invitation acceptée';
    try {
      const r = await fetch('/api/prospector/update-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: prospectId, status, pending_message: null })
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      UI.toast(`Message annulé — prospect remis en "${status}"`);
      await renderReviewTab(campaignId);
    } catch (err) {
      UI.toast('Erreur: ' + err.message, 'error');
    }
  }

  async function _saveReviewMessage(prospectId, campaignId) {
    const text = document.getElementById('reviewEditText')?.value || '';
    try {
      await fetch('/api/prospector/update-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: prospectId, status: 'Message à valider', pending_message: text })
      });
      UI.toast('Message modifié');
      _selectReviewProspect(prospectId, campaignId);
    } catch (err) {
      UI.toast('Erreur: ' + err.message, 'error');
    }
  }

  async function _confirmRegenReview(prospectId, campaignId, stepOrder) {
    const btn = document.getElementById('btnRegenConfirm');
    if (btn) { btn.disabled = true; btn.textContent = 'Génération...'; }

    const instructions = document.getElementById('reviewRegenInstructions')?.value || '';

    // Get the sequence step params for this campaign
    let stepParams = {};
    try {
      const seqResp = await fetch(`/api/sequences?campaign_id=${campaignId}`);
      const seq = await seqResp.json();
      if (seq) {
        const msgStep = (seq.sequence_steps || []).find(s => s.step_order === stepOrder) || (seq.sequence_steps || []).find(s => s.type === 'send_message');
        if (msgStep) stepParams = msgStep.message_params || {};
      }
    } catch(e) {}

    // Get prospect data
    let prospect = {};
    try {
      const pResp = await fetch(`/api/prospector/prospects?campaign_id=${campaignId}`);
      const all = await pResp.json();
      prospect = all.find(p => p.id === prospectId) || {};
    } catch(e) {}

    // Get icebreaker
    let icebreaker = null;
    try {
      const actResp = await APIClient.get(`/api/prospects/${prospectId}/linkedin-activity`);
      const act = await actResp.json();
      if (act?.icebreaker_generated) icebreaker = act.icebreaker_generated;
    } catch(e) {}

    // Get campaign
    let campaign = {};
    try { campaign = await DB.getCampaign(campaignId); } catch(e) {}

    try {
      const resp = await APIClient.post('/api/sequences/generate-message', {
        campaign,
        message_params: stepParams,
        prospect: { first_name: prospect.first_name, last_name: prospect.last_name, job_title: prospect.job_title, company: prospect.company },
        icebreaker,
        regen_instructions: instructions,
      });
      const result = await resp.json();

      if (result.content) {
        // Save as pending message
        await fetch('/api/prospector/update-status', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: prospectId, status: 'Message à valider', pending_message: result.content })
        });
        UI.toast('Message regénéré');
        _selectReviewProspect(prospectId, campaignId);
      } else {
        UI.toast(result.error || 'Erreur', 'error');
      }
    } catch (err) {
      UI.toast('Erreur: ' + err.message, 'error');
    }
    if (btn) { btn.disabled = false; btn.textContent = 'Regénérer'; }
  }

  function _changeDashPeriod(preset) {
    _currentDashPeriod = preset;
    _refreshDashboardStats();
  }

  function _filterReviewList() {
    const q = (document.getElementById('reviewSearch')?.value || '').toLowerCase();
    document.querySelectorAll('.review-prospect-item').forEach(el => {
      el.style.display = el.textContent.toLowerCase().includes(q) ? '' : 'none';
    });
  }

  // ============================================================
  // PLACEHOLDERS PAGE
  // ============================================================

  async function renderPlaceholders(container) {
    container.innerHTML = UI.loader();
    const resp = await fetch('/api/placeholders');
    const placeholders = await resp.json();
    _placeholdersCache = placeholders;

    container.innerHTML = `
      <div class="page-header">
        <h1 class="page-title" style="margin-bottom:0">Bibliothèque de placeholders</h1>
        <button class="btn btn-primary" onclick="App.openAddPlaceholder()">+ Ajouter un placeholder</button>
      </div>
      <div class="card">
        <div class="table-wrap">
          <table><thead><tr><th>Syntaxe</th><th>Libellé</th><th>Description</th><th>Source</th><th></th></tr></thead>
          <tbody>
          ${placeholders.map(ph => `<tr>
            <td><code>{{${UI.esc(ph.key)}}}</code></td>
            <td>${UI.esc(ph.label)}</td>
            <td class="text-sm text-muted">${UI.esc(ph.description || '—')}</td>
            <td><span class="badge badge-type">${UI.esc(ph.source)}</span>${ph.is_system ? ' 🔒' : ''}</td>
            <td class="action-btns">${ph.is_system ? '' : `<button class="btn-icon" onclick="App.deletePlaceholder('${ph.id}')" title="Supprimer">🗑️</button>`}</td>
          </tr>`).join('')}
          </tbody></table>
        </div>
      </div>`;
  }

  function openAddPlaceholder() {
    document.getElementById('phModal')?.remove();
    const modal = document.createElement('div');
    modal.id = 'phModal';
    modal.className = 'modal-overlay';
    modal.style.display = 'flex';
    modal.innerHTML = `<div class="modal-box" style="max-width:440px">
      <h3 style="margin:0 0 16px">Ajouter un placeholder</h3>
      <div class="form-group"><label>Clé (sans accolades)</label><input id="phKey" placeholder="ma_cle" oninput="document.getElementById('phPreview').textContent='Syntaxe : {{'+this.value+'}}'"><div id="phPreview" class="text-sm text-muted" style="margin-top:4px">Syntaxe : {{}}</div></div>
      <div class="form-group"><label>Libellé</label><input id="phLabel" placeholder="Nom affiché dans l'éditeur"></div>
      <div class="form-group"><label>Description (optionnel)</label><input id="phDesc" placeholder="Explication…"></div>
      <div id="phError" style="display:none;color:#EF4444;font-size:13px;margin-bottom:8px"></div>
      <div class="modal-actions"><button class="btn btn-outline" onclick="document.getElementById('phModal').remove()">Annuler</button><button class="btn btn-primary" onclick="App.savePlaceholder()">Créer</button></div>
    </div>`;
    document.body.appendChild(modal);
    modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
  }

  async function savePlaceholder() {
    const key = document.getElementById('phKey')?.value?.trim();
    const label = document.getElementById('phLabel')?.value?.trim();
    const description = document.getElementById('phDesc')?.value?.trim();
    const errEl = document.getElementById('phError');

    if (!key || !label) { errEl.textContent = 'Clé et libellé requis'; errEl.style.display = 'block'; return; }
    if (!/^[a-z0-9_]+$/.test(key)) { errEl.textContent = 'Clé : uniquement lettres minuscules, chiffres et underscores'; errEl.style.display = 'block'; return; }

    const resp = await fetch('/api/placeholders', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, label, description }),
    });
    if (resp.ok) {
      document.getElementById('phModal')?.remove();
      _placeholdersCache = null;
      renderPlaceholders(document.getElementById('app'));
    } else {
      const err = await resp.json();
      errEl.textContent = err.error || 'Erreur';
      errEl.style.display = 'block';
    }
  }

  async function deletePlaceholder(id) {
    if (!confirm('Supprimer ce placeholder ?')) return;
    await fetch(`/api/placeholders/${id}`, { method: 'DELETE' });
    _placeholdersCache = null;
    renderPlaceholders(document.getElementById('app'));
  }

  // ============================================================
  // IMPORTS
  // ============================================================
  let _importState = { step: 1, rawData: null, headers: [], mapping: {}, parsed: [], duplicates: [], file: null };

  function renderImports(container) {
    _importState = { step: 1, rawData: null, headers: [], mapping: {}, parsed: [], duplicates: [], file: null };
    renderImportStep(container);
  }

  function renderImportStep(container) {
    const s = _importState;
    container.innerHTML = `
      <h1 class="page-title">Centre d'import</h1>
      <div class="stepper">
        ${[1,2,3,4].map((n,i) => `
          <span class="step ${n === s.step ? 'active' : n < s.step ? 'done' : ''}">${n}. ${['Upload','Mapping','Aperçu','Terminé'][i]}</span>
          ${n < 4 ? '<span class="step-arrow">→</span>' : ''}
        `).join('')}
      </div>
      <div class="card" id="importContent"></div>
    `;

    const el = document.getElementById('importContent');
    switch (s.step) {
      case 1: renderImportUpload(el); break;
      case 2: renderImportMapping(el); break;
      case 3: renderImportPreview(el); break;
      case 4: renderImportDone(el); break;
    }
  }

  function renderImportUpload(el) {
    el.innerHTML = `
      <div class="dropzone" id="dropzone">
        <div class="dropzone-icon">↑</div>
        <div class="dropzone-text">Glissez-déposez votre fichier ici</div>
        <div class="dropzone-sub">Formats acceptés : CSV, JSON</div>
        <button class="btn btn-primary" onclick="document.getElementById('fileInput').click()">📁 Choisir un fichier</button>
        <input type="file" id="fileInput" accept=".csv,.json" style="display:none" onchange="App.handleImportFile(this.files[0])">
      </div>
    `;
    const dz = document.getElementById('dropzone');
    dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('dragover'); });
    dz.addEventListener('dragleave', () => dz.classList.remove('dragover'));
    dz.addEventListener('drop', e => { e.preventDefault(); dz.classList.remove('dragover'); if (e.dataTransfer.files[0]) handleImportFile(e.dataTransfer.files[0]); });
  }

  function handleImportFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = e => {
      const text = e.target.result;
      _importState.file = file;
      if (file.name.endsWith('.json')) {
        try {
          const json = JSON.parse(text);
          const rows = Array.isArray(json) ? json : json.prospects || [];
          _importState.headers = Object.keys(rows[0] || {});
          _importState.rawData = rows;
        } catch { UI.toast('Fichier JSON invalide', 'error'); return; }
      } else {
        // CSV
        const lines = text.split('\n').filter(l => l.trim());
        if (lines.length < 2) { UI.toast('Fichier CSV vide', 'error'); return; }
        const sep = lines[0].includes(';') ? ';' : ',';
        _importState.headers = lines[0].split(sep).map(h => h.trim().replace(/^"|"$/g, ''));
        _importState.rawData = lines.slice(1).map(line => {
          const vals = line.split(sep).map(v => v.trim().replace(/^"|"$/g, ''));
          const obj = {};
          _importState.headers.forEach((h, i) => { obj[h] = vals[i] || ''; });
          return obj;
        });
      }
      _importState.step = 2;
      renderImportStep(document.getElementById('app'));
    };
    reader.readAsText(file);
  }

  const IMPORT_FIELDS = [
    { key: 'first_name', label: 'Prénom' },
    { key: 'last_name', label: 'Nom' },
    { key: 'email', label: 'Email' },
    { key: 'phone', label: 'Téléphone' },
    { key: 'linkedin_url', label: 'LinkedIn URL' },
    { key: 'company', label: 'Entreprise' },
    { key: 'job_title', label: 'Poste' },
    { key: 'sector', label: 'Secteur' },
    { key: 'geography', label: 'Région' },
  ];

  function renderImportMapping(el) {
    // Auto-map by matching names
    const mapping = {};
    for (const f of IMPORT_FIELDS) {
      const match = _importState.headers.find(h => h.toLowerCase().replace(/[_\s-]/g, '') === f.key.toLowerCase().replace(/[_\s-]/g, ''));
      if (match) mapping[f.key] = match;
    }
    _importState.mapping = mapping;

    const sample = _importState.rawData[0] || {};

    el.innerHTML = `
      <h3 style="margin-bottom:16px">Mapping des colonnes</h3>
      <table class="mapping-table">
        <thead><tr><th>Champ</th><th>Colonne source</th><th>Aperçu</th></tr></thead>
        <tbody>
        ${IMPORT_FIELDS.map(f => `
          <tr>
            <td><strong>${f.label}</strong></td>
            <td><select onchange="App.setMapping('${f.key}', this.value)">
              <option value="">— Ignorer —</option>
              ${_importState.headers.map(h => `<option value="${UI.esc(h)}" ${mapping[f.key] === h ? 'selected' : ''}>${UI.esc(h)}</option>`).join('')}
            </select></td>
            <td class="mapping-preview">${mapping[f.key] ? UI.esc(sample[mapping[f.key]] || '') : '—'}</td>
          </tr>
        `).join('')}
        </tbody>
      </table>
      <div class="form-actions">
        <button class="btn btn-outline" onclick="App.importBack()">Retour</button>
        <button class="btn btn-primary" onclick="App.importNext()">Suivant</button>
      </div>
    `;
  }

  function setMapping(field, col) {
    if (col) _importState.mapping[field] = col;
    else delete _importState.mapping[field];
  }

  function importBack() {
    _importState.step = Math.max(1, _importState.step - 1);
    renderImportStep(document.getElementById('app'));
  }

  async function importNext() {
    if (_importState.step === 2) {
      // Build parsed
      const m = _importState.mapping;
      _importState.parsed = _importState.rawData.map(row => {
        const p = {};
        for (const f of IMPORT_FIELDS) {
          if (m[f.key]) p[f.key] = row[m[f.key]] || '';
        }
        return p;
      }).filter(p => p.first_name || p.last_name);

      // Check duplicates
      const existing = await DB.getProspects();
      _importState.duplicates = [];
      for (let i = 0; i < _importState.parsed.length; i++) {
        const p = _importState.parsed[i];
        const isDupe = existing.some(e =>
          (p.email && e.email && p.email.toLowerCase() === e.email.toLowerCase()) ||
          (p.linkedin_url && e.linkedin_url && p.linkedin_url === e.linkedin_url) ||
          (p.first_name && p.last_name && e.first_name.toLowerCase() === p.first_name.toLowerCase() && e.last_name.toLowerCase() === p.last_name.toLowerCase())
        );
        if (isDupe) _importState.duplicates.push(i);
      }

      _importState.step = 3;
      renderImportStep(document.getElementById('app'));
    }
  }

  function renderImportPreview(el) {
    const { parsed, duplicates } = _importState;
    const preview = parsed.slice(0, 10);

    el.innerHTML = `
      <h3 style="margin-bottom:16px">Aperçu (${parsed.length} lignes)</h3>
      <div class="table-wrap">
        <table><thead><tr>${IMPORT_FIELDS.map(f => `<th>${f.label}</th>`).join('')}<th></th></tr></thead>
        <tbody>${preview.map((p, i) => {
          const isDupe = duplicates.includes(i);
          return `<tr style="${isDupe ? 'background:#FEF3C7' : ''}">
            ${IMPORT_FIELDS.map(f => `<td class="text-sm">${UI.esc(p[f.key] || '')}</td>`).join('')}
            <td>${isDupe ? '<span class="badge badge-today">Doublon</span>' : ''}</td>
          </tr>`;
        }).join('')}</tbody></table>
      </div>
      ${duplicates.length > 0 ? `
        <div class="duplicate-banner mt-4">⚠️ ${duplicates.length} doublon(s) détecté(s)</div>
        <div class="flex gap-2 mt-4">
          <label><input type="radio" name="dupeAction" value="skip" checked> Ignorer les doublons</label>
          <label style="margin-left:16px"><input type="radio" name="dupeAction" value="update"> Mettre à jour les existants</label>
        </div>
      ` : ''}
      <div class="form-actions">
        <button class="btn btn-outline" onclick="App.importBack()">Retour</button>
        <button class="btn btn-primary" id="btnLaunchImport" onclick="App.launchImport()">Lancer l'import</button>
      </div>
    `;
  }

  async function launchImport() {
    const btn = document.getElementById('btnLaunchImport');
    btn.disabled = true;
    btn.textContent = 'Import en cours...';

    const { parsed, duplicates } = _importState;
    const dupeAction = document.querySelector('input[name="dupeAction"]:checked')?.value || 'skip';

    let imported = 0, skipped = 0, errors = 0;

    const toInsert = [];
    for (let i = 0; i < parsed.length; i++) {
      if (duplicates.includes(i) && dupeAction === 'skip') { skipped++; continue; }
      toInsert.push(parsed[i]);
    }

    try {
      if (toInsert.length > 0) {
        await DB.bulkInsertProspects(toInsert);
        imported = toInsert.length;
      }
    } catch (err) {
      console.error('Import error:', err);
      errors = toInsert.length;
      imported = 0;
    }

    // Log import
    await DB.createImport({
      filename: _importState.file?.name || 'unknown',
      total_rows: parsed.length,
      imported, duplicates: skipped, errors,
    });

    _importState.result = { imported, skipped, errors, total: parsed.length };
    _importState.step = 4;
    renderImportStep(document.getElementById('app'));
  }

  function renderImportDone(el) {
    const r = _importState.result || {};
    el.innerHTML = `
      <div class="import-result">
        <div class="big-check">✅</div>
        <h2>Import terminé</h2>
        <div class="stat">${r.imported || 0} prospect(s) importé(s)</div>
        <div class="stat">${r.skipped || 0} doublon(s) ignoré(s)</div>
        ${r.errors > 0 ? `<div class="stat" style="color:var(--color-overdue)">${r.errors} erreur(s)</div>` : ''}
        <div class="mt-6">
          <button class="btn btn-primary" onclick="location.hash='#prospects'">Voir les prospects</button>
        </div>
      </div>
    `;
  }

  // ============================================================
  // INIT
  // ============================================================
  function init() {
    window.addEventListener('hashchange', router);

    // Handle anchor links with hash navigation (only for <a> tags, not buttons)
    document.addEventListener('click', (e) => {
      let link = e.target;
      // Walk up to find an <a> tag
      while (link && link.tagName !== 'A') {
        link = link.parentElement;
      }
      if (link && link.tagName === 'A') {
        const href = link.getAttribute('href');
        if (href?.startsWith('#')) {
          e.preventDefault();
          location.hash = href;
        }
      }
    }, true); // Use capture phase

    // Reload page when account changes (to refresh all data with new account_id header)
    document.addEventListener('account-changed', (e) => {
      console.log('Account changed to:', e.detail?.name);
      // Reload the current page to refresh all data
      router();
    });

    router();
  }

  // Note: init() is called explicitly from prospector.html AFTER account selection
  // to ensure accountContext is ready before making API calls

  return {
    init,
    handleAddProspect, handleEditProspect, handleAddCampaign, handleEditCampaign,
    handleAddInteraction, handleAddReminder,
    openAddProspect, openEditProspect, deleteProspect,
    openAddInteraction, openAddReminder, openAddCampaign, openEditCampaign,
    changeProspectStatus, saveProspectStatus, debounceNotes, selectMessageVersion, toggleRegenForm, regenerateMessages, validateMessage, rejectMessage, markNonPertinent,
    filterProspects, quickFilter, loadRappels, loadCampagnes,
    toggleSelect, toggleSelectAll, clearSelection, bulkValidate, bulkReject,
    quickValidate, quickReject,
    quickValidateInCampaign, quickRejectInCampaign,
    reminderDone, reminderSnooze,
    handleImportFile, setMapping, importBack, importNext, launchImport,
    switchCampTab, archiveCampaign,
    switchCampaignTab, createSequence, createNewVersion, updateSequenceName,
    addStep, deleteStep, selectStep, _switchMsgTab,
    _updateCharCount, _saveStepConfig, _insertPlaceholder,
    _toggleInvitationNote, _updateNoteCharCount,
    _changeDashPeriod,
    _selectReviewProspect, _filterReviewList, _editReviewMessage, _regenReviewMessage, _saveReviewMessage, _confirmRegenReview, _validateReviewMessage, _rejectReviewMessage, _resetStuckProspect,
    enrollProspect, enrollCampaign,
    openAddPlaceholder, savePlaceholder, deletePlaceholder,
    _filterCampByStatus,
  };
})();
