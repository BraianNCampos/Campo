import type { Metadata } from 'next';
import { UsersPanel } from '@/components/admin/UsersPanel';

export const metadata: Metadata = { title: 'Usuarios' };

export default function Page() {
  return <UsersPanel />;
}
