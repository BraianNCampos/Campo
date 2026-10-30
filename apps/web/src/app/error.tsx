'use client';

import { BrandMark } from '@/components/Brand';

/** Error inesperado de una pantalla: sobrio, sin trazas, con salida clara. */
export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main id="main" className="mx-auto flex min-h-dvh max-w-sm flex-col items-center justify-center gap-4 px-6 text-center">
      <BrandMark size={44} />
      <h1 className="text-xl font-bold">Algo no salió como esperábamos</h1>
      <p className="text-muted">Esta pantalla tuvo un problema. Tus datos están a salvo: probá de nuevo y, si se repite, contactá a Campos Ingeniería.</p>
      <button type="button" onClick={reset} className="min-h-12 rounded-xl bg-accent px-6 text-base font-bold text-bg">
        Reintentar
      </button>
    </main>
  );
}
