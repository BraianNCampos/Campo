import type { Metadata } from 'next';
import { OrgDetail } from '@/components/admin/OrgDetail';

export const metadata: Metadata = { title: 'Cliente' };

export default function Page() {
  return <OrgDetail />;
}
