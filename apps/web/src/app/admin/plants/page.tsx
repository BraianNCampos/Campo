import type { Metadata } from 'next';
import { Suspense } from 'react';
import { PlantsPanel } from '@/components/admin/PlantsPanel';
import { LoadingBlock } from '@/components/admin/ui';

export const metadata: Metadata = { title: 'Plantas y activos' };

export default function Page() {
  return (
    <Suspense fallback={<LoadingBlock />}>
      <PlantsPanel />
    </Suspense>
  );
}
