import { useState, useRef, useEffect } from 'react'
import { SENIORITY_OPTIONS } from '../../lib/constants'
import { ChevronDown, X } from 'lucide-react'

export default function SeniorityPicker({ selected, onChange }) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const ref = useRef(null)

  useEffect(() => {
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const getState = (code) => {
    const item = selected.find(s => s.code === code)
    return item ? item.type : null
  }

  const setType = (code, type) => {
    const without = selected.filter(s => s.code !== code)
    onChange([...without, { code, type }])
  }

  const remove = (code) => {
    onChange(selected.filter(s => s.code !== code))
  }

  const filtered = search.length > 0
    ? SENIORITY_OPTIONS.filter(o => o.label.toLowerCase().includes(search.toLowerCase()))
    : SENIORITY_OPTIONS

  return (
    <div className="cf-field" ref={ref}>
      <label className="cf-label">Niveau hiérarchique</label>
      <p className="cf-help" style={{ marginBottom: 6 }}>Sélectionner les niveaux à inclure ou exclure</p>
      <div className="cf-tags-wrap">
        {selected.map(s => {
          const opt = SENIORITY_OPTIONS.find(o => o.code === s.code)
          return (
            <span key={s.code} className={`cf-tag cf-tag--${s.type}`}>
              {s.type === 'exclude' && '- '}{opt?.label || s.code}
              <button type="button" onClick={() => remove(s.code)} className="cf-tag-remove"><X size={12} /></button>
            </span>
          )
        })}
      </div>
      <div className="cf-field-anchor">
        <button type="button" className="cf-select-trigger" onClick={() => setOpen(!open)}>
          Rechercher un niveau...
          <ChevronDown size={16} />
        </button>
        {open && (
          <div className="cf-dropdown-panel">
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Rechercher un niveau..."
            className="cf-dropdown-search"
            autoFocus
          />
          <div className="cf-dropdown-list">
            {filtered.map(opt => {
              const state = getState(opt.code)
              return (
                <div key={opt.code} className={`cf-dropdown-row ${state ? 'cf-dropdown-row--active' : ''}`}>
                  <span className="cf-dropdown-row-label">{opt.label}</span>
                  <span className="cf-dropdown-row-actions">
                    <button
                      type="button"
                      className={`cf-action-btn cf-action-btn--include ${state === 'include' ? 'cf-action-btn--selected' : ''}`}
                      onClick={() => state === 'include' ? remove(opt.code) : setType(opt.code, 'include')}
                    >Inclure</button>
                    <span className="cf-action-sep">|</span>
                    <button
                      type="button"
                      className={`cf-action-btn cf-action-btn--exclude ${state === 'exclude' ? 'cf-action-btn--selected' : ''}`}
                      onClick={() => state === 'exclude' ? remove(opt.code) : setType(opt.code, 'exclude')}
                    >Exclure</button>
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      )}
      </div>
    </div>
  )
}
