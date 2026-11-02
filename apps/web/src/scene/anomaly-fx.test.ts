import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { anomalyBase, anomalyAt } from './anomaly';
import { AnomalyRig, outlinable, readViewPrefs } from './AnomalyFx';
import { anomalyLights, topRequests, type LightRequest } from './anomaly-registry';

const NOW = 5_000_000;
const alarm = (ts: number, severity: 'critical' | 'warning' = 'critical') =>
  ({ type: 'alarm', id: 'a', ruleId: 'r', plant: 'p', asset: 'x', metric: 'level', severity, state: 'active', value: 95, threshold: 90, ts, message: '', kind: 'HH', lifecycle: 'unacked', acknowledged: false }) as const;
const at = (a: ReturnType<typeof alarm> | null, now = NOW) =>
  anomalyAt(a ? anomalyBase({ state: { ts: now, quality: 'good', values: { level: 95 } }, alarms: [a], limits: [], def: { type: 'tank', metadata: {} } }) : null, now);

function setup() {
  const group = new THREE.Group();
  const solid = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
  const glass = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ transparent: true, opacity: 0.3 }));
  const skip = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
  skip.userData.noOutline = true;
  group.add(solid, glass, skip);
  const label = document.createElement('div');
  const note = document.createElement('i');
  const holoText = document.createElement('span');
  const ref = <T>(current: T) => ({ current });
  const refs = { group: ref<THREE.Group | null>(group), label: ref<HTMLDivElement | null>(label), note: ref<HTMLElement | null>(note), holoText: ref<HTMLElement | null>(holoText), holo: ref<THREE.Group | null>(new THREE.Group()), ringA: ref<THREE.Mesh | null>(null), ringB: ref<THREE.Mesh | null>(null), disc: ref<THREE.Mesh | null>(null), beam: ref<THREE.Mesh | null>(null) };
  const state = { clock: new THREE.Clock(), size: { width: 800, height: 600 } };
  const params = (anomaly: ReturnType<typeof at>) => ({ anomaly, values: { level: 95 }, name: 'Silo', tag: 'TNK-1', labelPos: [0, 3, 0] as [number, number, number], size: 0.5, maxLights: 3 });
  return { group, solid, glass, skip, label, note, holoText, refs, state, params };
}
const outlineOf = (m: THREE.Mesh) => m.children.find((c) => c.userData.isOutline) as THREE.Mesh | undefined;

afterEach(() => {
  anomalyLights.clear();
  vi.unstubAllGlobals();
});

describe('contorno de anomalía (AnomalyRig)', () => {
  it('outlinable: opacas sí; translúcidas y marcadas noOutline no; los propios contornos no', () => {
    const s = setup();
    expect(outlinable(s.solid)).toBe(true);
    expect(outlinable(s.glass)).toBe(false);
    s.glass.userData.outline = true;
    expect(outlinable(s.glass)).toBe(true);
    expect(outlinable(s.skip)).toBe(false);
    expect(outlinable(new THREE.Group())).toBe(false);
  });

  it('al haber anomalía crea el contorno sólo en las mallas aptas y marca el rótulo; al normalizarse lo oculta', () => {
    const s = setup();
    const rig = new AnomalyRig('x');
    rig.update(s.state, s.params(at(alarm(NOW - 1000))), s.refs);
    const o = outlineOf(s.solid)!;
    expect(o).toBeDefined();
    expect(o.visible).toBe(true);
    expect(o.material).toBe(rig.mat);
    expect(outlineOf(s.glass)).toBeUndefined();
    expect(outlineOf(s.skip)).toBeUndefined();
    expect(s.label.dataset.anomaly).toBe('critical');
    expect(s.label.style.getPropertyValue('--anomaly')).toBe('#ff3b30');
    expect(s.note.textContent).toBe('Alarma crítica');
    expect(s.holoText.textContent).toContain('HH');
    expect(s.holoText.textContent).toContain('límite');
    expect(anomalyLights.get('x')?.level).toBe('critical');
    // el modelo no se tiñe: su material no cambia
    expect((s.solid.material as THREE.MeshStandardMaterial).color.getHexString()).toBe('ffffff');

    rig.update(s.state, s.params(null), s.refs);
    expect(o.visible).toBe(false);
    expect(s.label.dataset.anomaly).toBeUndefined();
    expect(s.holoText.textContent).toBe('');
    expect(anomalyLights.has('x')).toBe(false);
  });

  it('magenta pasados 5 min sin reconocer', () => {
    const s = setup();
    const rig = new AnomalyRig('x');
    rig.update(s.state, s.params(at(alarm(NOW - 6 * 60_000))), s.refs);
    expect(s.label.dataset.anomaly).toBe('stale');
    expect(s.label.style.getPropertyValue('--anomaly')).toBe('#ff2bd6');
  });

  it('contraste alto: el contorno es más grueso; reduced-motion: sin giro', () => {
    const s = setup();
    const matches = (q: string) => q.includes('contrast') || q.includes('reduced-motion');
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: matches(q), media: q }));
    expect(readViewPrefs()).toEqual({ still: true, contrast: true });
    const rig = new AnomalyRig('x');
    const ringA = new THREE.Mesh(new THREE.RingGeometry(1, 1.1), new THREE.MeshBasicMaterial());
    s.refs.ringA.current = ringA;
    rig.update(s.state, s.params(at(alarm(NOW - 1000))), s.refs);
    expect(rig.mat.uniforms.uWidth!.value).toBeGreaterThanOrEqual(5);
    expect(ringA.rotation.z).toBe(0);
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    const rig2 = new AnomalyRig('y');
    const s2 = setup();
    rig2.update({ ...s2.state, clock: Object.assign(new THREE.Clock(), { elapsedTime: 3 }) }, s2.params(at(alarm(NOW - 1000))), s2.refs);
    expect(rig2.mat.uniforms.uWidth!.value).toBeLessThan(5);
  });

  it('dispose retira los contornos y la luz', () => {
    const s = setup();
    const rig = new AnomalyRig('x');
    rig.update(s.state, s.params(at(alarm(NOW - 1000))), s.refs);
    rig.dispose();
    expect(outlineOf(s.solid)).toBeUndefined();
    expect(anomalyLights.has('x')).toBe(false);
  });
});

describe('reparto de luces puntuales', () => {
  const req = (rank: number): LightRequest => ({ level: 'critical', rank, pos: new THREE.Vector3(), color: new THREE.Color(), pulse: 1 });
  it('las más urgentes primero (magenta > roja > ámbar) y como mucho n', () => {
    const m = new Map<string, LightRequest>([['a', req(1)], ['b', req(3)], ['c', req(2)], ['d', req(3)]]);
    const top = topRequests(m, 3);
    expect(top.map((t) => t.rank)).toEqual([3, 3, 2]);
    expect(topRequests(m, 0)).toEqual([]);
  });
});
