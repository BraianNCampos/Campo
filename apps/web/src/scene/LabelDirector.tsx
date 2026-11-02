'use client';

import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { useUiStore } from '@/store/ui-store';
import type { AnomalyLevel } from './anomaly';
import { CROWDED_ABOVE, planLabels, type LabelCandidate, type Size } from './label-plan';
import { labelEntries, labelFocus } from './label-registry';

/** Cada cuánto se replanifican las etiquetas (s). La posición en pantalla la sigue actualizando drei cada frame. */
const PERIOD_S = 0.12;
const DEFAULT: Record<string, Size> = { tag: { w: 64, h: 20 }, name: { w: 130, h: 38 }, 'name!': { w: 150, h: 112 } };
/** La ficha de anomalía se desplaza hacia arriba (ver anomaly-fx.css). */
const ANOMALY_SHIFT = -44;

const v = new THREE.Vector3();

/**
 * Decide qué etiquetas se ven: anomalías, seleccionado y bajo el cursor siempre; el resto por cercanía (sólo tag al
 * acercarse en plantas concurridas) y sin solaparse. Escribe `data-mode` en el DOM; no provoca renders de React.
 */
export function LabelDirector({ fitRef }: { fitRef: { current: { distance: number } } }) {
  const acc = useRef(PERIOD_S);
  useFrame(({ camera, size }, dt) => {
    acc.current += dt;
    if (acc.current < PERIOD_S) return;
    acc.current = 0;
    const selected = useUiStore.getState().selectedId;
    const cands: LabelCandidate[] = [];
    let equipment = 0;
    for (const e of labelEntries.values()) if (!e.decorative) equipment++;
    for (const e of labelEntries.values()) {
      const el = e.label.current;
      const g = e.group.current;
      if (!el || !g) continue;
      v.set(e.labelPos[0], e.labelPos[1], e.labelPos[2]);
      g.localToWorld(v);
      const dist = camera.position.distanceTo(v);
      v.project(camera);
      const x = (v.x * 0.5 + 0.5) * size.width;
      const y = (-v.y * 0.5 + 0.5) * size.height;
      const anomaly = (el.dataset.anomaly as AnomalyLevel | undefined) ?? null;
      const key = (m: string) => (m === 'name' && anomaly ? 'name!' : m);
      cands.push({
        id: e.id,
        x,
        y,
        visible: v.z > -1 && v.z < 1 && x > -80 && x < size.width + 80 && y > -40 && y < size.height + 40,
        dist,
        decorative: e.decorative,
        anomaly,
        focus: selected === e.id || labelFocus.hover === e.id,
        was: e.mode,
        size: (m) => e.sizes.get(key(m)) ?? DEFAULT[key(m)] ?? DEFAULT.name!,
        dy: () => (anomaly ? ANOMALY_SHIFT : 0),
      });
    }
    const plan = planLabels(cands, { crowded: equipment > CROWDED_ABOVE, refDist: fitRef.current.distance });
    for (const e of labelEntries.values()) {
      const el = e.label.current;
      if (!el) continue;
      const mode = plan.get(e.id) ?? 'off';
      if (mode !== e.mode || el.dataset.mode !== mode) {
        e.mode = mode;
        el.dataset.mode = mode;
      }
      // medida real del rótulo (una vez por modo): afina los solapes del siguiente ciclo
      if (mode !== 'off') {
        const k = mode === 'name' && el.dataset.anomaly ? 'name!' : mode;
        if (!e.sizes.has(k) && el.offsetWidth > 0) e.sizes.set(k, { w: el.offsetWidth, h: el.offsetHeight });
      }
    }
  });
  return null;
}
