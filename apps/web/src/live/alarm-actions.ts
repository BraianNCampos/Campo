import { config } from '@/lib/env';
import { getToken } from '@/lib/auth';
import { useLiveStore } from '@/store/live-store';

class AckError extends Error {
  constructor(readonly status: number) {
    super(String(status));
  }
}

/**
 * Reconoce una alarma. En modo demo es local; en modo real hace
 * POST /api/alarms/:id/ack con ack optimista; el servidor confirma por WS reenviando la alarma (mismo id, acknowledged:true).
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
    if (!res.ok) throw new AckError(res.status);
  } catch (err) {
    // revertir: sigue sin reconocer
    const a = useLiveStore.getState().alarms[id];
    if (a) useLiveStore.setState({ alarms: { ...useLiveStore.getState().alarms, [id]: { ...a, acknowledged: false } } });
    const status = err instanceof AckError ? err.status : 0;
    setNotice(
      status === 403
        ? 'Tu rol no permite reconocer alarmas (requiere admin, engineer u operator).'
        : status === 401
          ? 'Sesión caducada. Vuelve a iniciar sesión.'
          : 'No se pudo reconocer la alarma. Reintenta.',
    );
  }
}
