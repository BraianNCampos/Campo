import { describe, expect, it } from 'vitest';
import type { AnomalyLevel } from './anomaly';
import { DECOR_WITHIN, NAME_WITHIN, planLabels, TAG_WITHIN, type LabelCandidate, type LabelMode } from './label-plan';

const REF = 100;
const cand = (id: string, x: number, y: number, over: Partial<LabelCandidate> = {}): LabelCandidate => ({
  id, x, y, visible: true, dist: REF, decorative: false, anomaly: null, focus: false, was: 'off',
  size: (m) => (m === 'tag' ? { w: 60, h: 20 } : { w: 140, h: 40 }),
  dy: () => 0,
  ...over,
});
const plan = (cs: LabelCandidate[], crowded = true) => Object.fromEntries(planLabels(cs, { crowded, refDist: REF })) as Record<string, LabelMode>;

describe('plan de etiquetas 3D (ISA-101)', () => {
  it('planta concurrida a distancia de encuadre: no se ve nada salvo anomalías y foco', () => {
    const p = plan([cand('a', 100, 100), cand('b', 400, 100, { anomaly: 'critical' }), cand('c', 700, 100, { focus: true }), cand('d', 900, 100)]);
    expect(p).toEqual({ a: 'off', b: 'name', c: 'name', d: 'off' });
  });
  it('al acercar la cámara: primero tag corto, luego tag + nombre', () => {
    const at = (f: number) => plan([cand('a', 100, 100, { dist: REF * f })]).a;
    expect(at(TAG_WITHIN + 0.05)).toBe('off');
    expect(at(TAG_WITHIN - 0.05)).toBe('tag');
    expect(at(NAME_WITHIN + 0.05)).toBe('tag');
    expect(at(NAME_WITHIN - 0.05)).toBe('name');
  });
  it('planta pequeña: todos con nombre (si no se pisan)', () => {
    expect(plan([cand('a', 100, 100), cand('b', 500, 100)], false)).toEqual({ a: 'name', b: 'name' });
  });
  it('estructuras decorativas: sólo muy de cerca', () => {
    expect(plan([cand('n', 100, 100, { decorative: true })], false).n).toBe('off');
    expect(plan([cand('n', 100, 100, { decorative: true, dist: REF * (DECOR_WITHIN - 0.05) })], false).n).toBe('name');
  });
  it('fuera de pantalla o tras la cámara: oculta', () => {
    expect(plan([cand('a', 100, 100, { visible: false, anomaly: 'critical' })]).a).toBe('off');
  });
  it('solapes: gana la anomalía más grave; el resto se degrada a tag u oculta', () => {
    const near = REF * 0.3;
    const p = plan([
      cand('amb', 100, 100, { dist: near, anomaly: 'attention' }),
      cand('mag', 110, 105, { dist: near, anomaly: 'stale' }),
      cand('ok', 105, 100, { dist: near }),
    ]);
    expect(p.mag).toBe('name');
    expect(p.amb).toBe('tag'); // una anomalía nunca desaparece: baja a tag
    expect(p.ok).toBe('off');
  });
  it('degradación nombre → tag cuando sólo el tag cabe', () => {
    const near = REF * 0.3;
    const p = plan([cand('a', 100, 100, { dist: near }), cand('b', 190, 100, { dist: near + 1 })]);
    // a ocupa 30..170; b con nombre (120..260) choca, con tag (160..220) también → oculta; con más separación cabe el tag
    expect(p.a).toBe('name');
    const q = plan([cand('a', 100, 100, { dist: near }), cand('b', 235, 100, { dist: near + 1 })]);
    expect(q.b).toBe('tag');
  });
  it('seleccionado/hover gana a un vecino más cercano', () => {
    const near = REF * 0.3;
    const p = plan([cand('x', 100, 100, { dist: near }), cand('sel', 110, 100, { dist: near * 2, focus: true })]);
    expect(p.sel).toBe('name');
    expect(p.x).toBe('off');
  });
  it('histéresis: ante un empate de prioridad y distancia, el que ya se veía conserva su sitio', () => {
    const near = REF * 0.3;
    const a = cand('a', 100, 100, { dist: near, was: 'off' });
    const b = cand('b', 110, 100, { dist: near, was: 'name' });
    expect(plan([a, b]).b).toBe('name');
    expect(plan([a, b]).a).toBe('off');
  });
  it('el desplazamiento de la ficha de anomalía cuenta en el solape', () => {
    const lvl: AnomalyLevel = 'critical';
    const near = REF * 0.3;
    const p = plan([
      cand('an', 100, 200, { dist: near, anomaly: lvl, dy: () => -100 }), // ocupa y≈80..120 tras subir
      cand('v', 100, 100, { dist: near }),
    ]);
    expect(p.an).toBe('name');
    expect(p.v).not.toBe('name'); // se pisa con la ficha desplazada
  });
});
