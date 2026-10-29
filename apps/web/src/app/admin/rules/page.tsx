import type { Metadata } from 'next';
import { RulesPanel } from '@/components/admin/RulesPanel';

export const metadata: Metadata = { title: 'Reglas de alarma' };

export default function Page() {
  return <RulesPanel />;
}
