'use client';

import { useEffect, useRef, type ReactNode, type RefObject } from 'react';
import { Html } from '@react-three/drei';
import type * as THREE from 'three';
import type { AssetType } from '@campo/shared';
import { useUiStore } from '@/store/ui-store';
import { labelPortalRef } from './label-portal';
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

/** Contenedor común: posición, clic de selección, anillo de selección y etiqueta HTML ligera. */
export function Equipment({
  id,
  name,
  type,
  placement,
  ringRadius,
  labelPos,
  valueRef,
  children,
}: {
  id: string;
  name: string;
  type: AssetType;
  placement: Placement;
  ringRadius: number;
  labelPos: Vec3;
  valueRef: RefObject<HTMLElement | null>;
  children: ReactNode;
}) {
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
      <Html position={labelPos} center zIndexRange={[20, 0]} portal={labelPortalRef} style={{ pointerEvents: 'none' }}>
        <div className="scene-label" data-minor={type === 'tank' ? undefined : ''}>
          {name}
          <b ref={valueRef as RefObject<HTMLElement>}>—</b>
        </div>
      </Html>
    </group>
  );
}
