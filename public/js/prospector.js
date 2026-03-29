/* ============================================
   Releaf Prospector — Main Application Logic
   ============================================ */

const App = (() => {

  // ---- Router ----
  function router() {
    const hash = location.hash || '#dashboard';
    const [page, qs] = hash.split('?');
    const params = new URLSearchParams(qs || '');

    // Update navbar active
    document.querySelectorAll('.navbar-nav a').forEach(a => {
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
      case '#rappels':         renderRappels(app); break;
      case '#placeholders':    renderPlaceholders(app); break;
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
  async function renderDashboard(container) {
    container.innerHTML = `
      <h1 class="page-title">Dashboard</h1>
      <div class="stat-grid">
        <div class="stat-card"><span class="stat-icon">👥</span><div><div class="stat-value" id="statWeek">—</div><div class="stat-label">Prospects cette semaine</div></div></div>
        <div class="stat-card"><span class="stat-icon">📤</span><div><div class="stat-value" id="statTotal">—</div><div class="stat-label">Total prospects</div></div></div>
        <div class="stat-card"><span class="stat-icon">🕐</span><div><div class="stat-value" id="statReminders">—</div><div class="stat-label">Rappels en attente</div></div></div>
        <div class="stat-card"><span class="stat-icon">📈</span><div><div class="stat-value" id="statCampaigns">—</div><div class="stat-label">Campagnes actives</div></div></div>
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
    const [week, total, remCount, campCount, reminders, pipeline, activity, pendingMessages, profilsAValider, chartData] = await Promise.all([
      DB.getProspectsThisWeek(),
      DB.getTotalProspects(),
      DB.getPendingReminderCount(),
      DB.getActiveCampaignCount(),
      DB.getReminders({ status: 'pending' }),
      DB.getProspectCountsByStatus(),
      DB.getRecentInteractions(10),
      DB.getProspects({ status: 'Message à valider' }),
      DB.getProspects({ status: 'Profil à valider' }),
      fetch('/api/prospector/daily-activity').then(r => r.json()).catch(() => ({ dates: [], series: {} })),
    ]);

    // Load quotas
    fetch('/api/prospector/daily-stats').then(r => r.json()).then(stats => {
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

    document.getElementById('statWeek').textContent = week;
    document.getElementById('statTotal').textContent = total;
    document.getElementById('statReminders').textContent = remCount;
    document.getElementById('statCampaigns').textContent = campCount;

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
    document.getElementById('dashPipeline').innerHTML = statuses.map(s =>
      `<li class="pipeline-item" style="cursor:pointer" onclick="location.hash='#prospects?status=${encodeURIComponent(s)}'">${UI.statusBadge(s)} <span class="pipeline-count">${pipeline[s] || 0}</span></li>`
    ).join('');

    // Daily activity chart
    const FR_MONTHS = ['jan', 'fév', 'mar', 'avr', 'mai', 'juin', 'juil', 'aoû', 'sep', 'oct', 'nov', 'déc'];
    const fmtDate = iso => { const d = new Date(iso + 'T00:00:00'); return `${d.getDate()} ${FR_MONTHS[d.getMonth()]}`; };

    const ACTIVITY_SERIES = {
      prospect_validated:  { label: 'Profils validés',         color: '#8b5cf6' },
      invitation_sent:     { label: 'Invitations envoyées',    color: '#f59e0b' },
      invitation_accepted: { label: 'Invitations acceptées',   color: '#3b82f6' },
      message_sent:        { label: 'Messages envoyés',        color: '#10b981' },
      response_received:   { label: 'Réponses reçues',         color: '#ec4899' },
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
          <button class="btn btn-outline" onclick="location.hash='#imports'">Importer</button>
          <button class="btn btn-primary" onclick="App.openAddProspect()">+ Ajouter</button>
        </div>
      </div>
      <div class="quick-filters" id="quickFilters">
        <button class="qf-btn qf-active" data-filter="" onclick="App.quickFilter(this, '')">Tous <span class="qf-count" id="qfCount-all"></span></button>
        ${UI.STATUSES.map(s => {
          const isAValider = s === 'Profil à valider';
          const label = isAValider ? 'À valider' : s;
          return `<button class="qf-btn ${isAValider ? 'qf-active' : ''}" data-filter="${s}" onclick="App.quickFilter(this, '${s}')">${label} <span class="qf-count" id="qfCount-${s.replace(/\s/g, '_')}"></span></button>`;
        }).join('')}
      </div>
      <div class="filter-bar">
        <input id="filterSearch" placeholder="Rechercher nom, entreprise, fonction..." oninput="App.filterProspects()">
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
      statusSel.value = presetStatus;
      // Highlight the matching quick filter
      document.querySelectorAll('.qf-btn').forEach(b => b.classList.remove('qf-active'));
      const match = document.querySelector(`.qf-btn[data-filter="${presetStatus}"]`);
      if (match) match.classList.add('qf-active');
    }

    // Load counts for all quick filters
    loadQuickFilterCounts();

    filterProspects();
  }

  function quickFilter(btn, status) {
    document.querySelectorAll('.qf-btn').forEach(b => b.classList.remove('qf-active'));
    btn.classList.add('qf-active');
    const statusSel = document.getElementById('filterStatus');
    if (statusSel) statusSel.value = status;
    clearSelection();
    filterProspects();
  }

  const QF_COLORS = {
    'Profil à valider': '#D97706',
    'Nouveau': '#3B82F6',
    'Invitation envoyée': '#7C3AED',
    'Message à valider': '#92400E',
    'Message à envoyer': '#C2410C',
    'Message envoyé': '#1D4ED8',
    'Réponse reçue': '#BE185D',
    'RDV planifié': '#1D4ED8',
    'Gagné': '#2D6A4F',
    'Perdu': '#EF4444',
    'Non pertinent': '#9CA3AF',
  };

  async function loadQuickFilterCounts() {
    const counts = await DB.getProspectCountsByStatus();
    let total = 0;
    for (const s of UI.STATUSES) {
      const count = counts[s] || 0;
      total += count;
      const el = document.getElementById(`qfCount-${s.replace(/\s/g, '_')}`);
      if (el) {
        el.textContent = count > 0 ? count : '';
        if (QF_COLORS[s]) el.style.background = QF_COLORS[s];
      }
    }
    const hiddenCount = Object.entries(counts).filter(([k]) => !UI.STATUSES.includes(k) && k !== '').reduce((a, [, v]) => a + v, 0);
    total += hiddenCount;
    const allEl = document.getElementById('qfCount-all');
    if (allEl) {
      allEl.textContent = total > 0 ? total : '';
      allEl.style.background = 'var(--color-primary)';
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
    const resp = await fetch('/api/prospector/bulk-update-status', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids, status }),
    });
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

    let secondsLeft = 60;
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
        const resp = await fetch('/api/prospector/undo-bulk', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ bulk_operation_id: bulkOpId }),
        });
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
    await fetch('/api/prospector/bulk-update-status', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [id], status: 'Nouveau' }),
    });
    UI.toast('Profil validé');
    filterProspects();
  }

  async function quickReject(id) {
    await fetch('/api/prospector/bulk-update-status', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [id], status: 'Non pertinent' }),
    });
    UI.toast('Profil marqué non pertinent');
    filterProspects();
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
    const tbody = prospects.length === 0
      ? `<tr><td colspan="8">${UI.emptyState('Aucun prospect trouvé')}</td></tr>`
      : prospects.map(p => {
          const campName = p.status === 'Non pertinent' ? 'Non pertinent' : (p.campaigns?.name || 'Non défini');
          const campClass = p.status === 'Non pertinent' ? 'badge-non-pertinent' : (p.campaigns?.name ? 'badge-type' : 'badge-non-pertinent');
          const isAValider = p.status === 'Profil à valider';
          const checked = _selectedProspects.has(p.id) ? 'checked' : '';
          const href = `#prospect-detail?id=${p.id}`;
          return `<tr class="clickable ${p.status === 'Non pertinent' ? 'row-muted' : ''} ${isAValider ? 'row-a-valider' : ''}">
          <td onclick="event.stopPropagation()"><input type="checkbox" class="prospect-cb" data-id="${p.id}" ${checked} onchange="App.toggleSelect('${p.id}', this.checked)"></td>
          <td><a href="${href}" class="row-link"><strong>${UI.esc(p.first_name)} ${UI.esc(p.last_name)}</strong></a></td>
          <td class="text-sm text-muted"><a href="${href}" class="row-link">${UI.esc(p.job_title || '')}</a></td>
          <td><a href="${href}" class="row-link">${UI.esc(p.company || '')}</a></td>
          <td><a href="${href}" class="row-link"><span class="badge ${campClass}">${UI.esc(campName)}</span></a></td>
          <td><a href="${href}" class="row-link">${UI.statusBadge(p.status)}</a></td>
          <td class="text-muted text-sm"><a href="${href}" class="row-link">${UI.formatDate(p.updated_at)}</a></td>
          <td class="action-btns" onclick="event.stopPropagation()">
            ${isAValider ? `<button class="btn-icon btn-validate" onclick="App.quickValidate('${p.id}')" title="Valider">✓</button><button class="btn-icon btn-reject" onclick="App.quickReject('${p.id}')" title="Non pertinent">✕</button>` : ''}
            ${p.linkedin_url ? `<a href="${UI.esc(p.linkedin_url)}" target="_blank" title="Voir LinkedIn">🔗</a>` : ''}
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

    // Check duplicates
    const dupes = await DB.checkDuplicates(prospect, id);

    const campName = prospect.campaigns?.name || '—';

    container.innerHTML = `
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

      ${prospect.status === 'Message à valider' ? (() => {
        const versions = prospect.message_versions || [];
        const hasPending = !!prospect.pending_message;
        const hasVersions = versions.length > 0;
        if (!hasPending && !hasVersions) return '';
        if (hasVersions) {
          return `<div class="message-card">
            <div class="message-card-title" style="justify-content:space-between">
              <span>✉️ Message LinkedIn à valider — choisissez une version</span>
              <button class="btn btn-sm btn-outline" id="btnRegenToggle" onclick="App.toggleRegenForm()">Régénérer</button>
            </div>
            <div id="regenForm" style="display:none;margin-bottom:16px">
              <div style="display:flex;gap:8px;align-items:flex-end">
                <input id="regenInstructions" class="tags-input" style="flex:1" placeholder="Instructions (optionnel) — ex: Ton plus direct, axé sur le DPE">
                <button class="btn btn-sm btn-primary" id="btnRegenConfirm" onclick="App.regenerateMessages('${id}')">Confirmer</button>
              </div>
            </div>
            <div class="message-versions" id="messageVersionsContainer">
              ${versions.map((v, i) => `
                <div class="message-version" id="msgVersion${i}">
                  <div class="message-version-header">
                    <strong>${UI.esc(v.label || 'Version ' + (i+1))}</strong>
                    <button class="btn btn-sm btn-outline" onclick="App.selectMessageVersion('${id}', ${i})">Choisir</button>
                  </div>
                  <div class="message-version-content">${UI.esc(v.content || '')}</div>
                </div>
              `).join('')}
            </div>
            <div id="selectedMessageWrap" style="display:none">
              <div class="message-card-title mt-4">Message sélectionné (modifiable)</div>
              <textarea class="message-textarea" id="pendingMessage"></textarea>
              <div class="message-actions">
                <button class="btn btn-primary" onclick="App.validateMessage('${id}')">✓ Valider et envoyer</button>
                <button class="btn btn-danger btn-sm" onclick="App.rejectMessage('${id}')">✕ Rejeter</button>
              </div>
            </div>
          </div>`;
        }
        return `<div class="message-card">
          <div class="message-card-title">✉️ Message LinkedIn à valider</div>
          <textarea class="message-textarea" id="pendingMessage">${UI.esc(prospect.pending_message)}</textarea>
          <div class="message-actions">
            <button class="btn btn-primary" onclick="App.validateMessage('${id}')">✓ Valider et envoyer</button>
            <button class="btn btn-danger btn-sm" onclick="App.rejectMessage('${id}')">✕ Rejeter</button>
          </div>
        </div>`;
      })() : ''}

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
    const instructions = document.getElementById('regenInstructions')?.value || '';
    if (btn) { btn.disabled = true; btn.textContent = 'Génération en cours...'; }

    try {
      const resp = await fetch('/api/prospector/regenerate-messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, instructions: instructions || undefined }),
      });
      const result = await resp.json();
      if (!resp.ok) { UI.toast(result.error || 'Erreur', 'error'); return; }

      // Update versions in place
      const container = document.getElementById('messageVersionsContainer');
      if (container && result.message_versions) {
        container.innerHTML = result.message_versions.map((v, i) => `
          <div class="message-version" id="msgVersion${i}">
            <div class="message-version-header">
              <strong>${UI.esc(v.label || 'Version ' + (i+1))}</strong>
              <button class="btn btn-sm btn-outline" onclick="App.selectMessageVersion('${id}', ${i})">Choisir</button>
            </div>
            <div class="message-version-content">${UI.esc(v.content || '')}</div>
          </div>
        `).join('');
        // Reset selection
        const wrap = document.getElementById('selectedMessageWrap');
        if (wrap) wrap.style.display = 'none';
      }
      // Hide regen form
      const form = document.getElementById('regenForm');
      if (form) form.style.display = 'none';
      UI.toast('Messages régénérés');
    } catch (err) {
      UI.toast('Erreur: ' + err.message, 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Confirmer'; }
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
    await DB.updateProspect(id, { status: newStatus });
    sel.dataset.original = newStatus;
    document.getElementById(`btnSaveStatus-${id}`).style.display = 'none';
    UI.toast('Statut mis à jour');
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
    const msg = document.getElementById('pendingMessage')?.value || '';
    await DB.updateProspect(id, { status: 'Message à envoyer', pending_message: msg });
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
  // CAMPAGNES
  // ============================================================
  async function renderCampagnes(container) {
    container.innerHTML = `
      <div class="page-header">
        <h1 class="page-title" style="margin-bottom:0">Campagnes</h1>
        <div class="flex gap-2">
          <select id="filterCampStatus" onchange="App.loadCampagnes()" style="font-family:inherit;font-size:13px;padding:6px 10px;border:1px solid var(--color-border);border-radius:6px">
            <option value="">Tous les statuts</option>
          </select>
          <button class="btn btn-primary" onclick="App.openAddCampaign()">+ Nouvelle campagne</button>
        </div>
      </div>
      <div id="campagnesTable">${UI.loader()}</div>
    `;
    // Populate filter dropdown dynamically
    const filterSel = document.getElementById('filterCampStatus');
    UI.CAMP_STATUSES.forEach(s => { const o = document.createElement('option'); o.value = s; o.textContent = s; filterSel.appendChild(o); });
    // Populate modal selects dynamically
    document.querySelectorAll('.camp-status-select').forEach(sel => {
      sel.innerHTML = '';
      UI.CAMP_STATUSES.forEach(s => { const o = document.createElement('option'); o.value = s; o.textContent = s; sel.appendChild(o); });
    });
    loadCampagnes();
  }

  let _campaignsCache = [];

  async function loadCampagnes() {
    const statusFilter = document.getElementById('filterCampStatus')?.value || '';
    let url = '/api/prospector/campaigns';
    if (statusFilter) url += `?status=${encodeURIComponent(statusFilter)}`;
    try {
      const resp = await fetch(url);
      if (!resp.ok) {
        console.error('Failed to load campaigns:', resp.status);
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

    el.innerHTML = `<div class="camp-cards" id="campCardsList">${_campaignsCache.map((c, i) => campCardHtml(c, i)).join('')}</div>`;
    initCardDrag();
  }

  function campCardHtml(c, i) {
    const criteria = c.criteria || {};
    const jobs = (criteria.job_titles || []).map(j => `<span class="badge badge-type">${UI.esc(j)}</span>`).join('');
    const excl = (c.excluded_keywords || []).length;
    const revMin = criteria.revenue_min ? new Intl.NumberFormat('fr-FR', {notation:'compact'}).format(criteria.revenue_min) + '€' : null;
    const revMax = criteria.revenue_max ? new Intl.NumberFormat('fr-FR', {notation:'compact'}).format(criteria.revenue_max) + '€' : null;
    const empMin = criteria.employees_min;
    const empMax = criteria.employees_max;

    return `<div class="camp-card" draggable="true" data-id="${c.id}" data-idx="${i}">
      <div class="camp-card-header">
        <span class="camp-card-prio">${i + 1}</span>
        <span class="camp-card-name">${UI.esc(c.name)}</span>
        ${UI.campStatusBadge(c.status)}
      </div>
      <div class="camp-card-meta">
        ${c.sector || criteria.sector ? `<span class="camp-chip">📍 ${UI.esc(c.sector || criteria.sector)}</span>` : ''}
        ${c.geography || criteria.geography ? `<span class="camp-chip">🌍 ${UI.esc(c.geography || criteria.geography)}</span>` : ''}
        ${c.daily_quota ? `<span class="camp-chip">📊 ${c.daily_quota}/j</span>` : ''}
        <span class="camp-chip">👥 ${c.prospects_count || 0}</span>
      </div>
      ${jobs ? `<div class="camp-card-tags">${jobs}</div>` : ''}
      ${(revMin || revMax || empMin || empMax) ? `<div class="camp-card-criteria">
        ${revMin || revMax ? `<span class="text-sm text-muted">CA : ${revMin || '—'} → ${revMax || '—'}</span>` : ''}
        ${empMin || empMax ? `<span class="text-sm text-muted">Effectif : ${empMin || '—'} → ${empMax || '—'}</span>` : ''}
      </div>` : ''}
      ${excl ? `<div class="camp-card-excl"><span class="text-sm text-muted">${excl} exclusion(s)</span></div>` : ''}
      <div class="camp-card-footer">
        <span class="text-sm text-muted">${UI.formatDate(c.created_at)}</span>
        <button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();App.openEditCampaign('${c.id}')">✏️</button>
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
          await fetch(`/api/prospector/campaigns/${u.id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ priority: u.priority }),
          });
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

    const resp = await fetch('/api/prospector/campaigns', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
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

    const resp = await fetch(`/api/prospector/campaigns/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
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

  async function renderCampaignDetail(container, id) {
    if (!id) { location.hash = '#campagnes'; return; }
    container.innerHTML = UI.loader();

    const [campaign, prospects] = await Promise.all([
      DB.getCampaign(id),
      DB.getCampaignProspects(id),
    ]);

    const criteria = campaign.criteria || {};
    const statusCounts = {};
    for (const p of prospects) {
      statusCounts[p.status] = (statusCounts[p.status] || 0) + 1;
    }

    container.innerHTML = `
      <div class="flex items-center gap-2 mb-4">
        <a class="inline-link" href="#campagnes">← Campagnes</a>
      </div>
      <div class="profile-card">
        <div class="profile-header">
          <div>
            <div class="profile-name">${UI.esc(campaign.name)}</div>
            <div class="profile-badges mt-4">
              ${UI.campStatusBadge(campaign.status)}
              <span class="badge badge-type">Priorité ${campaign.priority || '—'}</span>
              ${campaign.sector || criteria.sector ? `<span class="badge badge-type">${UI.esc(campaign.sector || criteria.sector)}</span>` : ''}
              ${campaign.geography || criteria.geography ? `<span class="badge badge-type">${UI.esc(campaign.geography || criteria.geography)}</span>` : ''}
              ${(criteria.job_titles || []).map(j => `<span class="badge badge-type">${UI.esc(j)}</span>`).join('')}
            </div>
            ${(campaign.excluded_keywords || []).length ? `<div style="margin-top:8px"><span class="text-sm text-muted">Exclusions :</span> ${campaign.excluded_keywords.map(k => `<span class="badge tag-excl" style="margin-left:4px">${UI.esc(k)}</span>`).join('')}</div>` : ''}
          </div>
          <div class="flex gap-2 items-center">
            <div class="text-sm text-muted">Quota : ${campaign.daily_quota || 20}/j</div>
            <button class="btn btn-outline btn-sm" onclick="App.openEditCampaign('${id}')">Modifier</button>
          </div>
        </div>
        <div class="profile-fields mt-4">
          ${criteria.revenue_min || criteria.revenue_max ? `<div><div class="profile-field-label">Chiffre d'affaires</div><div class="profile-field-value">${criteria.revenue_min ? new Intl.NumberFormat('fr-FR').format(criteria.revenue_min) + ' €' : '—'} → ${criteria.revenue_max ? new Intl.NumberFormat('fr-FR').format(criteria.revenue_max) + ' €' : '—'}</div></div>` : ''}
          ${criteria.employees_min || criteria.employees_max ? `<div><div class="profile-field-label">Effectif</div><div class="profile-field-value">${criteria.employees_min || '—'} → ${criteria.employees_max || '—'} salariés</div></div>` : ''}
        </div>
        ${campaign.details ? `<div class="mt-4"><div class="profile-field-label">Détails de la campagne</div><div class="text-sm" style="white-space:pre-wrap;margin-top:4px">${UI.esc(campaign.details)}</div></div>` : ''}
      </div>

      <div class="tab-bar mt-6">
        <button class="tab-btn tab-active" data-tab="prospects" onclick="App.switchCampaignTab(this, 'prospects', '${id}')">Prospects</button>
        <button class="tab-btn" data-tab="sequence" onclick="App.switchCampaignTab(this, 'sequence', '${id}')">Séquence</button>
        <button class="tab-btn" data-tab="review" onclick="App.switchCampaignTab(this, 'review', '${id}')">Review</button>
      </div>
      <div id="campaignTabContent"></div>
    `;

    // Render default tab (prospects)
    renderProspectsTab(id, prospects, statusCounts);
  }

  function renderProspectsTab(id, prospects, statusCounts) {
    const el = document.getElementById('campaignTabContent');
    if (!el) return;
    el.innerHTML = `
      <div class="stat-grid" style="grid-template-columns:repeat(auto-fit,minmax(140px,1fr));margin-top:20px">
        ${UI.STATUSES.filter(s => statusCounts[s]).map(s =>
          `<div class="stat-card">${UI.statusBadge(s)} <span class="stat-value" style="font-size:20px;margin-left:8px">${statusCounts[s]}</span></div>`
        ).join('')}
      </div>
      <div class="card mt-6">
        <div class="card-title">Prospects de cette campagne</div>
        <div class="table-wrap">
        ${prospects.length === 0 ? UI.emptyState('Aucun prospect dans cette campagne') : `
          <table><thead><tr><th>Nom</th><th>Entreprise</th><th>Poste</th><th>Statut</th><th>Dernier contact</th></tr></thead>
          <tbody>${prospects.map(p => `<tr class="clickable" onclick="location.hash='#prospect-detail?id=${p.id}'">
            <td><strong>${UI.esc(p.first_name)} ${UI.esc(p.last_name)}</strong></td>
            <td>${UI.esc(p.company || '')}</td>
            <td class="text-sm text-muted">${UI.esc(p.job_title || '')}</td>
            <td>${UI.statusBadge(p.status)}</td>
            <td class="text-muted text-sm">${UI.formatDate(p.updated_at)}</td>
          </tr>`).join('')}</tbody></table>`}
        </div>
      </div>
    `;
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
        <button class="btn btn-outline btn-sm" onclick="App.createNewVersion('${campaignId}', ${sequence.version})">Nouvelle version</button>
      </div>
      <div class="seq-split">
        <div class="seq-left" id="seqStepsList">
          ${steps.map((s, i) => {
            const meta = STEP_TYPES[s.type] || { icon: '❓', label: s.type };
            const label = s.message_label || meta.label;
            const isActive = s.id === _seqActiveStepId ? ' seq-step-active' : '';
            const delayHtml = i > 0 ? _delayHtml(s.delay_days) : '';
            return `${delayHtml}<div class="seq-step-card${isActive}" draggable="true" data-step-id="${s.id}" data-idx="${i}" onclick="App.selectStep('${s.id}', '${campaignId}')">
              <span class="seq-step-drag" title="Glisser pour réordonner">⠿</span>
              <span class="seq-step-num">${i + 1}</span>
              <span class="seq-step-icon">${meta.icon}</span>
              <span class="seq-step-label">${UI.esc(label)}</span>
              <button class="btn-icon" onclick="event.stopPropagation();App.deleteStep('${sequence.id}','${s.id}')" title="Supprimer">🗑️</button>
            </div>`;
          }).join('')}
          ${steps.length === 0 ? '<div class="text-sm text-muted" style="padding:20px;text-align:center">Aucune étape</div>' : ''}
          <div class="seq-add-step">
            <button class="btn btn-outline btn-sm" onclick="App.addStep('${sequence.id}', 'send_invitation')">🤝 Invitation</button>
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

  function _delayHtml(days) {
    let text;
    if (days === 0) text = 'Immédiatement';
    else if (days === 1) text = 'Attendre 1 jour';
    else text = `Attendre ${days} jours`;
    const tooltip = days > 1 ? ` title="Exécution entre J+${Math.round(days * 0.83)} et J+${Math.round(days * 1.17)} (randomisé ±17%)"` : '';
    return `<div class="seq-delay-divider"${tooltip}><span class="seq-delay-line"></span><span class="seq-delay-text">${text}</span><span class="seq-delay-line"></span></div>`;
  }

  function selectStep(stepId, campaignId) {
    _seqActiveStepId = stepId;
    document.querySelectorAll('.seq-step-card').forEach(c => c.classList.remove('seq-step-active'));
    document.querySelector(`.seq-step-card[data-step-id="${stepId}"]`)?.classList.add('seq-step-active');
    // Fetch step data from current sequence
    fetch(`/api/sequences?campaign_id=${campaignId}`).then(r => r.json()).then(seq => {
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
      el.innerHTML = `
        <div class="seq-config-inner">
          <h3>${meta.icon} ${meta.label}</h3>
          <div class="form-group"><label>Libellé</label><input id="cfgLabel" value="${UI.esc(step.message_label || 'Invitation LinkedIn')}" placeholder="Invitation LinkedIn"></div>
          <div class="form-group"><label>Délai (jours)</label><input type="number" id="cfgDelay" min="0" value="${step.delay_days}"><div class="text-sm text-muted" style="margin-top:4px">0 = immédiatement</div></div>
          <div class="text-sm text-muted" style="background:#F0FDF4;padding:10px;border-radius:6px;margin:12px 0">L'invitation sera envoyée sans note de personnalisation.</div>
          <button class="btn btn-primary" onclick="App._saveStepConfig('${sequenceId}','${step.id}')">Sauvegarder</button>
        </div>`;
      return;
    }

    // send_message
    const phGroups = {};
    for (const ph of (_placeholdersCache || [])) {
      if (!phGroups[ph.source]) phGroups[ph.source] = [];
      phGroups[ph.source].push(ph);
    }
    const phBarHtml = Object.entries(phGroups).map(([src, phs]) =>
      `<div class="ph-group"><span class="ph-group-label">${src}</span>${phs.map(p => `<button class="ph-btn" onclick="App._insertPlaceholder('{{${p.key}}}')" title="${UI.esc(p.description || p.label)}">${UI.esc(p.label)}</button>`).join('')}</div>`
    ).join('');

    el.innerHTML = `
      <div class="seq-config-inner">
        <h3>${meta.icon} ${UI.esc(step.message_label || 'Message')}</h3>
        <div class="form-group"><label>Libellé de l'étape</label><input id="cfgLabel" value="${UI.esc(step.message_label || '')}" placeholder="Ex: Message 1 — Premier contact"></div>
        <div class="form-group"><label>Délai (jours)</label><input type="number" id="cfgDelay" min="1" value="${step.delay_days}"><div class="text-sm text-muted" style="margin-top:4px">Minimum 1 jour</div></div>

        <div class="step-msg-tabs">
          <button class="step-msg-tab ${mode === 'manual' ? 'step-msg-tab-active' : ''}" onclick="App._switchMsgTab('manual')">Rédiger</button>
          <button class="step-msg-tab ${mode === 'ai_generated' ? 'step-msg-tab-active' : ''}" onclick="App._switchMsgTab('ai')">Générer avec Claude</button>
        </div>

        <div id="msgTabManual" style="display:${mode === 'manual' ? 'block' : 'none'}">
          <div class="ph-bar">${phBarHtml}</div>
          <div class="form-group">
            <textarea id="stepContent" rows="6" maxlength="300" placeholder="Votre message LinkedIn…" oninput="App._updateCharCount()">${UI.esc(step.message_content || '')}</textarea>
            <div class="char-counter"><span id="charCount">${(step.message_content || '').length}</span> / 300</div>
          </div>
        </div>

        <div id="msgTabAI" style="display:${mode === 'ai_generated' ? 'block' : 'none'}">
          <div class="form-group"><label>Angle</label><input id="aiAngle" value="${UI.esc(params.angle || '')}" placeholder="ex: pression réglementaire, enjeux carbone..."></div>
          <div class="form-group"><label>Ton</label><input id="aiTone" value="${UI.esc(params.tone || '')}" placeholder="ex: chaleureux et direct, très formel, décontracté..."></div>
          <div class="form-group"><label>Thématique</label><input id="aiObjective" value="${UI.esc(params.objective || '')}" placeholder="ex: Bilan carbone, RSE, QHSE..."></div>
          <div class="form-group"><label>Contexte additionnel (optionnel)</label><input id="aiContext" value="${UI.esc(params.context || '')}" placeholder="Précisions supplémentaires…"></div>
          <div class="flex gap-2">
            <button class="btn btn-outline btn-sm" id="btnGenerate" onclick="App._generateStepMessage('${sequenceId}')">✨ Générer avec Claude</button>
            <button class="btn btn-ghost btn-sm" id="btnRegenerate" onclick="App._generateStepMessage('${sequenceId}')" style="display:none">↺ Régénérer</button>
          </div>
          <div class="text-sm text-muted" style="margin-top:6px">Claude utilisera automatiquement les placeholders de votre bibliothèque.</div>
          <div id="aiResult" style="margin-top:12px;display:${step.message_content && mode === 'ai_generated' ? 'block' : 'none'}">
            <div class="ph-bar">${phBarHtml}</div>
            <textarea id="aiResultContent" rows="6" maxlength="300" oninput="App._updateCharCount()">${mode === 'ai_generated' ? UI.esc(step.message_content || '') : ''}</textarea>
            <div class="char-counter"><span id="charCountAI">${mode === 'ai_generated' ? (step.message_content || '').length : 0}</span> / 300</div>
          </div>
        </div>

        <div style="margin-top:16px">
          <button class="btn btn-primary" onclick="App._saveStepConfig('${sequenceId}','${step.id}')">Sauvegarder</button>
        </div>
      </div>`;
  }

  function _insertPlaceholder(placeholder) {
    const ta = document.getElementById('stepContent') || document.getElementById('aiResultContent');
    if (!ta) return;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    ta.value = ta.value.substring(0, start) + placeholder + ta.value.substring(end);
    ta.selectionStart = ta.selectionEnd = start + placeholder.length;
    ta.focus();
    _updateCharCount();
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
      });
      card.addEventListener('dragend', () => {
        card.classList.remove('dragging');
        list.querySelectorAll('.drag-over').forEach(c => c.classList.remove('drag-over'));
        dragCard = null;
      });
      card.addEventListener('dragover', e => {
        e.preventDefault();
        if (card !== dragCard && card.classList.contains('seq-step-card')) {
          list.querySelectorAll('.drag-over').forEach(c => c.classList.remove('drag-over'));
          card.classList.add('drag-over');
        }
      });
      card.addEventListener('dragleave', () => card.classList.remove('drag-over'));
      card.addEventListener('drop', async e => {
        e.preventDefault();
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
    if (type === 'send_message') { body.message_mode = 'manual'; body.message_label = ''; }
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
    document.getElementById('msgTabManual').style.display = tab === 'manual' ? 'block' : 'none';
    document.getElementById('msgTabAI').style.display = tab === 'ai' ? 'block' : 'none';
    document.querySelectorAll('.step-msg-tab').forEach(b => b.classList.remove('step-msg-tab-active'));
    if (tab === 'manual') document.querySelector('.step-msg-tab:first-child')?.classList.add('step-msg-tab-active');
    else document.querySelector('.step-msg-tab:last-child')?.classList.add('step-msg-tab-active');
  }

  function _updateCharCount() {
    const ta = document.getElementById('stepContent');
    const el = document.getElementById('charCount');
    if (ta && el) el.textContent = ta.value.length;
    const taAI = document.getElementById('aiResultContent');
    const elAI = document.getElementById('charCountAI');
    if (taAI && elAI) elAI.textContent = taAI.value.length;
  }

  async function _generateStepMessage() {
    const btn = document.getElementById('btnGenerate');
    const regenBtn = document.getElementById('btnRegenerate');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Génération…'; }

    let campaign = {};
    try { campaign = await DB.getCampaign(_currentCampaignId()); } catch(e) {}

    const message_params = {
      angle: document.getElementById('aiAngle')?.value || '',
      tone: document.getElementById('aiTone')?.value || '',
      objective: document.getElementById('aiObjective')?.value || '',
      context: document.getElementById('aiContext')?.value || '',
    };

    try {
      const resp = await fetch('/api/sequences/generate-message', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ campaign, message_params }),
      });
      const result = await resp.json();
      if (result.content) {
        document.getElementById('aiResult').style.display = 'block';
        document.getElementById('aiResultContent').value = result.content;
        if (regenBtn) regenBtn.style.display = '';
        _updateCharCount();
      } else {
        UI.toast(result.error || 'Erreur de génération');
      }
    } catch(e) {
      UI.toast('Erreur réseau');
    }
    if (btn) { btn.disabled = false; btn.textContent = '✨ Générer avec Claude'; }
  }

  async function _saveStepConfig(sequenceId, stepId) {
    const delay_days = parseInt(document.getElementById('cfgDelay')?.value) || 0;
    const label = document.getElementById('cfgLabel')?.value || '';

    const body = { delay_days, message_label: label };

    // Determine if this is a message step
    const manualTab = document.getElementById('msgTabManual');
    if (manualTab) {
      const isAI = document.getElementById('msgTabAI')?.style.display !== 'none';
      if (isAI) {
        body.message_mode = 'ai_generated';
        body.message_content = document.getElementById('aiResultContent')?.value || '';
        body.message_params = {
          angle: document.getElementById('aiAngle')?.value || '',
          tone: document.getElementById('aiTone')?.value || '',
          objective: document.getElementById('aiObjective')?.value || '',
          context: document.getElementById('aiContext')?.value || '',
        };
      } else {
        body.message_mode = 'manual';
        body.message_content = document.getElementById('stepContent')?.value || '';
      }

      if (delay_days < 1) {
        UI.toast('Délai minimum 1 jour pour un message');
        return;
      }
    }

    await fetch(`/api/sequences/${sequenceId}/steps/${stepId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    UI.toast('Étape sauvegardée');
    renderSequenceTab(_currentCampaignId());
  }

  // ============================================================
  // REVIEW TAB
  // ============================================================

  async function renderReviewTab(campaignId) {
    const el = document.getElementById('campaignTabContent');
    if (!el) return;
    el.innerHTML = UI.loader();

    const prospects = await DB.getCampaignProspects(campaignId);

    el.innerHTML = `
      <div class="seq-split mt-6">
        <div class="seq-left">
          <input class="input" id="reviewSearch" placeholder="Rechercher…" oninput="App._filterReviewList()" style="margin-bottom:10px">
          <div id="reviewList" class="review-prospect-list">
            ${prospects.map((p, i) => `<div class="review-prospect-item ${i === 0 ? 'review-active' : ''}" data-id="${p.id}" onclick="App._selectReviewProspect('${p.id}', '${campaignId}')">
              <strong>${UI.esc(p.first_name)} ${UI.esc(p.last_name)}</strong>
              <span class="text-sm text-muted">${UI.esc(p.company || '')}</span>
            </div>`).join('')}
            ${prospects.length === 0 ? '<div class="text-sm text-muted" style="padding:20px;text-align:center">Aucun prospect</div>' : ''}
          </div>
        </div>
        <div class="seq-right" id="reviewPreview">${prospects.length > 0 ? UI.loader() : ''}</div>
      </div>`;

    if (prospects.length > 0) _selectReviewProspect(prospects[0].id, campaignId);
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

    panel.innerHTML = `
      <div class="seq-config-inner">
        <h3>Prévisualisation pour ${UI.esc(name)}</h3>
        <div class="text-sm text-muted" style="margin-bottom:16px">Statut : Pas encore démarré</div>
        ${data.steps.map((s, i) => {
          const meta = STEP_TYPES[s.type] || { icon: '❓', label: s.type };
          const label = s.message_label || meta.label;
          const delayHtml = i > 0 ? `<div class="review-delay">${s.delay_days === 0 ? 'Immédiatement' : `Attendre ${s.delay_days} jour${s.delay_days > 1 ? 's' : ''}`}</div>` : '';
          const previewHtml = s.message_preview ? `<div class="review-msg-preview">${UI.esc(s.message_preview).replace(/⚠️\{\{(\w+)\}\}/g, '<span class="ph-missing">{{$1}}</span>')}</div>` : '';
          return `${delayHtml}<div class="review-step"><div class="review-step-header">${meta.icon} Étape ${i + 1} — ${UI.esc(label)}</div>${previewHtml}</div>`;
        }).join('')}
      </div>`;
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

    // Reload page when account changes (to refresh all data with new account_id header)
    document.addEventListener('account-changed', (e) => {
      console.log('Account changed to:', e.detail?.name);
      // Reload the current page to refresh all data
      router();
    });

    router();
  }

  document.addEventListener('DOMContentLoaded', init);

  return {
    handleAddProspect, handleEditProspect, handleAddCampaign, handleEditCampaign,
    handleAddInteraction, handleAddReminder,
    openAddProspect, openEditProspect, deleteProspect,
    openAddInteraction, openAddReminder, openAddCampaign, openEditCampaign,
    changeProspectStatus, saveProspectStatus, debounceNotes, selectMessageVersion, toggleRegenForm, regenerateMessages, validateMessage, rejectMessage, markNonPertinent,
    filterProspects, quickFilter, loadRappels, loadCampagnes,
    toggleSelect, toggleSelectAll, clearSelection, bulkValidate, bulkReject,
    quickValidate, quickReject,
    reminderDone, reminderSnooze,
    handleImportFile, setMapping, importBack, importNext, launchImport,
    switchCampaignTab, createSequence, createNewVersion, updateSequenceName,
    addStep, deleteStep, selectStep, _switchMsgTab,
    _updateCharCount, _generateStepMessage, _saveStepConfig, _insertPlaceholder,
    _selectReviewProspect, _filterReviewList,
    openAddPlaceholder, savePlaceholder, deletePlaceholder,
  };
})();
