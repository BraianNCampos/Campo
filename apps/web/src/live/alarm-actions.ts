import type { AlarmEvent } from '@campo/shared';
import { errorMessage } from '@/lib/admin/errors';
import type { ShelveInput } from '@/lib/admin/alarms-api';
import { lifecycleOf } from '@/lib/alarm-lifecycle';
import { config } from '@/lib/env';
import { useLiveStore } from '@/store/live-store';
import { getAlarmsApi } from './alarm-api';

/** Aplica un evento de alarma al store (upsert por id), igual que si llegara por el WebSocket. */
function applyEvent(ev: AlarmEvent) {
  useLiveStore.getState().applyBatch({ snapshot: null, telemetry: {}, alarms: [ev], count: 1 });
}

/** Lo que ve el operador mientras llega la confirmación del servidor. */
function optimisticAck(a: AlarmEvent): AlarmEvent {
  return lifecycleOf(a) === 'rtn_unacked' ? { ...a, lifecycle: 'closed', acknowledged: true } : { ...a, lifecycle: 'acked', acknowledged: true };
}

/**
 * Reconoce una alarma (`POST /api/alarms/:id/ack`). En modo real el cambio es optimista y se revierte si falla;
 * en modo demo la confirma el motor de la demo (`alarm-lifecycle.ts`), que emite el evento nuevo.
 * Devuelve `true` si salió bien; si no, deja el aviso en `notice` (en voseo).
 */
export async function acknowledgeAlarm(id: string): Promise<boolean> {
  const { setNotice, alarms } = useLiveStore.getState();
  const before = alarms[id];
  setNotice(null);
  if (before && !config.mock) applyEvent(optimisticAck(before));
  try {
    const confirmed = await getAlarmsApi().ack(id);
    if (confirmed && !config.mock) applyEvent(confirmed);
    return true;
  } catch (err) {
    if (before && !config.mock) applyEvent(before); // sigue sin reconocer
    setNotice(errorMessage(err));
    return false;
  }
}

/** Reconoce varias (las visibles); devuelve cuántas salieron bien. Se detiene si el rol no puede (403). */
export async function acknowledgeMany(ids: readonly string[]): Promise<number> {
  let ok = 0;
  for (const id of ids) {
    if (await acknowledgeAlarm(id)) ok++;
    else if (/rol/.test(useLiveStore.getState().notice ?? '')) break;
  }
  return ok;
}

/** Posterga una alarma activa (`POST /api/alarms/:id/shelve`). Lanza `AdminApiError` para mostrarlo en el diálogo. */
export async function shelveAlarm(id: string, input: ShelveInput): Promise<void> {
  const ev = await getAlarmsApi().shelve(id, input);
  if (ev && !config.mock) applyEvent(ev);
}

/** Vuelve a mostrar una alarma postergada (`POST /api/alarms/:id/unshelve`). */
export async function unshelveAlarm(id: string): Promise<void> {
  const ev = await getAlarmsApi().unshelve(id);
  if (ev && !config.mock) applyEvent(ev);
}
