import type { Metadata } from 'next';
import { AssetsPanel } from '@/components/admin/AssetsPanel';

export const metadata: Metadata = { title: 'Activos' };

/** Solo en la exportación estática de la demo (NEXT_EXPORT=1): rutas de ejemplo; en la app normal no genera nada. */
export function generateStaticParams() {
  return process.env.NEXT_EXPORT === '1' ? ['demo', 'tanques'].map((plant) => ({ plant })) : [];
}

export default function Page() {
  return <AssetsPanel />;
}
