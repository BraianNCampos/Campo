import { config } from '@/lib/env';
import { getToken } from '@/lib/auth';
import { useLiveStore } from '@/store/live-store';

/**
 * Reconoce una alarma. En modo demo es local; en modo real hace
 * POST /api/alarms/:id/ack y sólo marca localmente si el servidor acepta.
 */
export async function acknowledgeAlarm(id: string): Promise<void> {
  const { ackLocal, setNotice } = useLiveStore.getState();
  if (config.mock) {
    ackLocal(id);
    return;
  }
  ackLocal(id); // optimista
  try {
    const token = getToken();
    const res = await fetch(`${config.apiUrl}/api/alarms/${encodeURIComponent(id)}/ack`, {
      method: 'POST',
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new Error(String(res.status));
  } catch {
    // revertir: sigue sin reconocer
    const a = useLiveStore.getState().alarms[id];
    if (a) useLiveStore.setState({ alarms: { ...useLiveStore.getState().alarms, [id]: { ...a, acknowledged: false } } });
    setNotice('No se pudo reconocer la alarma. Reintenta.');
  }
}
