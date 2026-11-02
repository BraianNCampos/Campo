import type { AssetDef, ServerMessage } from '@campo/shared';
import { getAdminApi } from '@/lib/admin';
import { DEMO_ASSETS } from '@/lib/demo-seed';
import { setpointOf } from '@/lib/modules/status';
import { PlantSimulator } from './simulator';
import { SeedSimulator } from './seed-simulator';
import { startDemoAlarms } from './alarm-demo';
import { getDemoControl } from '@/lib/control';

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
  if (plant === 'demo') {
    // los niveles oscilan alrededor del SP sembrado en `metadata.setpoints` (src/lib/demo-seed.ts)
    const setpoints: Record<string, number> = {};
    for (const d of DEMO_ASSETS.demo ?? []) {
      const sp = d.type === 'tank' ? setpointOf(d, undefined, 'level') : undefined;
      if (sp !== undefined) setpoints[d.id] = sp;
    }
    out.push(new PlantSimulator(plant, seed, { speed: DEMO_PLANT_SPEED, levels: { 'tk-04': 88.2, 'tk-02': 12.4 }, setpoints }));
  }
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
  // las alarmas las genera el motor ISA-18.2 de la demo (alarm-lifecycle.ts) a partir de esta telemetría
  const control = getDemoControl(plant);
  const alarms = startDemoAlarms(plant, emit, now0, snaps[0]?.assets);
  let last = now0;
  const id = setInterval(() => {
    const now = Date.now();
    const dt = (now - last) / 1000;
    last = now;
    control.step(dt);
    for (const s of sources) {
      for (const m of s.step(dt, now)) {
        // el «servidor» de control mueve el nivel hacia el objetivo de la orden en curso (y añade STS/MODE)
        const out = m.type === 'telemetry' ? { ...m, values: control.transform(m.asset, m.values) } : m;
        if (!alarms.consume(out)) emit(out);
      }
    }
    alarms.step(now);
  }, MOCK_TICK_MS);
  return () => {
    clearInterval(id);
    offCatalog();
    alarms.stop();
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
    .then((all) => {
      let assets = all;
      if (stopped) return;
      const t0 = Date.now();
      const values = (id: string, type: string, t: number): Record<string, number> => {
        const k = [...id].reduce((a, c) => a + c.charCodeAt(0), 0);
        const wave = Math.sin(t / 7 + k);
        if (type === 'conveyor') return { state: wave > -0.6 ? 1 : 0, rpm: wave > -0.6 ? 42 : 0 };
        if (type === 'tank' || type === 'silo') return { level: Math.round((50 + 35 * wave) * 10) / 10, temp: Math.round((20 + 3 * wave) * 10) / 10 };
        if (type === 'pump') return { rpm: Math.round(1450 + 20 * wave) };
        if (type === 'valve') return { position: Math.round(50 + 50 * wave) };
        return { value: Math.round(wave * 100) / 10 };
      };
      assets = assets.filter((a) => a.type !== 'structure'); // decorativas: sin telemetría
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
