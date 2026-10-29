import type { Metadata } from 'next';
import { PlantsPanel } from '@/components/admin/PlantsPanel';

export const metadata: Metadata = { title: 'Plantas y activos' };

export default function Page() {
  return <PlantsPanel />;
}
