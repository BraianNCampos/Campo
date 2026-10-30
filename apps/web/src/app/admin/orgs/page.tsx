import type { Metadata } from 'next';
import { OrgsPanel } from '@/components/admin/OrgsPanel';

export const metadata: Metadata = { title: 'Clientes' };

export default function Page() {
  return <OrgsPanel />;
}
