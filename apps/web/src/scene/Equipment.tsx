'use client';

import { useEffect, useLayoutEffect, useRef, type ReactNode, type RefObject } from 'react';
import { Html } from '@react-three/drei';
import type * as THREE from 'three';
import type { AssetType } from '@campo/shared';
import { useUiStore } from '@/store/ui-store';
import { AnomalyFx } from './AnomalyFx';
import { labelPortalRef } from './label-portal';
import type { Placement, Vec3 } from './layout';

/** Props comunes de los componentes de activo (procedurales y GLB). */
export interface AssetNodeProps {
  id: string;
  name: string;
  /** Tag estándar (§14.1): se muestra en monoespaciado junto al nombre */
  tag?: string | null;
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

/** Contenedor común: posición, clic de selección, anillo de selección y etiqueta HTML ligera. */
export function Equipment({
  id,
  name,
  tag,
  type,
  placement,
  ringRadius,
  labelPos,
  valueRef,
  glb,
  decorative,
  children,
}: {
  id: string;
  name: string;
  tag?: string | null;
  type: AssetType;
  placement: Placement;
  ringRadius: number;
  labelPos: Vec3;
  valueRef: RefObject<HTMLElement | null>;
  /** dibujado con un modelo GLB (marca la etiqueta con `data-model`, útil en pruebas) */
  glb?: boolean;
  /** decorativo (estructuras): sin selección, sin aviso de alarma y sin valor en la etiqueta */
  decorative?: boolean;
  children: ReactNode;
}) {
  const labelRef = useRef<HTMLDivElement>(null);
  const noteRef = useRef<HTMLElement>(null);
  const holoRef = useRef<HTMLElement>(null);
  const groupRef = useRef<THREE.Group>(null);
  // sombras en todas las mallas opacas del activo (procedural o GLB); sólo cuestan si la luz principal las proyecta
  useLayoutEffect(() => {
    groupRef.current?.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || o.userData.noOutline) return;
      const mat = m.material as THREE.Material;
      m.receiveShadow = true;
      m.castShadow = !mat.transparent;
    });
  }, []);
  return (
    <group
      ref={groupRef}
      position={placement.position}
      rotation-y={placement.rotY}
      scale={placement.scale}
      onClick={
        decorative
          ? undefined
          : (e) => {
              e.stopPropagation();
              const ui = useUiStore.getState();
              ui.select(ui.selectedId === id ? null : id);
            }
      }
      onPointerOver={
        decorative
          ? undefined
          : (e) => {
              e.stopPropagation();
              document.body.style.cursor = 'pointer';
            }
      }
      onPointerOut={decorative ? undefined : () => {
        document.body.style.cursor = '';
      }}
    >
      {children}
      {!decorative && <SelectionRing id={id} radius={ringRadius} />}
      {!decorative && (
        <AnomalyFx id={id} name={name} tag={tag} radius={ringRadius} labelPos={labelPos} groupRef={groupRef} labelRef={labelRef} noteRef={noteRef} holoRef={holoRef} />
      )}
      <Html position={labelPos} center zIndexRange={[20, 0]} portal={labelPortalRef} style={{ pointerEvents: 'none' }}>
        <div ref={labelRef} className="scene-label" data-minor={type === 'tank' || type === 'silo' ? undefined : ''} data-model={glb ? 'glb' : undefined}>
          <i ref={noteRef} className="scene-alarm" />
          {tag && <code className="mr-1 font-mono text-[10px] font-semibold text-[#a6b5c7]">{tag}</code>}
          {name}
          {!decorative && <b ref={valueRef as RefObject<HTMLElement>}>—</b>}
          {!decorative && <span ref={holoRef} className="scene-holo" />}
        </div>
      </Html>
    </group>
  );
}
