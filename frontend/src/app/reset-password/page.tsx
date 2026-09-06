'use client';

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

export default function ResetPasswordPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get('token') || '';
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setMessage('');
    if (password.length < 8) return setError('Password must be at least 8 characters.');
    if (password !== confirmPassword) return setError('Passwords do not match.');
    if (!token) return setError('This password reset link is invalid.');

    setLoading(true);
    try {
      const res = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Unable to reset password');
      setMessage(data.message);
      setTimeout(() => router.push('/login'), 1200);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Unable to reset password');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', width: '100%' }}>
      <div className="glass animate-fade-in" style={{ padding: '2.5rem', borderRadius: '1rem', width: '100%', maxWidth: '400px' }}>
        <h1 className="gradient-text" style={{ fontSize: '1.875rem', fontWeight: 700, marginBottom: '0.5rem', textAlign: 'center' }}>Set new password</h1>
        <p style={{ color: '#94a3b8', textAlign: 'center', marginBottom: '2rem' }}>Choose a new password for your organizer account.</p>
        {error && <div style={{ color: 'var(--error)', marginBottom: '1rem', textAlign: 'center', fontSize: '0.875rem' }}>{error}</div>}
        {message && <div style={{ color: '#22c55e', marginBottom: '1rem', textAlign: 'center', fontSize: '0.875rem' }}>{message}</div>}
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          <input type="password" required minLength={8} className="input-field" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="New password" />
          <input type="password" required minLength={8} className="input-field" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} placeholder="Confirm new password" />
          <button type="submit" className="btn-primary" disabled={loading}>{loading ? 'Resetting...' : 'Reset Password'}</button>
        </form>
      </div>
    </div>
  );
}