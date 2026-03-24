/* ============================================
   Releaf Prospector — UI Components
   ============================================ */

const UI = (() => {

  // ---- Status badge ----
  const STATUS_CLASSES = {
    'Profil à valider': 'badge-profil-a-valider',
    'Nouveau': 'badge-nouveau',
    'Invitation envoyée': 'badge-invitation',
    'Invitation acceptée': 'badge-acceptee',
    'Message à valider': 'badge-a-valider',
    'Message à envoyer': 'badge-a-envoyer',
    'Message envoyé': 'badge-envoye',
    'Réponse reçue': 'badge-reponse',
    'RDV planifié': 'badge-rdv',
    'Gagné': 'badge-gagne',
    'Perdu': 'badge-perdu',
    'Non pertinent': 'badge-non-pertinent',
  };

  const STATUSES = Object.keys(STATUS_CLASSES);

  const CAMP_STATUS_CLASSES = {
    'À lancer': 'badge-a-lancer',
    'En cours': 'badge-en-cours',
    'En suivi': 'badge-en-suivi',
    'Terminée': 'badge-terminee',
  };

  const CAMP_STATUSES = Object.keys(CAMP_STATUS_CLASSES);

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
    STATUS_CLASSES, STATUSES, CAMP_STATUS_CLASSES, CAMP_STATUSES,
  };
})();
