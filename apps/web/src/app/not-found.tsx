import Link from 'next/link';
import { BrandMark } from '@/components/Brand';

export default function NotFound() {
  return (
    <main id="main" className="mx-auto flex min-h-dvh max-w-sm flex-col items-center justify-center gap-4 px-6 text-center">
      <BrandMark size={44} />
      <h1 className="text-xl font-bold">No encontramos esa página</h1>
      <p className="text-muted">El enlace puede estar viejo o mal escrito. Volvé al inicio y seguí desde ahí.</p>
      <Link href="/" className="inline-flex min-h-12 items-center rounded-xl bg-accent px-6 text-base font-bold text-bg">
        Ir al inicio
      </Link>
    </main>
  );
}
