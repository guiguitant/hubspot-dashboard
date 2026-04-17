import { useEffect, useState } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { setApiFetchContext } from './lib/apiFetch'
import LoginPage from './components/LoginPage'
import ProspectorLayout from './components/ProspectorLayout'
import CampaignFormPage from './components/campaigns/CampaignFormPage'

export default function App() {
  const [token, setToken] = useState(null)
  const [authAccount, setAuthAccount] = useState(null) // compte réel de l'utilisateur
  const [activeAccount, setActiveAccount] = useState(null) // compte actif (peut être switché par admin)
  const [allAccounts, setAllAccounts] = useState([]) // liste pour sélecteur admin
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    // Vérifier si un token existe en localStorage
    const storedToken = localStorage.getItem('auth_token')
    if (storedToken) {
      setToken(storedToken)
      initAccount(storedToken)
    } else {
      setLoading(false)
    }
  }, [])

  const handleLoginSuccess = (data) => {
    // Redirect immediately — don't setToken (causes flash of "Compte non autorisé")
    // Token is already in localStorage via LoginPage.jsx
    window.location.href = `/prospector?account_id=${data.account_id}`
  }

  const initAccount = async (authToken) => {
    try {
      const res = await fetch('/api/accounts/me', {
        headers: { 'Authorization': `Bearer ${authToken}` },
      })
      if (!res.ok) {
        setLoading(false)
        return
      }

      const { account } = await res.json()
      setAuthAccount(account)
      setApiFetchContext(null, account.is_admin)

      if (account.is_admin) {
        // Charger tous les comptes pour le sélecteur
        const resAll = await fetch('/api/accounts', {
          headers: { 'Authorization': `Bearer ${authToken}` },
        })
        if (resAll.ok) {
          const { accounts } = await resAll.json()
          setAllAccounts(accounts)
        }

        // Restaurer le compte actif depuis localStorage
        const savedAccountId = localStorage.getItem('activeAccountId')
        if (savedAccountId) {
          const resSwitched = await fetch('/api/accounts/me', {
            headers: {
              'Authorization': `Bearer ${authToken}`,
              'X-Switch-Account': savedAccountId,
            },
          })
          if (resSwitched.ok) {
            const { account: switchedAccount } = await resSwitched.json()
            setActiveAccount(switchedAccount)
            setApiFetchContext(savedAccountId, true)
          } else {
            setActiveAccount(account)
          }
        } else {
          setActiveAccount(account)
        }
      } else {
        setActiveAccount(account)
      }

      setLoading(false)
    } catch (err) {
      console.error('Error initializing account:', err)
      setLoading(false)
    }
  }

  const handleSwitchAccount = async (targetAccountId) => {
    if (!authAccount?.is_admin) return

    localStorage.setItem('activeAccountId', targetAccountId)

    try {
      const res = await fetch('/api/accounts/me', {
        headers: {
          'Authorization': `Bearer ${token}`,
          'X-Switch-Account': targetAccountId,
        },
      })
      if (res.ok) {
        const { account } = await res.json()
        setActiveAccount(account)
        setApiFetchContext(targetAccountId, true)
      }
    } catch (err) {
      console.error('Error switching account:', err)
    }
  }

  const handleLogout = () => {
    localStorage.removeItem('activeAccountId')
    localStorage.removeItem('auth_token')
    localStorage.removeItem('account_id')
    localStorage.removeItem('account_name')
    localStorage.removeItem('is_admin')
    setToken(null)
    setAuthAccount(null)
    setActiveAccount(null)
  }

  if (loading) return <div className="loading-screen">Chargement...</div>

  // Si pas de token et qu'on est sur /campaigns/new → rediriger vers login
  if (!token) {
    const onCampaignRoute = window.location.pathname.startsWith('/campaigns')
    if (onCampaignRoute) {
      window.location.href = '/prospector-login'
      return null
    }
    return <LoginPage onLoginSuccess={handleLoginSuccess} />
  }

  if (!activeAccount) return <div className="error-screen">Compte non autorisé. Contactez Nathan.</div>

  // Layout prospector (sidebar + main) avec le formulaire dans le main content
  return (
    <ProspectorLayout account={activeAccount}>
      <Routes>
        <Route path="/campaigns/new" element={<CampaignFormPage account={activeAccount} />} />
        <Route path="/campaigns/edit/:id" element={<CampaignFormPage account={activeAccount} />} />
        <Route path="*" element={<RedirectToProspector />} />
      </Routes>
    </ProspectorLayout>
  )
}

function RedirectToProspector() {
  window.location.href = '/prospector'
  return null
}
