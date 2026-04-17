import { useMemo } from 'react'
import { buildSalesNavUrl } from '../../lib/buildSalesNavUrl'
import { ExternalLink, AlertTriangle } from 'lucide-react'

export default function SalesNavUrlPreview({ criteria }) {
  const isEmpty = !criteria.jobTitles?.length && !criteria.seniorities?.length &&
    !criteria.geoIds?.length && !criteria.sectorIds?.length &&
    !criteria.headcounts?.length && !criteria.keywords?.length

  const url = useMemo(() => {
    if (isEmpty) return null
    return buildSalesNavUrl(criteria)
  }, [criteria, isEmpty])

  const activeFilters = [
    criteria.jobTitles?.length && `${criteria.jobTitles.length} poste(s)`,
    criteria.seniorities?.length && `${criteria.seniorities.length} niveau(x)`,
    criteria.geoIds?.length && `${criteria.geoIds.length} zone(s)`,
    criteria.sectorIds?.length && `${criteria.sectorIds.length} secteur(s)`,
    criteria.headcounts?.length && `${criteria.headcounts.length} effectif(s)`,
    criteria.keywords?.length && `${criteria.keywords.length} mot(s)-clé(s)`,
  ].filter(Boolean)

  return (
    <div className={`cf-preview ${isEmpty ? 'cf-preview--empty' : ''}`}>
      <div className="cf-preview-header">
        <span className="cf-preview-title">URL Sales Navigator</span>
        {activeFilters.length > 0 && (
          <span className="cf-preview-badge">{activeFilters.length} filtre{activeFilters.length > 1 ? 's' : ''} actif{activeFilters.length > 1 ? 's' : ''}</span>
        )}
      </div>
      {isEmpty ? (
        <div className="cf-preview-warning">
          <AlertTriangle size={16} />
          Ajoutez au moins un filtre pour générer une URL valide
        </div>
      ) : (
        <>
          <div className="cf-preview-url" title={url}>
            {url.length > 120 ? url.slice(0, 120) + '...' : url}
          </div>
          <div className="cf-preview-meta">
            {activeFilters.join(' · ')}
          </div>
          <a href={url} target="_blank" rel="noopener noreferrer" className="cf-preview-link">
            <ExternalLink size={14} /> Tester dans Sales Navigator
          </a>
        </>
      )}
    </div>
  )
}
