import type { Metadata } from 'next';
import { OrgDetail } from '@/components/admin/OrgDetail';

export const metadata: Metadata = { title: 'Cliente' };

/** Solo en la exportación estática de la demo (NEXT_EXPORT=1): rutas de ejemplo; en la app normal no genera nada. */
export function generateStaticParams() {
  return process.env.NEXT_EXPORT === '1' ? ['campos-demo', 'cliente-tanques'].map((org) => ({ org })) : [];
}

export default function Page() {
  return <OrgDetail />;
}
