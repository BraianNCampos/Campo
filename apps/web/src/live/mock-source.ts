import type { ServerMessage } from '@campo/shared';
import { PlantSimulator } from './simulator';

export const MOCK_TICK_MS = 250;

/**
 * Emite por `emit` los mismos `ServerMessage` que enviaría el WebSocket real:
 * un snapshot al arrancar y luego telemetría/alarmas cada tick.
 */
export function startMockSource(emit: (m: ServerMessage) => void, plant = 'demo'): () => void {
  const sim = new PlantSimulator(plant, Math.floor(Math.random() * 1e6));
  emit(sim.snapshot(Date.now()));
  let last = Date.now();
  const id = setInterval(() => {
    const now = Date.now();
    const dt = (now - last) / 1000;
    last = now;
    for (const m of sim.step(dt, now)) emit(m);
  }, MOCK_TICK_MS);
  return () => clearInterval(id);
}
