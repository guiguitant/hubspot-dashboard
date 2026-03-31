import { useState } from 'react'
import { supabase } from '../lib/supabase'

export default function LoginPage() {
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const handleLogin = async (e) => {
    e.preventDefault()
    setLoading(true)
    setError('')

    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: `${window.location.origin}/prospector-app`,
      },
    })

    setLoading(false)
    if (error) {
      setError(error.message)
    } else {
      setSent(true)
    }
  }

  if (sent) {
    return (
      <div className="login-container">
        <div className="login-card">
          <div className="login-logo">🌱 Releaf Carbon</div>
          <h2>Vérifiez votre email</h2>
          <p>Un lien de connexion a été envoyé à <strong>{email}</strong>.</p>
          <p className="hint">Cliquez sur le lien dans l'email pour accéder à l'espace prospection.</p>
          <button className="btn-secondary" onClick={() => setSent(false)}>
            ← Retour
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="login-container">
      <div className="login-card">
        <div className="login-logo">🌱 Releaf Carbon</div>
        <h2>Connexion</h2>
        <p>Entrez votre email pour recevoir un lien de connexion.</p>
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
          {error && <p className="error-msg">{error}</p>}
          <button type="submit" disabled={loading} className="btn-primary">
            {loading ? 'Envoi...' : 'Envoyer le lien'}
          </button>
        </form>
      </div>
    </div>
  )
}
