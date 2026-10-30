import type { Metadata } from 'next';
import { WallScreen } from '@/components/wall/WallScreen';

export const metadata: Metadata = { title: 'Modo pared' };

export default function Page() {
  return <WallScreen />;
}
