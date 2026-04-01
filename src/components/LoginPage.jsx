import { useState } from 'react'

export default function LoginPage({ onLoginSuccess }) {
  const [email, setEmail] = useState('')
  const [pin, setPin] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [focused, setFocused] = useState(null)

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
      // Store token and account info in localStorage (shared across tabs)
      localStorage.setItem('auth_token', data.token)
      localStorage.setItem('account_id', data.account_id)
      localStorage.setItem('account_name', data.account_name)
      localStorage.setItem('is_admin', data.is_admin)

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
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700&family=DM+Serif+Display&display=swap');

        .login-page {
          min-height: 100vh;
          display: flex;
          align-items: center;
          justify-content: center;
          position: relative;
          overflow: hidden;
          font-family: 'DM Sans', sans-serif;
          background: #F6F8F5;
        }

        /* Soft gradient background */
        .login-bg {
          position: absolute;
          inset: 0;
          background:
            radial-gradient(ellipse at 20% 40%, rgba(45,106,79,0.08) 0%, transparent 60%),
            radial-gradient(ellipse at 80% 20%, rgba(183,228,199,0.2) 0%, transparent 50%),
            radial-gradient(ellipse at 50% 90%, rgba(45,106,79,0.05) 0%, transparent 50%),
            linear-gradient(170deg, #F6F8F5 0%, #EDF2EE 50%, #F0F5F1 100%);
        }

        /* Subtle grain texture overlay */
        .login-grain {
          position: absolute;
          inset: 0;
          opacity: 0.02;
          background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)'/%3E%3C/svg%3E");
          pointer-events: none;
        }

        /* Floating leaf shapes */
        .login-leaf {
          position: absolute;
          border-radius: 0 70% 0 70%;
          pointer-events: none;
        }
        .login-leaf-1 {
          width: 340px; height: 340px;
          background: linear-gradient(135deg, rgba(45,106,79,0.06), rgba(183,228,199,0.1));
          top: -100px; right: -80px;
          transform: rotate(25deg);
          animation: leafFloat1 8s ease-in-out infinite alternate;
        }
        .login-leaf-2 {
          width: 240px; height: 240px;
          background: linear-gradient(135deg, rgba(183,228,199,0.12), rgba(45,106,79,0.05));
          bottom: -60px; left: -50px;
          transform: rotate(-15deg);
          animation: leafFloat2 10s ease-in-out infinite alternate;
        }
        .login-leaf-3 {
          width: 160px; height: 160px;
          background: rgba(45,106,79,0.04);
          top: 35%; left: 6%;
          transform: rotate(45deg);
          animation: leafFloat3 7s ease-in-out infinite alternate;
        }

        @keyframes leafFloat1 { to { transform: rotate(30deg) translateY(15px); } }
        @keyframes leafFloat2 { to { transform: rotate(-20deg) translateX(10px); } }
        @keyframes leafFloat3 { to { transform: rotate(50deg) translateY(-10px); } }

        /* Card */
        .login-card-new {
          position: relative;
          z-index: 2;
          width: 100%;
          max-width: 420px;
          margin: 20px;
          background: #FFFFFF;
          border: 1px solid rgba(45,106,79,0.08);
          border-radius: 24px;
          padding: 48px 40px;
          box-shadow:
            0 4px 24px rgba(45,106,79,0.06),
            0 20px 60px rgba(0,0,0,0.04);
          animation: cardIn 0.6s cubic-bezier(0.16, 1, 0.3, 1) both;
        }

        @keyframes cardIn {
          from { opacity: 0; transform: translateY(20px) scale(0.97); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }

        /* Logo */
        .login-logo-new {
          display: flex;
          justify-content: center;
          margin-bottom: 32px;
        }
        .login-logo-new img {
          height: 120px;
        }

        /* Title */
        .login-title {
          font-family: 'DM Serif Display', serif;
          font-size: 28px;
          font-weight: 400;
          color: #1E293B;
          text-align: center;
          margin-bottom: 8px;
          letter-spacing: -0.01em;
        }

        .login-subtitle {
          text-align: center;
          color: #94A3B8;
          font-size: 14px;
          margin-bottom: 36px;
          font-weight: 400;
        }

        /* Form fields */
        .login-field {
          position: relative;
          margin-bottom: 20px;
        }

        .login-field label {
          display: block;
          font-size: 12px;
          font-weight: 500;
          color: #94A3B8;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          margin-bottom: 8px;
          transition: color 0.2s;
        }

        .login-field.field-focused label {
          color: #2D6A4F;
        }

        .login-field input {
          width: 100%;
          padding: 14px 18px;
          background: #F8FAF9;
          border: 1px solid #E2E8F0;
          border-radius: 12px;
          color: #1E293B;
          font-family: 'DM Sans', sans-serif;
          font-size: 15px;
          transition: all 0.25s ease;
          outline: none;
        }

        .login-field input::placeholder {
          color: #CBD5E1;
        }

        .login-field input:focus {
          border-color: #2D6A4F;
          background: #FFFFFF;
          box-shadow: 0 0 0 4px rgba(45,106,79,0.08);
        }

        /* Error message */
        .login-error {
          background: rgba(239,68,68,0.12);
          border: 1px solid rgba(239,68,68,0.25);
          color: #FCA5A5;
          padding: 12px 16px;
          border-radius: 12px;
          font-size: 13px;
          margin-bottom: 20px;
          text-align: center;
          animation: errorShake 0.4s ease;
        }

        @keyframes errorShake {
          0%, 100% { transform: translateX(0); }
          20% { transform: translateX(-6px); }
          40% { transform: translateX(6px); }
          60% { transform: translateX(-4px); }
          80% { transform: translateX(4px); }
        }

        /* Submit button */
        .login-submit {
          width: 100%;
          padding: 15px;
          border: none;
          border-radius: 12px;
          font-family: 'DM Sans', sans-serif;
          font-size: 15px;
          font-weight: 600;
          cursor: pointer;
          position: relative;
          overflow: hidden;
          color: #fff;
          background: linear-gradient(135deg, #2D6A4F 0%, #1B4332 100%);
          box-shadow: 0 4px 20px rgba(45,106,79,0.35);
          transition: all 0.3s ease;
          margin-top: 8px;
        }

        .login-submit:hover:not(:disabled) {
          transform: translateY(-1px);
          box-shadow: 0 6px 28px rgba(45,106,79,0.5);
          background: linear-gradient(135deg, #358B63 0%, #245840 100%);
        }

        .login-submit:active:not(:disabled) {
          transform: translateY(0);
        }

        .login-submit:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }

        .login-submit .btn-shine {
          position: absolute;
          top: 0; left: -100%;
          width: 100%; height: 100%;
          background: linear-gradient(90deg, transparent, rgba(255,255,255,0.1), transparent);
          transition: left 0.5s ease;
        }

        .login-submit:hover:not(:disabled) .btn-shine {
          left: 100%;
        }

        /* Footer */
        .login-footer {
          text-align: center;
          margin-top: 28px;
          color: #CBD5E1;
          font-size: 12px;
        }

        /* Responsive */
        @media (max-width: 480px) {
          .login-card-new {
            padding: 36px 28px;
            margin: 16px;
            border-radius: 20px;
          }
          .login-title { font-size: 24px; }
        }
      `}</style>

      <div className="login-page">
        <div className="login-bg" />
        <div className="login-grain" />
        <div className="login-leaf login-leaf-1" />
        <div className="login-leaf login-leaf-2" />
        <div className="login-leaf login-leaf-3" />

        <div className="login-card-new">
          <div className="login-logo-new">
            <img src="/img/logo-releaf-prospector.png" alt="Releaf Prospector" />
          </div>

          <h1 className="login-title">Connexion</h1>
          <p className="login-subtitle">Accédez à votre espace de prospection</p>

          <form onSubmit={handleLogin}>
            <div className={`login-field ${focused === 'email' ? 'field-focused' : ''}`}>
              <label htmlFor="login-email">Email</label>
              <input
                id="login-email"
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                onFocus={() => setFocused('email')}
                onBlur={() => setFocused(null)}
                placeholder="votre@email.com"
                required
                autoFocus
                autoComplete="email"
              />
            </div>

            <div className={`login-field ${focused === 'pin' ? 'field-focused' : ''}`}>
              <label htmlFor="login-pin">Code PIN</label>
              <input
                id="login-pin"
                type="password"
                value={pin}
                onChange={e => setPin(e.target.value)}
                onFocus={() => setFocused('pin')}
                onBlur={() => setFocused(null)}
                placeholder="Votre code PIN"
                required
                autoComplete="current-password"
                maxLength="10"
              />
            </div>

            {error && <div className="login-error">{error}</div>}

            <button type="submit" disabled={loading} className="login-submit">
              <span className="btn-shine" />
              {loading ? 'Connexion en cours...' : 'Se connecter'}
            </button>
          </form>

          <div className="login-footer">
            Releaf Carbon &middot; Prospector
          </div>
        </div>
      </div>
    </>
  )
}
