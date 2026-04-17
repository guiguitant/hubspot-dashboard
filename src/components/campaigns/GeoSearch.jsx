import { useState, useRef, useEffect, useMemo } from 'react'
import { X, ChevronDown } from 'lucide-react'

const GEO_ORDER = { COUNTRY: 0, REGION: 1, CITY: 2 }

export default function GeoSearch({ geos, selected, onChange }) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const ref = useRef(null)

  useEffect(() => {
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const selectedIds = new Set(selected.map(g => g.id))

  const filtered = useMemo(() => {
    const list = search.length >= 2
      ? geos.filter(g => g.label_fr.toLowerCase().includes(search.toLowerCase()))
      : geos
    return list
      .filter(g => !selectedIds.has(g.id))
      .sort((a, b) => (GEO_ORDER[a.geo_type] ?? 9) - (GEO_ORDER[b.geo_type] ?? 9))
  }, [geos, search, selectedIds])

  const addGeo = (geo, type) => {
    onChange([...selected, { id: geo.id, text: geo.label_fr, type }])
  }

  const removeGeo = (id) => {
    onChange(selected.filter(g => g.id !== id))
  }

  const toggleType = (id) => {
    onChange(selected.map(g => g.id === id ? { ...g, type: g.type === 'include' ? 'exclude' : 'include' } : g))
  }

  return (
    <div className="cf-field" ref={ref}>
      <label className="cf-label">Zone géographique</label>
      <p className="cf-help" style={{ marginBottom: 6 }}>Rechercher et ajouter des zones</p>
      <div className="cf-tags-wrap">
        {selected.map(g => (
          <span key={g.id} className={`cf-tag cf-tag--${g.type}`} onClick={() => toggleType(g.id)} title="Cliquer pour basculer inclure/exclure">
            {g.type === 'exclude' && '- '}{g.text}
            <button type="button" onClick={(e) => { e.stopPropagation(); removeGeo(g.id) }} className="cf-tag-remove"><X size={12} /></button>
          </span>
        ))}
      </div>
      <div className="cf-field-anchor">
        <button type="button" className="cf-select-trigger" onClick={() => setOpen(!open)}>
          Ajouter des lieux
          <ChevronDown size={16} />
        </button>
        {open && (
          <div className="cf-dropdown-panel">
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Ajouter des lieux"
            className="cf-dropdown-search"
            autoFocus
          />
          <div className="cf-dropdown-list">
            {filtered.length === 0 ? (
              <div className="cf-dropdown-empty">
                Aucune zone trouvée — la recherche au niveau département n'est pas disponible sur LinkedIn
              </div>
            ) : (
              filtered.slice(0, 20).map(g => (
                <div key={g.id} className="cf-dropdown-row">
                  <span className="cf-dropdown-row-label">{g.label_fr}</span>
                  <span className="cf-dropdown-row-actions">
                    <button
                      type="button"
                      className="cf-action-btn cf-action-btn--include"
                      onClick={() => addGeo(g, 'include')}
                    >Inclure</button>
                    <span className="cf-action-sep">|</span>
                    <button
                      type="button"
                      className="cf-action-btn cf-action-btn--exclude"
                      onClick={() => addGeo(g, 'exclude')}
                    >Exclure</button>
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
      )}
      </div>
    </div>
  )
}
