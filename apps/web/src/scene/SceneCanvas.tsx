'use client';

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import * as THREE from 'three';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { ContactShadows, OrbitControls, PerformanceMonitor } from '@react-three/drei';
import { labelPortal } from './label-portal';
import { fitView, type Bounds } from './layout';
import { useLatencyStore } from '@/store/latency-store';
import { AnomalyLights } from './AnomalyLights';
import { Floor } from './Floor';
import { Lighting } from './Lighting';
import { forcedQuality, isSoftwareRenderer, QUALITY_PROFILE, QualityContext, stepDown, stepUp, type Quality } from './quality';
import { SceneDataContext, type SceneData } from './scene-data';

/** Registra en la insignia de latencia el instante de pintado de cada frame (§13): un pendiente por activo, sin renders de React. */
function LatencyPaint() {
  useFrame(() => useLatencyStore.getState().paint('scene'));
  return null;
}

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
  // nivel inicial (§13): `?quality=` lo fuerza (sin ajuste automático); render por software → bajo y fijo; si no, alto con
  // ajuste automático según los fps reales (PerformanceMonitor)
  const [init] = useState(() => {
    const forced = forcedQuality();
    const software = forced ? false : isSoftwareRenderer();
    return { start: forced ?? (software ? 'low' : 'high'), auto: !forced && !software } as { start: Quality; auto: boolean };
  });
  const [quality, setQuality] = useState<Quality>(init.start);
  const profile = QUALITY_PROFILE[quality];
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
        dpr={profile.dpr}
        shadows={profile.shadowMap > 0 ? 'percentage' : false}
        camera={{ position: [15, 10.5, 17], fov: 38, near: 0.1, far }}
        gl={{ antialias: QUALITY_PROFILE[init.start].msaa, powerPreference: 'high-performance' }}
        onPointerMissed={onMissed}
      >
        <QualityContext.Provider value={quality}>
          <SceneDataContext.Provider value={data}>
            <color attach="background" args={['#0d141d']} />
            <fog attach="fog" args={['#0d141d', fit.distance * 1.6 + 20, fit.distance * 1.6 + 80 + span * 2]} />
            <Lighting bounds={bounds} profile={profile} shadowKey={shadowKey} />
            <Floor bounds={bounds} />
            <AnomalyLights pool={QUALITY_PROFILE.high.maxAnomalyLights} active={profile.maxAnomalyLights} />
            {profile.contactShadows && (
              <ContactShadows
                key={shadowKey}
                position={[bounds.cx, 0.07, bounds.cz]}
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
          {init.auto && (
            <PerformanceMonitor
              bounds={() => [Math.round(profile.fps * 0.6), Math.round(profile.fps * 0.9)]}
              onDecline={() => setQuality(stepDown)}
              onIncline={() => setQuality((q) => stepUp(q, init.start))}
              flipflops={4}
            />
          )}
          <FitCamera bounds={bounds} />
          <FrameLimiter fps={profile.fps} />
          <LatencyPaint />
        </SceneDataContext.Provider>
        </QualityContext.Provider>
      </Canvas>
    </div>
  );
}
