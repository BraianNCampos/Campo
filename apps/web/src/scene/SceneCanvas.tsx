'use client';

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import * as THREE from 'three';
import { Canvas, useThree } from '@react-three/fiber';
import { ContactShadows, OrbitControls, PerformanceMonitor } from '@react-three/drei';
import { labelPortal } from './label-portal';
import { fitView, type Bounds } from './layout';
import { detectQuality } from './quality';
import { SceneDataContext, type SceneData } from './scene-data';

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

/** Encuadra toda la planta según sus límites y la relación de aspecto (retrato en móvil → vista lateral). */
function FitCamera({ bounds }: { bounds: Bounds }) {
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls) as OrbitControlsImpl | null;
  const aspect = useThree((s) => Math.round((s.size.width / Math.max(1, s.size.height)) * 4) / 4);
  const { cx, cz, halfX, halfZ } = bounds;
  useLayoutEffect(() => {
    const fit = fitView({ cx, cz, halfX, halfZ }, aspect);
    const target = new THREE.Vector3(...fit.target);
    camera.position.copy(new THREE.Vector3(...fit.dir).normalize().multiplyScalar(fit.distance)).add(target);
    camera.lookAt(target);
    controls?.update();
  }, [aspect, camera, controls, cx, cz, halfX, halfZ]);
  return null;
}

function Ground({ bounds }: { bounds: Bounds }) {
  const w = Math.max(12, bounds.halfX * 2 + 2);
  const d = Math.max(8, bounds.halfZ * 2 + 2);
  const grid = Math.min(400, Math.max(48, Math.ceil(Math.max(w, d) * 1.6 / 2) * 2));
  return (
    <>
      <mesh rotation-x={-Math.PI / 2} position-y={-0.02}>
        <circleGeometry args={[Math.max(90, Math.max(w, d) * 3), 48]} />
        <meshLambertMaterial color="#0f1823" />
      </mesh>
      <mesh position={[bounds.cx, 0, bounds.cz]}>
        <boxGeometry args={[w, 0.04, d]} />
        <meshLambertMaterial color="#1a2535" />
      </mesh>
      {/* rejilla de líneas (barata); la de drei <Grid> es un shader a pantalla completa */}
      <gridHelper args={[grid, grid, '#26384f', '#172336']} position={[Math.round(bounds.cx), 0.03, Math.round(bounds.cz)]} />
    </>
  );
}

/** Lienzo 3D común (escritorio, móvil bajo demanda y vista previa de administración). */
export function SceneCanvas({
  bounds,
  data,
  shadowKey,
  testId = 'scene',
  label,
  onMissed,
  children,
}: {
  bounds: Bounds;
  data: SceneData;
  /** cambia cuando cambia el conjunto de activos (recalcula las sombras de contacto) */
  shadowKey: string;
  testId?: string;
  label: string;
  onMissed?: () => void;
  children: ReactNode;
}) {
  const [quality] = useState(detectQuality);
  const low = quality === 'low';
  const [dpr, setDpr] = useState(low ? 1 : 1.5);
  const rootRef = useRef<HTMLDivElement>(null);
  // destino estable de las etiquetas HTML (ver label-portal.ts); se fija antes de que R3F renderice la escena
  useLayoutEffect(() => {
    labelPortal.current = rootRef.current;
    return () => {
      labelPortal.current = null;
    };
  }, []);
  const span = Math.max(bounds.halfX, bounds.halfZ);
  const far = Math.max(200, span * 12);
  const fit = fitView(bounds, 1.6);
  return (
    <div ref={rootRef} data-testid={testId} data-quality={quality} role="img" aria-label={label} className="scene-root absolute inset-0">
      <Canvas
        frameloop="demand"
        dpr={dpr}
        camera={{ position: [15, 10.5, 17], fov: 38, near: 0.1, far }}
        gl={{ antialias: !low, powerPreference: 'high-performance' }}
        onPointerMissed={onMissed}
      >
        <SceneDataContext.Provider value={data}>
          <color attach="background" args={['#0d141d']} />
          <fog attach="fog" args={['#0d141d', fit.distance * 1.6 + 20, fit.distance * 1.6 + 80 + span * 2]} />
          <hemisphereLight args={['#bcd4ff', '#243044', 1.15]} />
          <directionalLight position={[10, 16, 8]} intensity={2.4} />
          <directionalLight position={[-12, 6, -10]} intensity={0.8} color="#7aa7ff" />
          <Ground bounds={bounds} />
          {!low && (
            <ContactShadows
              key={shadowKey}
              position={[bounds.cx, 0.05, bounds.cz]}
              opacity={0.55}
              width={bounds.halfX * 2 + 6}
              height={bounds.halfZ * 2 + 6}
              blur={2.4}
              far={5}
              frames={1}
              resolution={512}
            />
          )}
          {children}
          <OrbitControls
            makeDefault
            target={fit.target}
            enableDamping
            dampingFactor={0.09}
            minDistance={3}
            maxDistance={Math.max(65, fit.distance * 2.5)}
            maxPolarAngle={Math.PI / 2 - 0.05}
            enablePan
            screenSpacePanning={false}
          />
          <PerformanceMonitor bounds={() => [18, 40]} onDecline={() => setDpr(1)} onIncline={() => setDpr(1.5)} flipflops={3} />
          <FitCamera bounds={bounds} />
          <FrameLimiter fps={30} />
        </SceneDataContext.Provider>
      </Canvas>
    </div>
  );
}
