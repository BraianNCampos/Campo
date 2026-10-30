'use client';

import { canAckAlarms } from '@/lib/modules/nav';
import { useLiveStore } from '@/store/live-store';
import { useSessionStore } from '@/store/session-store';
import { AlarmList } from './AlarmList';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useUiStore } from '@/store/ui-store';

/** `/alarmas`: todas las alarmas activas de la planta, de cualquier módulo. */
export function GlobalAlarms() {
  const role = useSessionStore((s) => s.me?.role);
  const router = useRouter();
  const count = useLiveStore((s) => Object.keys(s.alarms).length);
  const select = useUiStore((s) => s.select);
  useEffect(() => {
    document.title = 'Alarmas · Campo';
  }, []);
  return (
    <div className="mx-auto max-w-3xl px-4 py-6 md:px-6">
      <h1 className="text-2xl font-extrabold tracking-tight">Alarmas</h1>
      <p className="mt-0.5 mb-4 text-sm text-muted">{count === 0 ? 'No hay alarmas activas en la planta.' : `${count} ${count === 1 ? 'alarma activa' : 'alarmas activas'} en la planta.`}</p>
      <AlarmList
        canAck={canAckAlarms(role)}
        onSelect={(id) => {
          select(id);
          router.push('/m/view3d');
        }}
      />
    </div>
  );
}
