'use client';

import { useEffect, useLayoutEffect, useState } from 'react';
import * as THREE from 'three';
import { Canvas, useThree } from '@react-three/fiber';
import { ContactShadows, OrbitControls, PerformanceMonitor } from '@react-three/drei';
import { assetKind } from '@/lib/assets';
import { clamp } from '@/lib/math';
import { useLiveStore } from '@/store/live-store';
import { useUiStore } from '@/store/ui-store';
import { positionFor } from './layout';
import { detectQuality } from './quality';
import { Pipes } from './Pipes';
import { Pump } from './Pump';
import { Tank } from './Tank';
import { Valve } from './Valve';

/** Render limitado: invalida el frame a `fps` mientras la pestaña está visible (frameloop="demand"). */
function FrameLimiter({ fps }: { fps: number }) {
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => {
    let raf = 0;
    let last = 0;
    const loop = (t: number) => {
      raf = requestAnimationFrame(loop);
      if (document.hidden) return;
      if (t - last >= 1000 / fps - 2) {
        last = t;
        invalidate();
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [fps, invalidate]);
  return null;
}

type OrbitControlsImpl = { update(): void };
const TARGET = new THREE.Vector3(-0.5, 1.3, 0);

/** Encuadra toda la planta según la relación de aspecto (retrato en móvil → más lejos). */
function FitCamera() {
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls) as OrbitControlsImpl | null;
  const aspect = useThree((s) => Math.round((s.size.width / Math.max(1, s.size.height)) * 4) / 4);
  useLayoutEffect(() => {
    // apaisado: vista frontal (la planta es ancha en x); retrato: vista lateral para que su eje largo quede vertical
    const portrait = aspect < 0.9;
    const dist = portrait
      ? clamp(15.5 / (0.689 * Math.max(aspect, 0.2)), 22, 55)
      : clamp(21.5 / (0.689 * Math.max(aspect, 0.2)), 22, 55);
    const dir = portrait ? new THREE.Vector3(0.84, 0.55, 0.2) : new THREE.Vector3(0.22, 0.5, 0.84);
    camera.position.copy(dir.normalize().multiplyScalar(dist)).add(TARGET);
    camera.lookAt(TARGET);
    controls?.update();
  }, [aspect, camera, controls]);
  return null;
}

function Equipments({ ids }: { ids: string[] }) {
  return (
    <>
      {ids.map((id, i) => {
        const pos = positionFor(id, i);
        switch (assetKind(id)) {
          case 'tank':
            return <Tank key={id} id={id} position={pos} />;
          case 'pump':
            return <Pump key={id} id={id} position={pos} />;
          case 'valve':
            return <Valve key={id} id={id} position={pos} />;
          default:
            return null;
        }
      })}
    </>
  );
}

function Ground() {
  return (
    <>
      <mesh rotation-x={-Math.PI / 2} position-y={-0.02}>
        <circleGeometry args={[90, 48]} />
        <meshLambertMaterial color="#0f1823" />
      </mesh>
      <mesh position={[-0.5, 0, 0]}>
        <boxGeometry args={[21, 0.04, 11]} />
        <meshLambertMaterial color="#1a2535" />
      </mesh>
      {/* rejilla de líneas (barata); la de drei <Grid> es un shader a pantalla completa */}
      <gridHelper args={[48, 48, '#26384f', '#172336']} position={[0, 0.03, 0]} />
    </>
  );
}

export default function Plant3D() {
  const select = useUiStore((s) => s.select);
  const [quality] = useState(detectQuality);
  const low = quality === 'low';
  const [dpr, setDpr] = useState(low ? 1 : 1.5);
  // sólo cambia cuando cambia el conjunto de activos, no con cada mensaje
  const ids = useLiveStore((s) => s.assetIds);
  return (
    <div
      data-testid="scene"
      data-quality={quality}
      role="img"
      aria-label="Gemelo digital 3D de la planta. Usa la lista de activos para seleccionar equipos con teclado."
      className="scene-root absolute inset-0"
    >
      <Canvas
        frameloop="demand"
        dpr={dpr}
        camera={{ position: [15, 10.5, 17], fov: 38, near: 0.1, far: 200 }}
        gl={{ antialias: !low, powerPreference: 'high-performance' }}
        onPointerMissed={() => select(null)}
      >
        <color attach="background" args={['#0d141d']} />
        <fog attach="fog" args={['#0d141d', 50, 110]} />
        <hemisphereLight args={['#bcd4ff', '#243044', 1.15]} />
        <directionalLight position={[10, 16, 8]} intensity={2.4} />
        <directionalLight position={[-12, 6, -10]} intensity={0.8} color="#7aa7ff" />
        <Ground />
        {!low && <ContactShadows key={ids.join()} position={[-0.5, 0.05, 0]} opacity={0.55} width={26} height={16} blur={2.4} far={5} frames={1} resolution={512} />}
        <Pipes />
        <Equipments ids={ids} />
        <OrbitControls
          makeDefault
          target={TARGET.toArray()}
          enableDamping
          dampingFactor={0.09}
          minDistance={7}
          maxDistance={65}
          maxPolarAngle={Math.PI / 2 - 0.05}
          enablePan
          screenSpacePanning={false}
        />
        <PerformanceMonitor bounds={() => [18, 40]} onDecline={() => setDpr(1)} onIncline={() => setDpr(1.5)} flipflops={3} />
        <FitCamera />
        <FrameLimiter fps={30} />
      </Canvas>
    </div>
  );
}
