import { useState, useEffect, useReducer } from 'react'
// Navigation vers /prospector (vanilla JS) — pas useNavigate (React Router)

import { apiFetch } from '../../lib/apiFetch'
import { ArrowLeft } from 'lucide-react'
import SalesNavTagInput from './SalesNavTagInput'
import SectorSelector from './SectorSelector'
import GeoSearch from './GeoSearch'
import SeniorityPicker from './SeniorityPicker'
import HeadcountPicker from './HeadcountPicker'
import KeywordTagInput from './KeywordTagInput'
import SalesNavUrlPreview from './SalesNavUrlPreview'
import './CampaignForm.css'

const initialState = {
  name: '',
  priority: 3,
  targetCount: '',
  criteria: {
    jobTitles: [],
    seniorities: [],
    geoIds: [],
    sectorIds: [],
    headcounts: [],
    keywords: [],
  },
  messageTemplate: '',
  isSubmitting: false,
  errors: {},
}

function reducer(state, action) {
  switch (action.type) {
    case 'SET_FIELD':
      return { ...state, [action.field]: action.value, errors: { ...state.errors, [action.field]: null } }
    case 'SET_CRITERIA':
      return { ...state, criteria: { ...state.criteria, [action.field]: action.value }, errors: { ...state.errors, criteria: null } }
    case 'SET_ERRORS':
      return { ...state, errors: action.errors }
    case 'SET_SUBMITTING':
      return { ...state, isSubmitting: action.value }
    default:
      return state
  }
}

function isCriteriaEmpty(c) {
  return !c.jobTitles?.length && !c.seniorities?.length && !c.geoIds?.length &&
    !c.sectorIds?.length && !c.headcounts?.length && !c.keywords?.length
}

export default function CampaignFormPage({ account }) {
  const goBack = () => { window.location.href = '/prospector' }
  const [form, dispatch] = useReducer(reducer, initialState)
  const [sectors, setSectors] = useState([])
  const [geos, setGeos] = useState([])
  const [loadingRef, setLoadingRef] = useState(true)

  useEffect(() => {
    Promise.all([
      apiFetch('/api/prospector/reference/sectors').then(r => r.json()),
      apiFetch('/api/prospector/reference/geos').then(r => r.json()),
    ]).then(([s, g]) => {
      setSectors(s)
      setGeos(g)
    }).catch(err => console.error('Error loading reference data:', err))
      .finally(() => setLoadingRef(false))
  }, [])

  const validate = () => {
    const errors = {}
    if (!form.name.trim()) errors.name = 'Le nom est requis'
    if (isCriteriaEmpty(form.criteria)) errors.criteria = 'Ajoutez au moins un critère de recherche'
    if (form.targetCount && (isNaN(form.targetCount) || Number(form.targetCount) < 1)) errors.targetCount = 'Nombre positif requis'
    return errors
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    const errors = validate()
    if (Object.keys(errors).length > 0) {
      dispatch({ type: 'SET_ERRORS', errors })
      return
    }
    dispatch({ type: 'SET_SUBMITTING', value: true })
    try {
      const body = {
        name: form.name.trim(),
        priority: Number(form.priority),
        criteria: form.criteria,
        message_template: form.messageTemplate || null,
        target_count: form.targetCount ? Number(form.targetCount) : null,
      }
      const res = await apiFetch('/api/prospector/campaigns', { method: 'POST', body: JSON.stringify(body) })
      if (!res.ok) {
        const data = await res.json()
        dispatch({ type: 'SET_ERRORS', errors: { submit: data.error || 'Erreur serveur' } })
        return
      }
      window.location.href = '/prospector'
    } catch (err) {
      dispatch({ type: 'SET_ERRORS', errors: { submit: err.message } })
    } finally {
      dispatch({ type: 'SET_SUBMITTING', value: false })
    }
  }

  if (loadingRef) return <div className="cf-loading">Chargement des données de référence...</div>

  return (
    <div className="cf-page">
      <div className="cf-header">
        <button type="button" className="cf-back" onClick={goBack}>
          <ArrowLeft size={18} /> Campagnes
        </button>
        <h2>Nouvelle campagne</h2>
      </div>

      <form onSubmit={handleSubmit} className="cf-form">
        {/* Section 1 — Informations générales */}
        <section className="cf-section">
          <h3 className="cf-section-title">Informations générales</h3>
          <div className="cf-row">
            <div className="cf-field cf-field--grow">
              <label className="cf-label">Nom de la campagne *</label>
              <input
                type="text"
                value={form.name}
                onChange={e => dispatch({ type: 'SET_FIELD', field: 'name', value: e.target.value })}
                placeholder="BTP Île-de-France QHSE Q1"
                className={`cf-input ${form.errors.name ? 'cf-input--error' : ''}`}
              />
              {form.errors.name && <span className="cf-error">{form.errors.name}</span>}
            </div>
            <div className="cf-field" style={{ width: 120 }}>
              <label className="cf-label">Priorité</label>
              <select
                value={form.priority}
                onChange={e => dispatch({ type: 'SET_FIELD', field: 'priority', value: e.target.value })}
                className="cf-input"
              >
                {[1, 2, 3, 4, 5].map(n => <option key={n} value={n}>{n}</option>)}
              </select>
            </div>
            <div className="cf-field" style={{ width: 160 }}>
              <label className="cf-label">Prospects cible</label>
              <input
                type="number"
                value={form.targetCount}
                onChange={e => dispatch({ type: 'SET_FIELD', field: 'targetCount', value: e.target.value })}
                placeholder="150"
                min="1"
                className={`cf-input ${form.errors.targetCount ? 'cf-input--error' : ''}`}
              />
              {form.errors.targetCount && <span className="cf-error">{form.errors.targetCount}</span>}
            </div>
          </div>
        </section>

        {/* Section 2 — Critères de recherche */}
        <section className="cf-section">
          <h3 className="cf-section-title">Critères de recherche Sales Navigator</h3>
          {form.errors.criteria && <div className="cf-error cf-error--block">{form.errors.criteria}</div>}
          <div className="cf-grid-2">
            <SalesNavTagInput
              label="Intitulé de poste actuel"
              sublabel="Ajouter des postes à inclure ou exclure"
              tags={form.criteria.jobTitles}
              onChange={v => dispatch({ type: 'SET_CRITERIA', field: 'jobTitles', value: v })}
              placeholder="Ajouter des postes actuels"
            />
            <SectorSelector
              sectors={sectors}
              selected={form.criteria.sectorIds}
              onChange={v => dispatch({ type: 'SET_CRITERIA', field: 'sectorIds', value: v })}
            />
            <SeniorityPicker
              selected={form.criteria.seniorities}
              onChange={v => dispatch({ type: 'SET_CRITERIA', field: 'seniorities', value: v })}
            />
            <HeadcountPicker
              selected={form.criteria.headcounts}
              onChange={v => dispatch({ type: 'SET_CRITERIA', field: 'headcounts', value: v })}
            />
            <GeoSearch
              geos={geos}
              selected={form.criteria.geoIds}
              onChange={v => dispatch({ type: 'SET_CRITERIA', field: 'geoIds', value: v })}
            />
          </div>
        </section>

        {/* Section 3 — Mots-clés */}
        <section className="cf-section">
          <h3 className="cf-section-title">Mots-clés</h3>
          <KeywordTagInput
            keywords={form.criteria.keywords}
            onChange={v => dispatch({ type: 'SET_CRITERIA', field: 'keywords', value: v })}
          />
        </section>

        {/* Section 4 — Instructions Claude */}
        <section className="cf-section">
          <h3 className="cf-section-title">Instructions pour Claude</h3>
          <div className="cf-field">
            <label className="cf-label">Instructions de personnalisation pour la séquence de messages</label>
            <textarea
              value={form.messageTemplate}
              onChange={e => dispatch({ type: 'SET_FIELD', field: 'messageTemplate', value: e.target.value })}
              placeholder="Mentionner la réglementation RE2020, approche RSE décarbonation..."
              rows={3}
              className="cf-input cf-textarea"
            />
            <p className="cf-help">Ce texte sera transmis à Claude pour personnaliser les messages envoyés</p>
          </div>
        </section>

        {/* Section 5 — Preview URL */}
        <section className="cf-section">
          <SalesNavUrlPreview criteria={form.criteria} />
        </section>

        {/* Submit */}
        {form.errors.submit && <div className="cf-error cf-error--block">{form.errors.submit}</div>}
        <div className="cf-actions">
          <button type="button" className="cf-btn cf-btn--secondary" onClick={goBack}>Annuler</button>
          <button
            type="submit"
            className="cf-btn cf-btn--primary"
            disabled={form.isSubmitting || isCriteriaEmpty(form.criteria)}
          >
            {form.isSubmitting ? 'Création...' : 'Créer la campagne'}
          </button>
        </div>
      </form>
    </div>
  )
}
