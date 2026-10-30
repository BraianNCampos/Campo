'use client';

import { canAckAlarms } from '@/lib/modules/nav';
import { useLiveStore } from '@/store/live-store';
import { useSessionStore } from '@/store/session-store';
import { AlarmList } from './AlarmList';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { moduleForAssetType } from '@campo/shared';
import { moduleHref } from '@/lib/modules/nav';
import { useActiveModuleIds } from './modules/derived';

/** `/alarmas`: todas las alarmas activas de la planta, de cualquier módulo. */
export function GlobalAlarms() {
  const role = useSessionStore((s) => s.me?.role);
  const router = useRouter();
  const count = useLiveStore((s) => Object.keys(s.alarms).length);
  const active = useActiveModuleIds();
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
          // sólo se navega a módulos que el cliente tiene (la navegación sale de me.org.modules)
          const type = useLiveStore.getState().catalog[id]?.type;
          const m = type ? moduleForAssetType(type) : null;
          if (m && active.includes(m)) router.push(moduleHref(m));
        }}
      />
    </div>
  );
}
