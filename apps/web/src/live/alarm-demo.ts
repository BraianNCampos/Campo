import type { AssetState, ServerMessage } from '@campo/shared';
import { AlarmEngine, registerDemoEngine, unregisterDemoEngine } from './alarm-lifecycle';

declare global {
  interface Window {
    /** Sólo en modo demo: controles para pruebas y demostraciones (forzar valores, adelantar el reloj). */
    __campoAlarms?: Pick<AlarmEngine, 'override' | 'advance'> & { plant: string };
  }
}

/**
 * Engancha el motor de alarmas de la demo a la fuente simulada: la telemetría de los simuladores lo alimenta, sus
 * propias alarmas (sin ciclo de vida) se descartan, y el motor emite los `AlarmEvent` de §12.2. Publica el motor para
 * que el cliente de alarmas del demo (`alarm-api.ts`) pueda reconocer/postergar.
 */
export function startDemoAlarms(plant: string, emit: (m: ServerMessage) => void, now: number, snapshot?: Record<string, AssetState>) {
  const engine = new AlarmEngine({ plant, emit: (ev) => emit(ev) });
  engine.seedHistory(now);
  for (const [asset, st] of Object.entries(snapshot ?? {})) engine.ingest(asset, st.values);
  registerDemoEngine(engine);
  if (typeof window !== 'undefined') window.__campoAlarms = { plant, override: engine.override.bind(engine), advance: engine.advance.bind(engine) };
  return {
    /** `true` si el mensaje se consumió (telemetría que alimenta al motor la deja pasar; las alarmas del simulador se descartan). */
    consume(m: ServerMessage): boolean {
      if (m.type === 'alarm') return true;
      if (m.type === 'telemetry') engine.ingest(m.asset, m.values);
      return false;
    },
    step: (t: number) => engine.step(t),
    stop() {
      unregisterDemoEngine(engine);
      if (typeof window !== 'undefined' && window.__campoAlarms?.plant === plant) delete window.__campoAlarms;
    },
  };
}
