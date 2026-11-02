'use client';

import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { Environment, Lightformer } from '@react-three/drei';
import type { Bounds } from './layout';
import type { QualityProfile } from './quality';

/** Cada cuánto se redibuja el mapa de sombras (las piezas móviles son lentas; ahorra un pase de sombras por frame). */
export const SHADOW_REFRESH_S = 0.5;

/** Refresca el mapa de sombras a baja frecuencia y cuando cambia `dep` (otro conjunto de activos). */
function ShadowRefresh({ dep }: { dep: string }) {
  const get = useThree((s) => s.get);
  const acc = useRef(0);
  useEffect(() => {
    const { shadowMap } = get().gl;
    shadowMap.autoUpdate = false;
    shadowMap.needsUpdate = true;
    return () => {
      shadowMap.autoUpdate = true;
    };
  }, [get, dep]);
  useFrame(({ gl }, dt) => {
    acc.current += dt;
    if (acc.current >= SHADOW_REFRESH_S) {
      acc.current = 0;
      gl.shadowMap.needsUpdate = true;
    }
  });
  return null;
}

/**
 * Iluminación de estudio sin recursos externos: luz principal con sombras suaves, contraluz frío, relleno
 * hemisférico y puntual propio, y un entorno procedural (paneles de luz) que da reflejos a los metales PBR.
 */
export function Lighting({ bounds, profile, shadowKey }: { bounds: Bounds; profile: QualityProfile; shadowKey: string }) {
  const span = Math.max(bounds.halfX, bounds.halfZ, 6);
  const { cx, cz } = bounds;
  const target = useMemo(() => new THREE.Object3D(), []);
  const shadows = profile.shadowMap > 0;
  const cam = span * 1.35 + 4;
  return (
    <>
      <primitive object={target} position={[cx, 0, cz]} />
      <hemisphereLight args={['#c9dcff', '#2b3544', profile.environment ? 0.55 : 1.15]} />
      <directionalLight
        position={[cx + span * 0.9, span * 1.5 + 6, cz + span * 0.8]}
        target={target}
        intensity={profile.environment ? 2.4 : 2.6}
        color="#fff4e6"
        castShadow={shadows}
        shadow-mapSize={[profile.shadowMap || 1, profile.shadowMap || 1]}
        shadow-camera-left={-cam}
        shadow-camera-right={cam}
        shadow-camera-top={cam}
        shadow-camera-bottom={-cam}
        shadow-camera-near={0.5}
        shadow-camera-far={span * 5 + 40}
        shadow-bias={-0.0004}
        shadow-normalBias={0.04}
        shadow-radius={4}
      />
      <directionalLight position={[cx - span * 1.1, span * 0.6 + 3, cz - span * 0.9]} target={target} intensity={0.9} color="#7aa7ff" />
      {profile.fillLights && (
        <>
          <pointLight position={[cx - span * 0.9, 5, cz + span * 0.9]} intensity={span * 9} distance={span * 3.2} decay={1.6} color="#ffd9b0" />
          <pointLight position={[cx + span * 0.9, 4, cz - span * 0.7]} intensity={span * 7} distance={span * 3} decay={1.6} color="#9cc4ff" />
        </>
      )}
      {profile.environment && (
        <Environment frames={1} resolution={128} environmentIntensity={0.9}>
          <Lightformer form="rect" intensity={2.4} position={[0, 7, 0]} rotation-x={Math.PI / 2} scale={[16, 12, 1]} color="#f2f6ff" />
          <Lightformer form="rect" intensity={1.4} position={[-9, 3, 2]} rotation-y={Math.PI / 2} scale={[10, 5, 1]} color="#ffe2c4" />
          <Lightformer form="rect" intensity={1.1} position={[9, 3, -2]} rotation-y={-Math.PI / 2} scale={[10, 5, 1]} color="#a9c8ff" />
          <Lightformer form="ring" intensity={0.8} position={[0, 4, -9]} scale={7} color="#ffffff" />
        </Environment>
      )}
      {shadows && <ShadowRefresh dep={shadowKey} />}
    </>
  );
}
