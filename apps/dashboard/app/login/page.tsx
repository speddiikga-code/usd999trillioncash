'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { get, post, setOrgId } from '@/lib/api';
import { useSession } from '@/components/providers';

export default function LoginPage() {
  const router = useRouter();
  const { refresh } = useSession();
  const [state, setState] = useState<{ hasUsers: boolean; allowRegistration: boolean; demoGuestLogin?: boolean } | null>(null);
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [form, setForm] = useState({ email: '', password: '', name: '', orgName: 'My Workspace' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    get('/api/auth/state')
      .then((s) => {
        if (s.authenticated) router.replace('/');
        setState(s);
        if (!s.hasUsers) setMode('register');
      })
      .catch((e) => setError(`Cannot reach the API: ${e.message}. Is the API running on port 4000?`));
  }, [router]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = mode === 'register' ? await post('/api/auth/register', form) : await post('/api/auth/login', { email: form.email, password: form.password });
      if (r.orgId) setOrgId(r.orgId);
      await refresh();
      router.replace(mode === 'register' ? '/onboarding' : '/');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });

  const exploreDemo = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await post('/api/auth/demo');
      setOrgId(r.orgId);
      await refresh();
      router.replace('/');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="center-card">
      <div className="brand" style={{ justifyContent: 'center' }}>
        <div className="brand-mark">R</div>
        <div>
          <div className="brand-name">ROOS</div>
          <div className="brand-sub">Revenue Opportunity Operating System</div>
        </div>
      </div>
      <div className="panel">
        <div className="panel-body" style={{ paddingTop: 16 }}>
          <h1>{mode === 'register' ? (state?.hasUsers ? 'Create an account' : 'Set up the first owner account') : 'Sign in'}</h1>
          {state && !state.hasUsers && <p className="secondary small">No accounts exist yet. The first account becomes the owner of a new workspace and also gets access to the demo workspace (synthetic data).</p>}
          <form className="stack mt" onSubmit={submit}>
            {mode === 'register' && (
              <>
                <label className="field">
                  Name
                  <input className="in" value={form.name} onChange={set('name')} required autoComplete="name" />
                </label>
                <label className="field">
                  Workspace name
                  <input className="in" value={form.orgName} onChange={set('orgName')} required />
                </label>
              </>
            )}
            <label className="field">
              Email
              <input className="in" type="email" value={form.email} onChange={set('email')} required autoComplete="email" />
            </label>
            <label className="field">
              Password {mode === 'register' && <span className="muted">(12+ characters)</span>}
              <input className="in" type="password" value={form.password} onChange={set('password')} required minLength={mode === 'register' ? 12 : 1} autoComplete={mode === 'register' ? 'new-password' : 'current-password'} />
            </label>
            {error && <div className="err">{error}</div>}
            <button className="btn primary" disabled={busy} type="submit">
              {busy ? <span className="spin" /> : null} {mode === 'register' ? 'Create account' : 'Sign in'}
            </button>
          </form>
          {state?.demoGuestLogin && (
            <div className="mt" style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
              <button className="btn" style={{ width: '100%', justifyContent: 'center' }} disabled={busy} onClick={exploreDemo}>
                Explore the demo workspace (read-only, synthetic data)
              </button>
              <p className="tiny muted mt">No account needed. You get a viewer session limited to the DEMO workspace — nothing in it is real.</p>
            </div>
          )}
          {state?.hasUsers && state.allowRegistration && (
            <p className="small mt">
              {mode === 'login' ? 'No account? ' : 'Have an account? '}
              <button className="linkbtn" onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>
                {mode === 'login' ? 'Register' : 'Sign in'}
              </button>
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
