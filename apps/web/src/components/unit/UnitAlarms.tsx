'use client';

import { useMemo, useState } from 'react';
import { canAck } from '@/lib/admin/alarms-api';
import { acknowledgeAlarm } from '@/live/alarm-actions';
import { selectAlarmList, useLiveStore } from '@/store/live-store';
import { useSessionStore } from '@/store/session-store';
import { usePlantStore } from '@/store/plant-store';
import { showAdminLink } from '@/lib/modules/nav';
import type { LiveAlarm } from '@/lib/alarm-lifecycle';
import { AlarmDetail } from '../alarms/AlarmDetail';
import { AlarmRow } from '../alarms/AlarmRow';
import { assetNameOf } from '../alarms/model';
import { useNow } from '../hooks';
import { useActiveModuleIds } from '../modules/derived';
import { IconCheck } from '../icons';

/** Alarmas del equipo con tag, descripción, valor y límite (las mismas filas que `/alarmas`). */
export function UnitAlarms({ id }: { id: string }) {
  const list = useLiveStore(selectAlarmList);
  const catalog = useLiveStore((s) => s.catalog);
  const role = useSessionStore((s) => s.me?.role);
  const plant = usePlantStore((s) => s.selected) ?? '';
  const modules = useActiveModuleIds();
  const now = useNow(1000);
  const [openId, setOpenId] = useState<string | null>(null);
  const alarms = useMemo(() => list.filter((a) => a.asset === id), [list, id]);
  const shown: LiveAlarm | undefined = alarms.find((a) => a.id === openId);
  const ack = canAck(role);
  return (
    <section aria-label="Alarmas del equipo" data-testid="unit-alarms" className="rounded-2xl border border-line bg-surface p-4 md:p-5">
      <h2 className="text-base font-bold">Alarmas del equipo</h2>
      {alarms.length === 0 ? (
        <p data-testid="unit-alarms-empty" className="mt-2 flex items-center gap-2 text-sm text-muted">
          <IconCheck className="text-lg text-calm" /> Sin alarmas activas en este equipo.
        </p>
      ) : (
        <ul className="mt-3 flex flex-col gap-2">
          {alarms.map((a) => (
            <AlarmRow
              key={a.id}
              alarm={a}
              name={assetNameOf(a.asset, catalog)}
              now={now}
              canAck={ack}
              canShelve={false}
              selected={a.id === openId}
              onAck={(x) => void acknowledgeAlarm(x)}
              onShelve={() => {}}
              onUnshelve={() => {}}
              onOpen={(x) => setOpenId(x.id)}
            />
          ))}
        </ul>
      )}
      {shown && (
        <AlarmDetail
          alarm={shown}
          name={assetNameOf(shown.asset, catalog)}
          now={now}
          canAck={ack}
          canShelve={false}
          canRules={showAdminLink(role)}
          catalog={catalog}
          modules={modules}
          plant={plant}
          onAck={(x) => void acknowledgeAlarm(x)}
          onShelve={() => {}}
          onUnshelve={() => {}}
          onClose={() => setOpenId(null)}
        />
      )}
    </section>
  );
}
