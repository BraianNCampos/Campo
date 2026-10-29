import type { Metadata } from 'next';
import { AuditPanel } from '@/components/admin/AuditPanel';

export const metadata: Metadata = { title: 'Auditoría' };

export default function Page() {
  return <AuditPanel />;
}
