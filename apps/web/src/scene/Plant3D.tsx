'use client';

import { useEffect } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { ContactShadows, Environment, Grid, Lightformer, OrbitControls } from '@react-three/drei';
import { assetKind } from '@/lib/assets';
import { useLiveStore } from '@/store/live-store';
import { useUiStore } from '@/store/ui-store';
import { positionFor } from './layout';
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
      <mesh rotation-x={-Math.PI / 2} position-y={-0.02} receiveShadow>
        <circleGeometry args={[60, 64]} />
        <meshStandardMaterial color="#0f1823" roughness={1} />
      </mesh>
      <mesh position={[-0.5, -0.0, 0]}>
        <boxGeometry args={[21, 0.04, 11]} />
        <meshStandardMaterial color="#1a2535" roughness={0.9} />
      </mesh>
      <Grid
        position-y={0.03}
        args={[60, 60]}
        cellSize={1}
        cellThickness={0.5}
        cellColor="#223247"
        sectionSize={5}
        sectionThickness={1}
        sectionColor="#2f4560"
        fadeDistance={45}
        fadeStrength={1.5}
        infiniteGrid
      />
    </>
  );
}

export default function Plant3D() {
  const select = useUiStore((s) => s.select);
  // sólo cambia cuando cambia el conjunto de activos, no con cada mensaje
  const ids = useLiveStore((s) => s.assetIds);
  return (
    <div
      data-testid="scene"
      role="img"
      aria-label="Gemelo digital 3D de la planta. Usa la lista de activos para seleccionar equipos con teclado."
      className="absolute inset-0"
    >
      <Canvas
        frameloop="demand"
        dpr={[1, 1.75]}
        camera={{ position: [15, 10.5, 17], fov: 38, near: 0.1, far: 200 }}
        gl={{ antialias: true, powerPreference: 'high-performance' }}
        onPointerMissed={() => select(null)}
      >
        <color attach="background" args={['#0d141d']} />
        <fog attach="fog" args={['#0d141d', 32, 75]} />
        <hemisphereLight args={['#a9c8ff', '#1b2432', 0.7]} />
        <directionalLight position={[10, 16, 8]} intensity={1.7} />
        <directionalLight position={[-12, 6, -10]} intensity={0.5} color="#7aa7ff" />
        <Environment frames={1} resolution={128} background={false}>
          <Lightformer form="rect" intensity={2.2} position={[0, 9, 0]} rotation-x={Math.PI / 2} scale={[24, 24, 1]} />
          <Lightformer form="rect" intensity={1.2} position={[-14, 4, 6]} rotation-y={Math.PI / 2} scale={[12, 6, 1]} />
          <Lightformer form="rect" intensity={1} position={[14, 4, -6]} rotation-y={-Math.PI / 2} scale={[12, 6, 1]} />
        </Environment>
        <Ground />
        <ContactShadows key={ids.join()} position={[-0.5, 0.05, 0]} opacity={0.55} width={26} height={16} blur={2.4} far={5} frames={1} resolution={512} />
        <Pipes />
        <Equipments ids={ids} />
        <OrbitControls
          makeDefault
          target={[-0.5, 1.3, 0]}
          enableDamping
          dampingFactor={0.09}
          minDistance={7}
          maxDistance={42}
          maxPolarAngle={Math.PI / 2 - 0.05}
          enablePan
          screenSpacePanning={false}
        />
        <FrameLimiter fps={30} />
      </Canvas>
    </div>
  );
}
