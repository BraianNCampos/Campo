'use client';

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import * as THREE from 'three';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { ContactShadows, OrbitControls, PerformanceMonitor } from '@react-three/drei';
import { labelPortal } from './label-portal';
import { fitView, type Bounds, type ViewInsets } from './layout';
import { useLatencyStore } from '@/store/latency-store';
import { AnomalyLights } from './AnomalyLights';
import { LabelDirector } from './LabelDirector';
import { BRAND, Floor, HORIZON } from './Floor';
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

type OrbitControlsImpl = { update(): void; target: THREE.Vector3 };

/** Paneles superpuestos al lienzo (px por lado): la planta se encuadra en el hueco libre, con el borde bajo el cristal. */
export interface SceneInsets {
  left?: number;
  right?: number;
  top?: number;
  bottom?: number;
}

/** Insets en fracciones del lienzo, acotados (entre todos no pueden tapar más de la mitad). */
export function insetFractions(insets: SceneInsets | undefined, width: number, height: number): ViewInsets {
  const w = Math.max(1, width), h = Math.max(1, height);
  let l = Math.max(0, (insets?.left ?? 0) / w), r = Math.max(0, (insets?.right ?? 0) / w);
  let t = Math.max(0, (insets?.top ?? 0) / h), b = Math.max(0, (insets?.bottom ?? 0) / h);
  const sx = l + r > 0.5 ? 0.5 / (l + r) : 1;
  const sy = t + b > 0.5 ? 0.5 / (t + b) : 1;
  l *= sx; r *= sx; t *= sy; b *= sy;
  return { left: l, right: r, top: t, bottom: b };
}

/**
 * Encuadra toda la planta según su caja real y la relación de aspecto (retrato en móvil → vista lateral). Con paneles
 * superpuestos (`insets`) la encuadra en el hueco libre desplazando la imagen con `setViewOffset`. Publica la distancia
 * del encuadre general en `fitRef` (la usa el director de etiquetas).
 */
function FitCamera({ bounds, insets, fitRef }: { bounds: Bounds; insets?: SceneInsets; fitRef: { current: { distance: number } } }) {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const controls = useThree((s) => s.controls) as OrbitControlsImpl | null;
  const width = useThree((s) => s.size.width);
  const height = useThree((s) => s.size.height);
  // se reencuadra al cambiar el tamaño de forma apreciable (no a cada píxel)
  const wStep = Math.round(width / 40), hStep = Math.round(height / 40);
  const { cx, cz, halfX, halfZ, top } = bounds;
  const il = insets?.left ?? 0, ir = insets?.right ?? 0, it = insets?.top ?? 0, ib = insets?.bottom ?? 0;
  useLayoutEffect(() => {
    const w = wStep * 40 || 1, h = hStep * 40 || 1;
    const f = insetFractions({ left: il, right: ir, top: it, bottom: ib }, w, h);
    const fit = fitView({ cx, cz, halfX, halfZ, top }, w / h, f);
    fitRef.current.distance = fit.distance;
    const target = new THREE.Vector3(...fit.target);
    camera.position.copy(new THREE.Vector3(...fit.dir).normalize().multiplyScalar(fit.distance)).add(target);
    camera.lookAt(target);
    if (controls) {
      controls.target.copy(target);
      controls.update();
    }
  }, [wStep, hStep, camera, controls, cx, cz, halfX, halfZ, top, il, ir, it, ib, fitRef]);
  // desplazamiento de la imagen hacia el centro del hueco libre
  useLayoutEffect(() => {
    const f = insetFractions({ left: il, right: ir, top: it, bottom: ib }, width, height);
    const dx = ((f.left - f.right) / 2) * width, dy = ((f.top - f.bottom) / 2) * height;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) camera.clearViewOffset();
    else camera.setViewOffset(width, height, -dx, -dy, width, height);
    camera.updateProjectionMatrix();
    return () => camera.clearViewOffset();
  }, [camera, width, height, il, ir, it, ib]);
  return null;
}

/** Fondo con profundidad: del azul de superficie arriba al azul noche del horizonte (tokens de marca, globals.css). */
const SKY = `radial-gradient(130% 95% at 50% 0%, ${BRAND.surface2} 0%, ${BRAND.surface} 42%, ${HORIZON} 70%, ${BRAND.bg} 100%)`;

/** Lienzo 3D común (escritorio, móvil bajo demanda y vista previa de administración). */
export function SceneCanvas({
  bounds,
  data,
  shadowKey,
  testId = 'scene',
  label,
  onMissed,
  insets,
  children,
}: {
  bounds: Bounds;
  data: SceneData;
  /** cambia cuando cambia el conjunto de activos (recalcula las sombras de contacto) */
  shadowKey: string;
  testId?: string;
  label: string;
  onMissed?: () => void;
  /** paneles de vidrio superpuestos (px): la planta se encuadra en el hueco libre */
  insets?: SceneInsets;
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
  const fitRef = useRef({ distance: fit.distance });
  return (
    <div ref={rootRef} data-testid={testId} data-quality={quality} role="img" aria-label={label} className="scene-root absolute inset-0" style={{ background: SKY }}>
      <Canvas
        frameloop="demand"
        dpr={profile.dpr}
        shadows={profile.shadowMap > 0 ? 'percentage' : false}
        camera={{ position: [15, 10.5, 17], fov: 38, near: 0.1, far }}
        gl={{ antialias: QUALITY_PROFILE[init.start].msaa, powerPreference: 'high-performance', alpha: true }}
        onPointerMissed={onMissed}
      >
        <QualityContext.Provider value={quality}>
          <SceneDataContext.Provider value={data}>
            <fog attach="fog" args={[HORIZON, fit.distance * 1.25 + span, fit.distance * 4 + span * 3]} />
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
          <FitCamera bounds={bounds} insets={insets} fitRef={fitRef} />
          <FrameLimiter fps={profile.fps} />
          <LatencyPaint />
          <LabelDirector fitRef={fitRef} />
        </SceneDataContext.Provider>
        </QualityContext.Provider>
      </Canvas>
    </div>
  );
}
