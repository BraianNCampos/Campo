'use client';

import { Suspense, useEffect, useState, type FormEvent } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Logo } from '@/components/Header';
import { ApiError, login, setToken } from '@/lib/auth';
import { config } from '@/lib/env';

function LoginForm() {
  const router = useRouter();
  const preview = useSearchParams().get('preview') === '1';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [rawToken, setRawToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Modo demo: no hay backend ni sesión → se salta el login (?preview=1 lo muestra igualmente).
  useEffect(() => {
    if (config.mock && !preview) router.replace('/');
  }, [router, preview]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (rawToken.trim()) setToken(rawToken.trim());
      else setToken(await login(config.apiUrl, email.trim(), password));
      router.replace('/');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo iniciar sesión');
      setBusy(false);
    }
  }

  const field =
    'min-h-12 w-full rounded-lg border border-line bg-bg px-3 text-base text-fg placeholder:text-muted/70';

  return (
    <main id="main" className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-6 px-4 py-10">
      <div className="flex items-center gap-3">
        <Logo />
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Campo</h1>
          <p className="text-sm text-muted">Acceso al panel de planta</p>
        </div>
      </div>
      {config.mock && (
        <p className="rounded-lg border border-accent/60 bg-accent/15 px-3 py-2 text-sm text-accent">
          Modo demo activo: no se requiere inicio de sesión.
        </p>
      )}
      <form onSubmit={onSubmit} className="flex flex-col gap-4 rounded-2xl border border-line bg-surface p-5">
        <label className="flex flex-col gap-1.5 text-sm font-semibold">
          Correo
          <input
            type="email"
            autoComplete="username"
            required={!rawToken}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className={field}
            placeholder="operador@planta.com"
          />
        </label>
        <label className="flex flex-col gap-1.5 text-sm font-semibold">
          Contraseña
          <input
            type="password"
            autoComplete="current-password"
            required={!rawToken}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={field}
          />
        </label>
        <details className="text-sm">
          <summary className="min-h-11 cursor-pointer py-2.5 font-semibold text-muted">Tengo un token JWT</summary>
          <input
            aria-label="Token JWT"
            value={rawToken}
            onChange={(e) => setRawToken(e.target.value)}
            className={`${field} mt-1 font-mono text-sm`}
            placeholder="eyJhbGciOi…"
          />
        </details>
        {error && (
          <p role="alert" className="rounded-lg border border-crit/60 bg-crit/15 px-3 py-2 text-sm font-semibold text-crit">
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={busy}
          className="min-h-12 rounded-xl bg-accent px-6 text-base font-bold text-bg disabled:opacity-60"
        >
          {busy ? 'Entrando…' : 'Entrar'}
        </button>
      </form>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
