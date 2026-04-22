/* ============================================
   Releaf Prospector — UI Components
   ============================================ */

const UI = (() => {

  // ---- Status badge ----
  const STATUS_CLASSES = {
    // Pipeline visible (quick filters + dashboard)
    'Profil à valider': 'badge-profil-a-valider',
    'Nouveau': 'badge-nouveau',
    'Invitation envoyée': 'badge-invitation',
    'Message à valider': 'badge-a-valider',
    'Message à envoyer': 'badge-a-envoyer',
    'Message envoyé': 'badge-envoye',
    'Discussion en cours': 'badge-discussion',
    'Gagné': 'badge-gagne',
    'Perdu': 'badge-perdu',
    // Hidden from dashboard (exist in DB but not shown in filters)
    'Invitation acceptée': 'badge-acceptee',
    'Profil restreint': 'badge-profil-restreint',
    'Non pertinent': 'badge-non-pertinent',
  };

  // Hidden from quick filters and dashboard
  const HIDDEN_STATUSES = ['Invitation acceptée', 'Profil restreint', 'Non pertinent'];
  const STATUSES = Object.keys(STATUS_CLASSES).filter(s => !HIDDEN_STATUSES.includes(s));

  // Statuts assignés uniquement par l'automatisation — exclus des dropdowns manuels
  const AUTO_ONLY_STATUSES = ['Profil restreint', 'Invitation acceptée'];
  const DROPDOWN_STATUSES = [...STATUSES.filter(s => !AUTO_ONLY_STATUSES.includes(s)), 'Non pertinent'];

  const CAMP_STATUS_CLASSES = {
    'À lancer': 'badge-a-lancer',
    'En cours': 'badge-en-cours',
    'En suivi': 'badge-en-suivi',
    'Terminée': 'badge-terminee',
    'Archivée': 'badge-archivee',
  };

  const CAMP_STATUSES = Object.keys(CAMP_STATUS_CLASSES);

  // Colors for status filter cards — exact Lovable POC palette
  const STATUS_COLORS = {
    'Profil à valider':    { color: '#EA580C', bg: '#FFEDD5' },
    'Nouveau':             { color: '#2563EB', bg: '#DBEAFE' },
    'Invitation envoyée':  { color: '#7C3AED', bg: '#EDE9FE' },
    'Invitation acceptée': { color: '#065F46', bg: '#D1FAE5' },
    'Message à valider':   { color: '#A16207', bg: '#FEF9C3' },
    'Message à envoyer':   { color: '#475569', bg: '#F1F5F9' },
    'Message envoyé':      { color: '#0F766E', bg: '#CCFBF1' },
    'Discussion en cours': { color: '#BE185D', bg: '#FCE7F3' },
    'Gagné':               { color: '#4D7C0F', bg: '#ECFCCB' },
    'Perdu':               { color: '#DC2626', bg: '#FEE2E2' },
    'Non pertinent':       { color: '#64748B', bg: '#F1F5F9' },
    'Profil restreint':    { color: '#374151', bg: '#F3F4F6' },
  };

  // SVG icon paths for status filter cards (16×16 viewBox, stroke-based)
  const STATUS_ICONS = {
    '_tous':               '<rect x="2" y="2" width="5" height="5" rx="1"/><rect x="9" y="2" width="5" height="5" rx="1"/><rect x="2" y="9" width="5" height="5" rx="1"/><rect x="9" y="9" width="5" height="5" rx="1"/>',
    'Profil à valider':    '<circle cx="7" cy="5.5" r="2.5"/><path d="M1 14c0-3 2.7-5.5 6-5.5s6 2.5 6 5.5"/><path d="M11.5 2l1.5 1.5L11.5 5"/><path d="M15 2l-1.5 1.5L15 5"/>',
    'Nouveau':             '<circle cx="8" cy="5" r="2.5"/><path d="M2 14c0-3 2.7-5.5 6-5.5s6 2.5 6 5.5"/><path d="M13 1v4M11 3h4"/>',
    'Invitation envoyée':  '<circle cx="8" cy="5" r="2.5"/><path d="M2 14c0-3 2.7-5.5 6-5.5s6 2.5 6 5.5"/><path d="M11 8l3-3M11 5l3 3"/>',
    'Invitation acceptée': '<circle cx="8" cy="8" r="6"/><path d="M5.5 8l2 2L11 6"/>',
    'Message à valider':   '<circle cx="8" cy="8" r="6"/><path d="M8 5v3.5l2.5 1.5"/>',
    'Message à envoyer':   '<path d="M2.5 13.5l11-5.5-11-5.5v4l7.5 1.5-7.5 1.5z"/>',
    'Message envoyé':      '<path d="M3 3h10a1 1 0 011 1v6a1 1 0 01-1 1H9l-3 2.5V11H3a1 1 0 01-1-1V4a1 1 0 011-1z"/><path d="M6 7l1.5 1.5L10 6"/>',
    'Discussion en cours': '<path d="M2 3h9a1 1 0 011 1v5a1 1 0 01-1 1H8l-3 2v-2H3a1 1 0 01-1-1V4a1 1 0 011-1z"/>',
    'Gagné':               '<path d="M8 2l1.8 3.6 4 .6-2.9 2.8.7 4-3.6-1.9-3.6 1.9.7-4L2.2 6.2l4-.6z"/>',
    'Perdu':               '<circle cx="8" cy="8" r="6"/><path d="M5.5 5.5l5 5M10.5 5.5l-5 5"/>',
    'Non pertinent':       '<circle cx="8" cy="8" r="6"/><path d="M4.5 4.5l7 7"/>',
    'Profil restreint':    '<rect x="4" y="8" width="8" height="6" rx="1"/><path d="M5.5 8V6a2.5 2.5 0 015 0v2"/>',
  };

  function statusBadge(status) {
    const cls = STATUS_CLASSES[status] || 'badge-nouveau';
    return `<span class="badge ${cls}">${esc(status)}</span>`;
  }

  function campStatusBadge(status) {
    const cls = CAMP_STATUS_CLASSES[status] || 'badge-brouillon';
    return `<span class="badge ${cls}">${esc(status)}</span>`;
  }

  function typeBadge(type) {
    return `<span class="badge badge-type">${esc(type)}</span>`;
  }

  // ---- Date helpers ----
  function formatDate(d) {
    if (!d) return '—';
    const dt = new Date(d);
    return dt.toLocaleDateString('fr-FR', { year: 'numeric', month: '2-digit', day: '2-digit' });
  }

  function todayStr() {
    return new Date().toISOString().split('T')[0];
  }

  function isOverdue(dateStr) {
    return dateStr < todayStr();
  }

  function isToday(dateStr) {
    return dateStr === todayStr();
  }

  // ---- Escape HTML ----
  function esc(str) {
    if (!str) return '';
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  // ---- Modal helpers ----
  function openModal(id) {
    document.getElementById(id)?.classList.add('open');
  }

  function closeModal(id) {
    document.getElementById(id)?.classList.remove('open');
  }

  // ---- Toast notification ----
  function toast(msg, type = 'success') {
    const el = document.createElement('div');
    el.style.cssText = `
      position:fixed;bottom:24px;right:24px;z-index:999;
      padding:12px 20px;border-radius:8px;font-size:14px;font-weight:500;
      color:#fff;background:${type === 'error' ? '#EF4444' : '#2D6A4F'};
      box-shadow:0 4px 12px rgba(0,0,0,0.15);transition:opacity .3s;
    `;
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, 2500);
  }

  // ---- Loading state ----
  function loader() {
    return '<div class="empty-state">Chargement...</div>';
  }

  // ---- Empty state ----
  function emptyState(msg) {
    return `<div class="empty-state">${esc(msg)}</div>`;
  }

  // ---- Build select options ----
  function options(values, selected, placeholder) {
    let html = `<option value="">${esc(placeholder)}</option>`;
    for (const v of values) {
      html += `<option value="${esc(v)}" ${v === selected ? 'selected' : ''}>${esc(v)}</option>`;
    }
    return html;
  }

  // ---- Tags input component ----
  function initTagsInput(inputId, containerId, cssClass) {
    const input = document.getElementById(inputId);
    if (!input) return;
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const val = input.value.trim();
        if (!val) return;
        addTag(containerId, val, cssClass);
        input.value = '';
      }
    });
  }

  function addTag(containerId, value, cssClass) {
    const container = document.getElementById(containerId);
    if (!container) return;
    // Avoid duplicate
    const existing = container.querySelectorAll('.tag');
    for (const t of existing) {
      if (t.dataset.value.toLowerCase() === value.toLowerCase()) return;
    }
    const tag = document.createElement('span');
    tag.className = `tag ${cssClass || ''}`;
    tag.dataset.value = value;
    tag.innerHTML = `${esc(value)} <span class="tag-remove" onclick="this.parentElement.remove()">×</span>`;
    container.appendChild(tag);
  }

  function getTagValues(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return [];
    return [...container.querySelectorAll('.tag')].map(t => t.dataset.value);
  }

  function setTags(containerId, values, cssClass) {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.innerHTML = '';
    for (const v of (values || [])) {
      addTag(containerId, v, cssClass);
    }
  }

  return {
    statusBadge, campStatusBadge, typeBadge,
    formatDate, todayStr, isOverdue, isToday,
    esc, openModal, closeModal, toast, loader, emptyState, options,
    initTagsInput, addTag, getTagValues, setTags,
    STATUS_CLASSES, STATUSES, DROPDOWN_STATUSES, CAMP_STATUS_CLASSES, CAMP_STATUSES,
    STATUS_COLORS, STATUS_ICONS,
  };
})();
