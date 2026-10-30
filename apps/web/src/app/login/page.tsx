'use client';

import { Suspense, useEffect, useState, type FormEvent } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Wordmark } from '@/components/Brand';
import { HexPattern } from '@/components/HexPattern';
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
      setError(err instanceof ApiError ? err.message : 'No pudimos iniciar tu sesión');
      setBusy(false);
    }
  }

  const field =
    'min-h-12 w-full rounded-lg border border-line bg-bg px-3 text-base text-fg placeholder:text-muted/70';

  return (
    <div className="relative min-h-dvh overflow-hidden">
    <HexPattern />
    <main id="main" className="relative mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-6 px-4 py-10">
      <div className="flex flex-col gap-2">
        <h1 className="m-0"><Wordmark className="text-5xl" /></h1>
        <p className="text-lg font-semibold leading-snug">
          Monitoreo y alarmas <span className="text-accent">para tu industria.</span>
        </p>
        <p className="text-sm text-muted">Ingresá con tu cuenta para ver tu planta en tiempo real.</p>
      </div>
      {config.mock && (
        <p className="rounded-lg border border-line bg-surface px-3 py-2 text-sm text-muted">
          Estás en el modo demo: no hace falta iniciar sesión.
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
          <summary className="min-h-11 cursor-pointer py-2.5 font-semibold text-muted">Tengo un token de acceso</summary>
          <input
            aria-label="Token de acceso"
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
      <p className="text-center text-xs text-muted">Un producto de Campos Ingeniería</p>
    </main>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
