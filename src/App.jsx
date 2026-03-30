import { useEffect, useState } from 'react'
import { supabase } from './lib/supabase'
import { setApiFetchContext } from './lib/apiFetch'
import LoginPage from './components/LoginPage'

export default function App() {
  const [session, setSession] = useState(null)
  const [authAccount, setAuthAccount] = useState(null) // compte réel de l'utilisateur
  const [activeAccount, setActiveAccount] = useState(null) // compte actif (peut être switché par admin)
  const [allAccounts, setAllAccounts] = useState([]) // liste pour sélecteur admin
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    // Récupérer la session actuelle
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session)
      if (session) {
        initAccount(session)
      } else {
        setLoading(false)
      }
    })

    // Écouter les changements d'authentification
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session)
      if (session) {
        initAccount(session)
      } else {
        setAuthAccount(null)
        setActiveAccount(null)
        sessionStorage.removeItem('activeAccountId')
        setLoading(false)
      }
    })

    return () => subscription?.unsubscribe()
  }, [])

  const initAccount = async (session) => {
    try {
      const res = await fetch('/api/accounts/me', {
        headers: { 'Authorization': `Bearer ${session.access_token}` },
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
          headers: { 'Authorization': `Bearer ${session.access_token}` },
        })
        if (resAll.ok) {
          const { accounts } = await resAll.json()
          setAllAccounts(accounts)
        }

        // Restaurer le compte actif depuis sessionStorage
        const savedAccountId = sessionStorage.getItem('activeAccountId')
        if (savedAccountId) {
          const resSwitched = await fetch('/api/accounts/me', {
            headers: {
              'Authorization': `Bearer ${session.access_token}`,
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

    sessionStorage.setItem('activeAccountId', targetAccountId)
    const { data: { session: s } } = await supabase.auth.getSession()

    try {
      const res = await fetch('/api/accounts/me', {
        headers: {
          'Authorization': `Bearer ${s.access_token}`,
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

  const handleLogout = async () => {
    sessionStorage.removeItem('activeAccountId')
    await supabase.auth.signOut()
    setAuthAccount(null)
    setActiveAccount(null)
    setSession(null)
  }

  if (loading) return <div className="loading-screen">Chargement...</div>
  if (!session) return <LoginPage />
  if (!activeAccount) return <div className="error-screen">Compte non autorisé. Contactez Nathan.</div>

  return (
    <div className="app-container">
      <Header
        account={activeAccount}
        authAccount={authAccount}
        allAccounts={allAccounts}
        onSwitchAccount={handleSwitchAccount}
        onLogout={handleLogout}
      />
      <MainApp account={activeAccount} />
    </div>
  )
}

function Header({ account, authAccount, allAccounts, onSwitchAccount, onLogout }) {
  return (
    <header className="app-header">
      <div className="header-left">
        <h1>🌱 Releaf Prospector</h1>
      </div>
      <div className="header-right">
        {authAccount?.is_admin && allAccounts.length > 0 && (
          <div className="admin-account-switcher">
            <span className="admin-badge">🔧 Admin</span>
            <select
              value={account.id}
              onChange={e => onSwitchAccount(e.target.value)}
              className="account-select"
            >
              {allAccounts.map(a => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </div>
        )}
        <span className="account-name">{account.name}</span>
        <button onClick={onLogout} className="logout-btn">
          Déconnexion
        </button>
      </div>
    </header>
  )
}

function MainApp({ account }) {
  return (
    <main className="app-main">
      <div className="placeholder-message">
        <p>Bienvenue dans l'espace prospection, {account.name}!</p>
        <p>Le dashboard sera intégré ici.</p>
      </div>
    </main>
  )
}
