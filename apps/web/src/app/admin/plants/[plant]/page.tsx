import type { Metadata } from 'next';
import { AssetsPanel } from '@/components/admin/AssetsPanel';

export const metadata: Metadata = { title: 'Activos' };

export default function Page() {
  return <AssetsPanel />;
}
