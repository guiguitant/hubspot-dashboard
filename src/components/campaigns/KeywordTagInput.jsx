import { useState, useRef } from 'react'
import { X } from 'lucide-react'

const MAX_KEYWORDS = 5

export default function KeywordTagInput({ keywords, onChange }) {
  const [input, setInput] = useState('')
  const inputRef = useRef(null)
  const atLimit = keywords.length >= MAX_KEYWORDS

  const add = () => {
    const value = input.trim()
    if (!value || atLimit) return
    if (keywords.includes(value)) return
    onChange([...keywords, value])
    setInput('')
    inputRef.current?.focus()
  }

  const remove = (index) => {
    onChange(keywords.filter((_, i) => i !== index))
  }

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      add()
    }
  }

  return (
    <div className="cf-field">
      <label className="cf-label">
        Mots-clés <span className="cf-label-hint">{keywords.length}/{MAX_KEYWORDS}</span>
      </label>
      <div className="cf-tags-wrap">
        {keywords.map((kw, i) => (
          <span key={i} className="cf-tag cf-tag--include">
            {kw}
            <button type="button" onClick={() => remove(i)} className="cf-tag-remove"><X size={12} /></button>
          </span>
        ))}
      </div>
      <input
        ref={inputRef}
        type="text"
        value={input}
        onChange={e => setInput(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={atLimit ? 'Maximum atteint' : 'Bilan Carbone, RSE, RE2020...'}
        disabled={atLimit}
        className="cf-input"
      />
      <p className="cf-help">Les mots-clés sont recherchés dans les profils et entreprises</p>
    </div>
  )
}
