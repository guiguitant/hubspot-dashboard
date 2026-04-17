import { useState, useRef, useEffect } from 'react'
import { HEADCOUNT_OPTIONS } from '../../lib/constants'
import { ChevronDown, X } from 'lucide-react'

export default function HeadcountPicker({ selected, onChange }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const toggle = (code) => {
    if (selected.includes(code)) {
      onChange(selected.filter(c => c !== code))
    } else {
      onChange([...selected, code])
    }
  }

  const selectedLabels = selected.map(code => HEADCOUNT_OPTIONS.find(o => o.code === code)?.label).filter(Boolean)

  return (
    <div className="cf-field" ref={ref}>
      <label className="cf-label">Effectifs de l'entreprise</label>
      <p className="cf-help" style={{ marginBottom: 6 }}>Sélectionner les tranches d'effectifs</p>
      {selected.length > 0 && (
        <div className="cf-tags-wrap">
          {selected.map(code => {
            const opt = HEADCOUNT_OPTIONS.find(o => o.code === code)
            return (
              <span key={code} className="cf-tag cf-tag--include">
                {opt?.label}
                <button type="button" onClick={() => toggle(code)} className="cf-tag-remove"><X size={12} /></button>
              </span>
            )
          })}
        </div>
      )}
      <div className="cf-field-anchor">
        <button type="button" className="cf-select-trigger" onClick={() => setOpen(!open)}>
          {selected.length ? `${selected.length} tranche${selected.length > 1 ? 's' : ''} sélectionnée${selected.length > 1 ? 's' : ''}` : 'Sélectionner des tranches...'}
          <ChevronDown size={16} />
        </button>
        {open && (
          <div className="cf-dropdown-panel">
            <div className="cf-dropdown-list">
              {HEADCOUNT_OPTIONS.map(opt => (
                <div
                  key={opt.code}
                  className={`cf-dropdown-row cf-dropdown-row--selectable ${selected.includes(opt.code) ? 'cf-dropdown-row--highlight' : ''}`}
                  onClick={() => toggle(opt.code)}
                >
                  <span className="cf-dropdown-row-label">{opt.label}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
