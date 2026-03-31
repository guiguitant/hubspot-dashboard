import { useState } from 'react'

export default function LoginPage({ onLoginSuccess }) {
  const [email, setEmail] = useState('')
  const [pin, setPin] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const handleLogin = async (e) => {
    e.preventDefault()
    setLoading(true)
    setError('')

    try {
      const res = await fetch('/api/accounts/login-pin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, pin })
      })

      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || 'Erreur de connexion')
      }

      const data = await res.json()
      // Store token in sessionStorage
      sessionStorage.setItem('supabase.auth.token', data.token)
      sessionStorage.setItem('account_id', data.account_id)
      sessionStorage.setItem('account_name', data.account_name)
      sessionStorage.setItem('is_admin', data.is_admin)

      // Call callback to update app state
      if (onLoginSuccess) {
        onLoginSuccess(data)
      }
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="login-container">
      <div className="login-card">
        <div className="login-logo">🌱 Releaf Carbon</div>
        <h2>Connexion Prospector</h2>
        <p>Entrez votre email et votre code PIN.</p>
        <form onSubmit={handleLogin}>
          <input
            type="email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            placeholder="votre@email.com"
            required
            autoFocus
            className="email-input"
          />
          <input
            type="password"
            value={pin}
            onChange={e => setPin(e.target.value)}
            placeholder="Code PIN"
            required
            className="email-input"
            maxLength="10"
          />
          {error && <p className="error-msg">{error}</p>}
          <button type="submit" disabled={loading} className="btn-primary">
            {loading ? 'Connexion...' : 'Se connecter'}
          </button>
        </form>
      </div>
    </div>
  )
}
