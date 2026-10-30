import type { Metadata } from 'next';
import { Suspense } from 'react';
import { UsersPanel } from '@/components/admin/UsersPanel';
import { LoadingBlock } from '@/components/admin/ui';

export const metadata: Metadata = { title: 'Usuarios' };

export default function Page() {
  return (
    <Suspense fallback={<LoadingBlock />}>
      <UsersPanel />
    </Suspense>
  );
}
