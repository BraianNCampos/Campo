'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useFrame } from '@react-three/fiber';
import type { AssetType } from '@campo/shared';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { primaryMetric } from '@/lib/assets';
import { damp } from '@/lib/math';
import { formatMetric } from '@/lib/metrics';
import { assetStatus } from '@/lib/status';
import { Equipment, type AssetNodeProps } from './Equipment';
import { applyPose, applyTint, collectTargets } from './models/conventions';
import { createInstance, normalization, type LoadedModel } from './models/glb';
import { useModelStatus } from './models/model-status';
import { useModel } from './models/useModel';
import { useAssetTarget } from './useAssetTarget';

interface GlbProps extends AssetNodeProps {
  type: AssetType;
  model: LoadedModel;
  onBroken(reason: string): void;
}

/** Activo dibujado con su modelo GLB: normalizado a su caja, animado por las convenciones `campo_*` y teñido por estado. */
function GlbEquipment({ id, name, type, placement, model, onBroken }: GlbProps) {
  const target = useAssetTarget(id);
  const instance = useMemo(() => createInstance(model), [model]);
  const targets = useMemo(() => collectTargets(instance.object), [instance]);
  const norm = useMemo(() => normalization(model), [model]);
  const valueEl = useRef<HTMLElement>(null);
  const smooth = useRef<{ level: number; rpm: number; position: number } | null>(null);
  const broken = useRef(false);

  useEffect(() => () => instance.dispose(), [instance]);

  useFrame(({ clock }, dt) => {
    if (broken.current) return;
    try {
      const { state, severity } = target.current;
      const v = state?.values ?? {};
      const goal = { level: v.level ?? 0, rpm: v.rpm ?? 0, position: v.position ?? 0 };
      const s = (smooth.current ??= { ...goal });
      s.level = damp(s.level, goal.level, 3.5, dt);
      s.rpm = damp(s.rpm, goal.rpm, 2.5, dt);
      s.position = damp(s.position, goal.position, 5, dt);
      applyPose(targets, s, dt);
      const status = assetStatus(state, severity);
      applyTint(targets.tint, status, status === 'critical' ? 0.75 + 0.25 * Math.sin(clock.elapsedTime * 6) : 1);
      const el = valueEl.current;
      if (el) {
        const metric = type === 'sensor' ? Object.keys(v)[0] : primaryMetric(type);
        const text = metric ? formatMetric(metric, v[metric]) : '—';
        if (el.textContent !== text) el.textContent = text;
      }
    } catch (e) {
      broken.current = true; // un modelo hostil no debe romper el bucle de render
      onBroken(e instanceof Error ? e.message : 'Error al animar el modelo.');
    }
  });

  const radius = 0.5 * Math.hypot(model.size.x, model.size.z) * norm.k + 0.2;
  return (
    <Equipment id={id} name={name} type={type} placement={placement} ringRadius={radius} labelPos={[0, model.size.y * norm.k + 0.55, 0]} valueRef={valueEl} glb>
      <group position={norm.offset} scale={norm.k}>
        <primitive object={instance.object} />
      </group>
    </Equipment>
  );
}

/**
 * Activo con `model3dRef = model:<uuid>`: mientras el GLB carga —o si falla— se dibuja `fallback` (el modelo
 * procedural del tipo) y el panel del activo avisa «Modelo no disponible».
 */
export function ModelAsset({ id, name, type, placement, modelRef, fallback }: AssetNodeProps & { type: AssetType; modelRef: string | null; fallback: ReactNode }) {
  const state = useModel(modelRef);
  const setFailed = useModelStatus((s) => s.setFailed);
  // fallo al dibujar/animar (modelo hostil): se recuerda para esta referencia y se vuelve al procedural
  const [broken, setBroken] = useState<{ ref: string | null; reason: string } | null>(null);
  const brokenHere = broken?.ref === modelRef ? broken.reason : null;
  const reason = state.status === 'error' ? state.reason : brokenHere;
  useEffect(() => {
    setFailed(id, reason);
    return () => setFailed(id, null);
  }, [id, reason, setFailed]);

  if (state.status !== 'ready' || brokenHere) return <>{fallback}</>;
  const fail = (e: unknown) => setBroken({ ref: modelRef, reason: e instanceof Error && e.message ? e.message : 'Error al dibujar el modelo.' });
  return (
    <ErrorBoundary key={modelRef} fallback={fallback} onError={fail}>
      <GlbEquipment id={id} name={name} type={type} placement={placement} model={state.model} onBroken={(r) => fail(new Error(r))} />
    </ErrorBoundary>
  );
}
