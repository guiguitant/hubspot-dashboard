import { useState, useRef, useEffect } from 'react'
import { X, ChevronDown } from 'lucide-react'

export default function SalesNavTagInput({ label, sublabel, tags, onChange, placeholder }) {
  const [input, setInput] = useState('')
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  const inputRef = useRef(null)

  useEffect(() => {
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const addTag = (type) => {
    const value = input.trim()
    if (!value) return
    onChange([...tags, { value, type }])
    setInput('')
    inputRef.current?.focus()
  }

  const removeTag = (index) => {
    onChange(tags.filter((_, i) => i !== index))
  }

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      addTag('include')
    }
  }

  return (
    <div className="cf-field" ref={ref}>
      {label && <label className="cf-label">{label}</label>}
      {sublabel && <p className="cf-help" style={{ marginBottom: 6 }}>{sublabel}</p>}
      <div className="cf-tags-wrap">
        {tags.map((tag, i) => (
          <span key={i} className={`cf-tag cf-tag--${tag.type}`}>
            {tag.type === 'exclude' && '- '}{tag.value}
            <button type="button" onClick={() => removeTag(i)} className="cf-tag-remove"><X size={12} /></button>
          </span>
        ))}
      </div>
      <div className="cf-field-anchor">
        <button type="button" className="cf-select-trigger" onClick={() => setOpen(!open)}>
          {placeholder || 'Ajouter...'}
          <ChevronDown size={16} />
        </button>
        {open && (
          <div className="cf-dropdown-panel">
            <input
              ref={inputRef}
              type="text"
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={placeholder || 'Ajouter...'}
              className="cf-dropdown-search"
              autoFocus
            />
            {input.trim() && (
              <div className="cf-dropdown-list">
                <div className="cf-dropdown-row">
                  <span className="cf-dropdown-row-label">{input.trim()}</span>
                  <span className="cf-dropdown-row-actions">
                    <button type="button" className="cf-action-btn cf-action-btn--include" onClick={() => addTag('include')}>Inclure</button>
                    <span className="cf-action-sep">|</span>
                    <button type="button" className="cf-action-btn cf-action-btn--exclude" onClick={() => addTag('exclude')}>Exclure</button>
                  </span>
                </div>
              </div>
            )}
            {!input.trim() && (
              <div className="cf-dropdown-empty">Tapez un intitulé puis cliquez Inclure ou Exclure</div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
