import type { Metadata } from 'next';
import { Suspense } from 'react';
import { AuditPanel } from '@/components/admin/AuditPanel';
import { LoadingBlock } from '@/components/admin/ui';

export const metadata: Metadata = { title: 'Auditoría' };

export default function Page() {
  return (
    <Suspense fallback={<LoadingBlock />}>
      <AuditPanel />
    </Suspense>
  );
}
