import type { AssetDef, ServerMessage } from '@campo/shared';
import { getAdminApi } from '@/lib/admin';
import { DEMO_ASSETS } from '@/lib/demo-seed';
import { PlantSimulator } from './simulator';
import { SeedSimulator } from './seed-simulator';

export const MOCK_TICK_MS = 250;
/** Ritmo de la planta demo: más lento que el de los tests para que los caudales y tasas sean creíbles. */
export const DEMO_PLANT_SPEED = 0.2;

/** Tanques, bombas y válvulas de `demo` que ya mueve `PlantSimulator`. */
const isCoreDemoAsset = (plant: string, def: AssetDef) => plant === 'demo' && ['tank', 'pump', 'valve'].includes(def.type);

interface Source {
  snapshot(now: number): ServerMessage;
  step(dt: number, now: number): ServerMessage[];
}

/** Combina `PlantSimulator` (tanques/bombas/válvulas de demo) y `SeedSimulator` (resto de activos sembrados). */
function buildSources(plant: string): Source[] {
  const seed = Math.floor(Math.random() * 1e6);
  const out: Source[] = [];
  if (plant === 'demo') out.push(new PlantSimulator(plant, seed, { speed: DEMO_PLANT_SPEED, levels: { 'tk-04': 89.4, 'tk-02': 10.6 } }));
  out.push(new SeedSimulator(plant, seed, { skip: (d) => isCoreDemoAsset(plant, d) }));
  return out;
}

/**
 * Emite por `emit` los mismos `ServerMessage` que enviaría el WebSocket real: un snapshot al arrancar y luego
 * telemetría/alarmas cada tick. Para las plantas sembradas (`demo`, `tanques`) simula todos sus activos; para
 * cualquier otra planta (creada en la administración demo) genera valores suaves de su catálogo.
 */
export function startMockSource(emit: (m: ServerMessage) => void, plant = 'demo'): () => void {
  if (!(plant in DEMO_ASSETS)) return startCatalogSource(emit, plant);
  const sources = buildSources(plant);
  const offCatalog = watchCatalog(emit, plant);
  const now0 = Date.now();
  const snaps = sources.map((s) => s.snapshot(now0)).filter((m): m is Extract<ServerMessage, { type: 'snapshot' }> => m.type === 'snapshot');
  emit({ type: 'snapshot', plant, assets: Object.assign({}, ...snaps.map((s) => s.assets)) });
  let last = now0;
  const id = setInterval(() => {
    const now = Date.now();
    const dt = (now - last) / 1000;
    last = now;
    for (const s of sources) for (const m of s.step(dt, now)) emit(m);
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
 * Plantas creadas en la administración demo: valores suaves para los activos de su catálogo, tal como estén al entrar.
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
