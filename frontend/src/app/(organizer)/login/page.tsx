'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [showForgotPassword, setShowForgotPassword] = useState(false);
  const [resetMessage, setResetMessage] = useState('');
  const [resetLoading, setResetLoading] = useState(false);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });

      if (!res.ok) {
        throw new Error('Invalid credentials');
      }

      const data = await res.json();
      localStorage.setItem('organizerToken', data.token);
      router.push('/dashboard');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Invalid credentials');
    }
  };

  const handleForgotPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setResetMessage('');
    setResetLoading(true);

    try {
      const res = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Unable to send reset email');
      setResetMessage(data.message);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Unable to send reset email');
    } finally {
      setResetLoading(false);
    }
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', width: '100%' }}>
      <div className="glass animate-fade-in" style={{ padding: '2.5rem', borderRadius: '1rem', width: '100%', maxWidth: '400px' }}>
        <h1 style={{ fontSize: '1.875rem', fontWeight: 700, marginBottom: '0.5rem', textAlign: 'center' }} className="gradient-text">
          PyProctor AI
        </h1>
        <p style={{ color: '#94a3b8', textAlign: 'center', marginBottom: '2rem' }}>Sign in to manage candidates</p>

        {error && <div style={{ color: 'var(--error)', marginBottom: '1rem', textAlign: 'center', fontSize: '0.875rem' }}>{error}</div>}
        {resetMessage && <div style={{ color: '#22c55e', marginBottom: '1rem', textAlign: 'center', fontSize: '0.875rem' }}>{resetMessage}</div>}

        <form onSubmit={showForgotPassword ? handleForgotPassword : handleLogin} style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          <div>
            <label style={{ display: 'block', marginBottom: '0.5rem', fontSize: '0.875rem', color: '#cbd5e1' }}>Email address</label>
            <input
              type="email"
              required
              className="input-field"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="organizer@company.com"
            />
          </div>
          {!showForgotPassword && <div>
            <label style={{ display: 'block', marginBottom: '0.5rem', fontSize: '0.875rem', color: '#cbd5e1' }}>Password</label>
            <input
              type="password"
              required
              className="input-field"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
            />
          </div>}
          <button type="submit" className="btn-primary" style={{ marginTop: '0.5rem' }} disabled={resetLoading}>
            {showForgotPassword ? (resetLoading ? 'Sending...' : 'Send Reset Link') : 'Sign In'}
          </button>
        </form>

        <button
          type="button"
          onClick={() => { setShowForgotPassword(!showForgotPassword); setError(''); setResetMessage(''); }}
          style={{ display: 'block', margin: '1rem auto 0', background: 'none', border: 0, color: 'var(--primary)', textDecoration: 'underline', cursor: 'pointer' }}
        >
          {showForgotPassword ? 'Back to sign in' : 'Forgot password?'}
        </button>

        {!showForgotPassword && <div style={{ marginTop: '1.5rem', textAlign: 'center', fontSize: '0.875rem', color: '#cbd5e1' }}>
          Don&apos;t have an account? <a href="/register" style={{ color: 'var(--primary)', textDecoration: 'underline' }}>Register here</a>
        </div>}
      </div>
    </div>
  );
}
