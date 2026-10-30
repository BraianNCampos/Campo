import type { Metadata } from 'next';
import { Suspense } from 'react';
import { RulesPanel } from '@/components/admin/RulesPanel';
import { LoadingBlock } from '@/components/admin/ui';

export const metadata: Metadata = { title: 'Reglas de alarma' };

export default function Page() {
  return (
    <Suspense fallback={<LoadingBlock />}>
      <RulesPanel />
    </Suspense>
  );
}
