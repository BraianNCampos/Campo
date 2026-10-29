'use client';

import { useEffect, useRef, type ReactNode, type RefObject } from 'react';
import { Html } from '@react-three/drei';
import type * as THREE from 'three';
import { assetLabel } from '@/lib/assets';
import { useUiStore } from '@/store/ui-store';
import type { Vec3 } from './layout';

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
  position,
  ringRadius,
  labelY,
  valueRef,
  children,
}: {
  id: string;
  position: Vec3;
  ringRadius: number;
  labelY: number;
  valueRef: RefObject<HTMLElement | null>;
  children: ReactNode;
}) {
  return (
    <group
      position={position}
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
      <Html position={[0, labelY, 0]} center zIndexRange={[20, 0]} style={{ pointerEvents: 'none' }}>
        <div className="scene-label">
          {assetLabel(id)}
          <b ref={valueRef as RefObject<HTMLElement>}>—</b>
        </div>
      </Html>
    </group>
  );
}
