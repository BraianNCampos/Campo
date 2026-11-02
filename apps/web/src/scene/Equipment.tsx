'use client';

import { useEffect, useRef, type ReactNode, type RefObject } from 'react';
import { useFrame } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import type * as THREE from 'three';
import type { AssetType } from '@campo/shared';
import { useUiStore } from '@/store/ui-store';
import { labelPortalRef } from './label-portal';
import { useAssetTarget } from './useAssetTarget';
import type { Placement, Vec3 } from './layout';

/** Props comunes de los componentes de activo (procedurales y GLB). */
export interface AssetNodeProps {
  id: string;
  name: string;
  placement: Placement;
}

function SelectionRing({ id, radius }: { id: string; radius: number }) {
  const ref = useRef<THREE.Mesh>(null);
  useEffect(() => {
    const apply = (sel: string | null) => {
      if (ref.current) ref.current.visible = sel === id;
    };
    apply(useUiStore.getState().selectedId);
    return useUiStore.subscribe((s) => apply(s.selectedId));
  }, [id]);
  return (
    <mesh ref={ref} rotation-x={-Math.PI / 2} position-y={0.04} visible={false}>
      <ringGeometry args={[radius, radius + 0.2, 48]} />
      <meshBasicMaterial color="#38bdf8" toneMapped={false} />
    </mesh>
  );
}

const ALARM_HEX = { critical: '#ff4d4d', warning: '#fbbf24' } as const;

/**
 * Aviso de alarma sobre el equipo, sin postprocesado: anillo de suelo resaltado que late sutilmente (quieto con
 * `prefers-reduced-motion`) y la etiqueta pasa a rojo/ámbar con la palabra «Alarma» (color + texto). Lee el store de forma
 * transitoria (sin re-render de React).
 */
function AlarmHalo({ id, radius, labelRef }: { id: string; radius: number; labelRef: RefObject<HTMLDivElement | null> }) {
  const target = useAssetTarget(id);
  const ring = useRef<THREE.Mesh>(null);
  const mat = useRef<THREE.MeshBasicMaterial>(null);
  const shown = useRef<string | undefined>(undefined);
  const still = useRef(false);
  useEffect(() => {
    still.current = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }, []);
  useFrame(({ clock }) => {
    const sev = target.current.severity;
    if (ring.current) {
      ring.current.visible = !!sev;
      if (sev) {
        const k = still.current ? 1 : 1 + 0.045 * Math.sin(clock.elapsedTime * 4.5);
        ring.current.scale.set(k, k, 1);
        mat.current?.color.set(ALARM_HEX[sev]);
      }
    }
    if (shown.current !== sev) {
      shown.current = sev;
      const el = labelRef.current;
      if (el) {
        if (sev) el.dataset.alarm = sev;
        else delete el.dataset.alarm;
      }
    }
  });
  return (
    <mesh ref={ring} rotation-x={-Math.PI / 2} position-y={0.06} visible={false} data-testid={`alarm-halo-${id}`}>
      <ringGeometry args={[radius + 0.25, radius + 0.55, 56]} />
      <meshBasicMaterial ref={mat} color={ALARM_HEX.critical} toneMapped={false} transparent opacity={0.95} />
    </mesh>
  );
}

/** Contenedor común: posición, clic de selección, anillo de selección y etiqueta HTML ligera. */
export function Equipment({
  id,
  name,
  type,
  placement,
  ringRadius,
  labelPos,
  valueRef,
  glb,
  children,
}: {
  id: string;
  name: string;
  type: AssetType;
  placement: Placement;
  ringRadius: number;
  labelPos: Vec3;
  valueRef: RefObject<HTMLElement | null>;
  /** dibujado con un modelo GLB (marca la etiqueta con `data-model`, útil en pruebas) */
  glb?: boolean;
  children: ReactNode;
}) {
  const labelRef = useRef<HTMLDivElement>(null);
  return (
    <group
      position={placement.position}
      rotation-y={placement.rotY}
      scale={placement.scale}
      onClick={(e) => {
        e.stopPropagation();
        const ui = useUiStore.getState();
        ui.select(ui.selectedId === id ? null : id);
      }}
      onPointerOver={(e) => {
        e.stopPropagation();
        document.body.style.cursor = 'pointer';
      }}
      onPointerOut={() => {
        document.body.style.cursor = '';
      }}
    >
      {children}
      <SelectionRing id={id} radius={ringRadius} />
      <AlarmHalo id={id} radius={ringRadius} labelRef={labelRef} />
      <Html position={labelPos} center zIndexRange={[20, 0]} portal={labelPortalRef} style={{ pointerEvents: 'none' }}>
        <div ref={labelRef} className="scene-label" data-minor={type === 'tank' ? undefined : ''} data-model={glb ? 'glb' : undefined}>
          <i className="scene-alarm">Alarma</i>
          {name}
          <b ref={valueRef as RefObject<HTMLElement>}>—</b>
        </div>
      </Html>
    </group>
  );
}
