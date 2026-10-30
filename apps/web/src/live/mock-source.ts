import type { ServerMessage } from '@campo/shared';
import { getAdminApi } from '@/lib/admin';
import { PlantSimulator } from './simulator';

export const MOCK_TICK_MS = 250;

/**
 * Emite por `emit` los mismos `ServerMessage` que enviaría el WebSocket real:
 * un snapshot al arrancar y luego telemetría/alarmas cada tick.
 */
export function startMockSource(emit: (m: ServerMessage) => void, plant = 'demo'): () => void {
  const sim = new PlantSimulator(plant, Math.floor(Math.random() * 1e6));
  const offCatalog = watchCatalog(emit, plant);
  emit(sim.snapshot(Date.now()));
  let last = Date.now();
  const id = setInterval(() => {
    const now = Date.now();
    const dt = (now - last) / 1000;
    last = now;
    for (const m of sim.step(dt, now)) emit(m);
  }, MOCK_TICK_MS);
  return () => {
    clearInterval(id);
    offCatalog();
  };
}

/** En demo, cada edición del catálogo/modelos (API en memoria) avisa como lo haría la API real por WebSocket. */
function watchCatalog(emit: (m: ServerMessage) => void, plant: string): () => void {
  return getAdminApi().onCatalogChange?.((p) => p === plant && emit({ type: 'catalog', plant })) ?? (() => {});
}

/**
 * Plantas distintas de `demo` en modo demo: el simulador sólo conoce la planta demo, así que se
 * generan valores suaves para los activos del catálogo (mock) de esa planta, tal como estén al entrar.
 */
export function startCatalogSource(emit: (m: ServerMessage) => void, plant: string): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  const offCatalog = watchCatalog(emit, plant);
  void getAdminApi()
    .listAssets(plant)
    .then((assets) => {
      if (stopped) return;
      const t0 = Date.now();
      const values = (id: string, type: string, t: number): Record<string, number> => {
        const k = [...id].reduce((a, c) => a + c.charCodeAt(0), 0);
        const wave = Math.sin(t / 7 + k);
        if (type === 'tank') return { level: Math.round((50 + 35 * wave) * 10) / 10, temp: Math.round((20 + 3 * wave) * 10) / 10 };
        if (type === 'pump') return { rpm: Math.round(1450 + 20 * wave) };
        if (type === 'valve') return { position: Math.round(50 + 50 * wave) };
        return { value: Math.round(wave * 100) / 10 };
      };
      const state = (now: number) =>
        Object.fromEntries(
          assets.map((a) => [a.id, { ts: now, quality: 'good' as const, values: values(a.id, a.type, (now - t0) / 1000) }]),
        );
      emit({ type: 'snapshot', plant, assets: state(Date.now()) });
      timer = setInterval(() => {
        const now = Date.now();
        for (const a of assets) emit({ type: 'telemetry', plant, asset: a.id, ts: now, quality: 'good', values: values(a.id, a.type, (now - t0) / 1000) });
      }, 1000);
    })
    .catch(() => emit({ type: 'snapshot', plant, assets: {} }));
  return () => {
    stopped = true;
    offCatalog();
    if (timer) clearInterval(timer);
  };
}
