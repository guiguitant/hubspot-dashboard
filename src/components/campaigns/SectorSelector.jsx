import { useState, useMemo, useRef, useEffect } from 'react'
import { X, ChevronDown, Search } from 'lucide-react'

const PARENT_CATEGORIES = [
  { key: '__ALL__', label_fr: 'Toutes' },
  { key: 'Construction', label_fr: 'Construction' },
  { key: 'Manufacturing', label_fr: 'Industrie & Fabrication' },
  { key: 'Transportation, Logistics, Supply Chain and Storage', label_fr: 'Transport & Logistique' },
  { key: 'Oil, Gas, and Mining', label_fr: 'Pétrole & Mines' },
  { key: 'Utilities', label_fr: 'Énergie' },
  { key: 'Professional Services', label_fr: 'Services pro' },
  { key: 'Wholesale', label_fr: 'Commerce de gros' },
  { key: 'Retail', label_fr: 'Commerce de détail' },
  { key: 'Farming, Ranching, Forestry', label_fr: 'Agriculture' },
  { key: 'Hospitals and Health Care', label_fr: 'Santé' },
  { key: 'Education', label_fr: 'Éducation' },
  { key: 'Government Administration', label_fr: 'Admin. publique' },
  { key: 'Consumer Services', label_fr: 'Services conso' },
  { key: 'Administrative and Support Services', label_fr: 'Services admin' },
  { key: 'Financial Services', label_fr: 'Finance' },
]

export default function SectorSelector({ sectors, selected, onChange }) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [activeCat, setActiveCat] = useState('__ALL__')
  const ref = useRef(null)

  useEffect(() => {
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const selectedIds = new Set(selected.map(s => s.id))

  const grouped = useMemo(() => {
    const map = {}
    for (const s of sectors) {
      const cat = s.parent_category || 'Other'
      if (!map[cat]) map[cat] = []
      map[cat].push(s)
    }
    return map
  }, [sectors])

  // Filtrage : par recherche ou par catégorie active
  const displaySectors = useMemo(() => {
    if (search.length >= 2) {
      const q = search.toLowerCase()
      return sectors.filter(s => s.label_fr.toLowerCase().includes(q))
    }
    if (activeCat === '__ALL__') return sectors
    return grouped[activeCat] || []
  }, [sectors, grouped, search, activeCat])

  // Grouper les résultats par catégorie pour l'affichage
  const displayGrouped = useMemo(() => {
    const map = {}
    for (const s of displaySectors) {
      const cat = s.parent_category || 'Other'
      if (!map[cat]) map[cat] = []
      map[cat].push(s)
    }
    return map
  }, [displaySectors])

  const toggle = (sector) => {
    if (selectedIds.has(sector.id)) {
      onChange(selected.filter(s => s.id !== sector.id))
    } else {
      onChange([...selected, { id: sector.id, label: sector.label_fr, parent_category: sector.parent_category, type: 'include' }])
    }
  }

  const toggleType = (id) => {
    onChange(selected.map(s => s.id === id ? { ...s, type: s.type === 'include' ? 'exclude' : 'include' } : s))
  }

  const removeTag = (id) => {
    onChange(selected.filter(s => s.id !== id))
  }

  return (
    <div className="cf-field" ref={ref}>
      <label className="cf-label">Secteur d'activité</label>
      <p className="cf-help" style={{ marginBottom: 6 }}>Sélectionner les secteurs à inclure ou exclure</p>
      <div className="cf-tags-wrap">
        {selected.map(s => (
          <span key={s.id} className={`cf-tag cf-tag--${s.type}`} onClick={() => toggleType(s.id)} title="Cliquer pour basculer inclure/exclure">
            {s.type === 'exclude' && '- '}{s.label}
            <button type="button" onClick={(e) => { e.stopPropagation(); removeTag(s.id) }} className="cf-tag-remove"><X size={12} /></button>
          </span>
        ))}
      </div>
      <div className="cf-field-anchor">
        <button type="button" className="cf-select-trigger" onClick={() => setOpen(!open)}>
          Rechercher un secteur...
          <ChevronDown size={16} />
        </button>
        {open && (
          <div className="cf-panel">
            <div className="cf-panel-search">
              <Search size={14} />
              <input
                type="text"
                value={search}
                onChange={e => { setSearch(e.target.value); if (e.target.value.length >= 2) setActiveCat('__ALL__') }}
                placeholder="Rechercher un secteur..."
                autoFocus
              />
            </div>
            {/* Pills catégories scrollables */}
            {search.length < 2 && (
              <div className="cf-cat-pills">
                {PARENT_CATEGORIES.map(cat => {
                  const count = cat.key === '__ALL__' ? sectors.length : (grouped[cat.key] || []).length
                  if (cat.key !== '__ALL__' && count === 0) return null
                  return (
                    <button
                      key={cat.key}
                      type="button"
                      className={`cf-cat-pill ${activeCat === cat.key ? 'cf-cat-pill--active' : ''}`}
                      onClick={() => setActiveCat(cat.key)}
                    >
                      {cat.label_fr}
                    </button>
                  )
                })}
              </div>
            )}
            {/* Liste des secteurs groupés par catégorie */}
            <div className="cf-panel-list">
              {Object.entries(displayGrouped).map(([catKey, items]) => {
                const catLabel = PARENT_CATEGORIES.find(c => c.key === catKey)?.label_fr || catKey
                return (
                  <div key={catKey}>
                    <div className="cf-panel-cat-label">{catLabel.toUpperCase()}</div>
                    {items.map(s => (
                      <div
                        key={s.id}
                        className={`cf-dropdown-row ${selectedIds.has(s.id) ? 'cf-dropdown-row--active' : ''}`}
                        onClick={() => toggle(s)}
                        style={{ cursor: 'pointer' }}
                      >
                        <span className="cf-dropdown-row-label">{s.label_fr}</span>
                      </div>
                    ))}
                  </div>
                )
              })}
              {displaySectors.length === 0 && (
                <div className="cf-dropdown-empty">Aucun secteur trouvé</div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
