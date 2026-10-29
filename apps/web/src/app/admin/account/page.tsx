import type { Metadata } from 'next';
import { AccountPanel } from '@/components/admin/AccountPanel';

export const metadata: Metadata = { title: 'Mi cuenta' };

export default function Page() {
  return <AccountPanel />;
}
