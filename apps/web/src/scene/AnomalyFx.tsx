'use client';

import { useEffect, useRef, useState, type RefObject } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { ANOMALY_HEX, ANOMALY_LABEL, ANOMALY_RANK, anomalyAt, anomalyText, outlineWidthPx, pulseAt, type Anomaly, type AnomalyLevel } from './anomaly';
import { anomalyLights, type LightRequest } from './anomaly-registry';
import type { Vec3 } from './layout';
import './anomaly-fx.css';
import { useAssetTarget } from './useAssetTarget';
import { useQualityProfile } from './quality';

const VERT = /* glsl */ `
  uniform vec2 uViewport;
  uniform float uWidth;
  void main() {
    vec4 clip = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    vec3 n = normalize(normalMatrix * normal);
    vec2 d = (projectionMatrix * vec4(n, 0.0)).xy;
    d = length(d) > 1e-4 ? normalize(d) : vec2(0.0);
    clip.xy += d * (uWidth * 2.0) / uViewport * clip.w;
    gl_Position = clip;
  }
`;
const FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uGlow;
  void main() {
    gl_FragColor = vec4(uColor * uGlow, 1.0);
    #include <colorspace_fragment>
  }
`;

/** Material del contorno: casco invertido (caras traseras) engrosado en espacio de pantalla, color puro sin iluminar. */
function outlineMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: { uColor: { value: new THREE.Color('#ffb020') }, uWidth: { value: 2 }, uViewport: { value: new THREE.Vector2(1, 1) }, uGlow: { value: 1 } },
    side: THREE.BackSide,
    toneMapped: false,
    fog: false,
  });
}

function setOutline(mat: THREE.ShaderMaterial, color: THREE.Color, widthPx: number, w: number, h: number, glow: number): void {
  (mat.uniforms.uColor!.value as THREE.Color).copy(color);
  mat.uniforms.uWidth!.value = widthPx;
  (mat.uniforms.uViewport!.value as THREE.Vector2).set(w, h);
  mat.uniforms.uGlow!.value = glow;
}

// Geometría suavizada (normales promediadas) para que el casco no se abra en las aristas de las cajas.
const smoothCache = new WeakMap<THREE.BufferGeometry, THREE.BufferGeometry>();
function smoothed(src: THREE.BufferGeometry): THREE.BufferGeometry {
  let g = smoothCache.get(src);
  if (!g) {
    const bare = new THREE.BufferGeometry();
    bare.setAttribute('position', src.getAttribute('position'));
    if (src.index) bare.setIndex(src.index);
    const merged = mergeVertices(bare.index ? bare.toNonIndexed() : bare, 1e-3);
    merged.computeVertexNormals();
    g = merged;
    smoothCache.set(src, g);
    const out = g;
    src.addEventListener('dispose', () => {
      out.dispose();
      smoothCache.delete(src);
    });
  }
  return g;
}

/** ¿Esta malla recibe contorno? Opacas y no marcadas `noOutline`; las translúcidas sólo si se marcan `outline` (cascos). */
export function outlinable(o: THREE.Object3D): o is THREE.Mesh {
  const m = o as THREE.Mesh;
  if (!m.isMesh || o.userData.isOutline || o.userData.noOutline) return false;
  if ((o as THREE.SkinnedMesh).isSkinnedMesh || (o as THREE.InstancedMesh).isInstancedMesh) return false;
  if (!m.geometry?.getAttribute('position')) return false;
  const mat = m.material as THREE.Material;
  return !mat.transparent || !!o.userData.outline;
}

/** Preferencias de la vista que cambian el aviso: sin movimiento y alto contraste (tema propio o del sistema). */
export function readViewPrefs(): { still: boolean; contrast: boolean } {
  try {
    return {
      still: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
      contrast: window.matchMedia('(prefers-contrast: more)').matches || document.documentElement.getAttribute('data-theme') === 'contrast',
    };
  } catch {
    return { still: false, contrast: false };
  }
}

interface Props {
  id: string;
  name: string;
  tag?: string | null;
  radius: number;
  labelPos: [number, number, number];
  groupRef: RefObject<THREE.Group | null>;
  labelRef: RefObject<HTMLDivElement | null>;
  noteRef: RefObject<HTMLElement | null>;
  holoRef: RefObject<HTMLElement | null>;
}

interface RigRefs {
  group: RefObject<THREE.Group | null>;
  label: RefObject<HTMLDivElement | null>;
  note: RefObject<HTMLElement | null>;
  holoText: RefObject<HTMLElement | null>;
  holo: RefObject<THREE.Group | null>;
  ringA: RefObject<THREE.Mesh | null>;
  ringB: RefObject<THREE.Mesh | null>;
  disc: RefObject<THREE.Mesh | null>;
  beam: RefObject<THREE.Mesh | null>;
}

/** Estado imperativo del aviso de un equipo (contornos, DOM, luz); lo conduce `AnomalyFx` en cada frame. */
export class AnomalyRig {
  readonly mat = outlineMaterial();
  private outlines = new Map<THREE.Mesh, THREE.Mesh>();
  private shown: AnomalyLevel | null = null;
  private prefs = { still: false, contrast: false };
  private prefsAt = -1;
  private scanAt = 0;
  private text = '';
  private reg: LightRequest = { level: 'attention', rank: 1, pos: new THREE.Vector3(), color: new THREE.Color(), pulse: 1 };
  private color = new THREE.Color();

  constructor(private readonly id: string) {}

  /** Crea los contornos que falten (el GLB puede cargar después) y oculta/retira los de mallas que ya no están. */
  private scan(root: THREE.Object3D | null, visible: boolean): void {
    if (root) {
      root.traverse((o) => {
        if (!outlinable(o)) return;
        let out = this.outlines.get(o);
        if (!out) {
          out = new THREE.Mesh(smoothed(o.geometry), this.mat);
          out.userData.isOutline = true;
          out.raycast = () => {}; // el contorno no captura clics
          out.castShadow = false;
          out.receiveShadow = false;
          out.frustumCulled = o.frustumCulled;
          o.add(out);
          this.outlines.set(o, out);
        }
        out.visible = visible;
      });
    }
    for (const [m, o] of this.outlines) {
      o.visible = visible;
      if (!m.parent) {
        o.removeFromParent();
        this.outlines.delete(m);
      }
    }
  }

  update(
    state: { clock: THREE.Clock; size: { width: number; height: number } },
    p: { anomaly: Anomaly | null; values: Record<string, number> | undefined; name: string; tag?: string | null; labelPos: Vec3; size: number; maxLights: number },
    r: RigRefs,
  ): void {
    const a = p.anomaly;
    const level = a?.level ?? null;
    const t0 = state.clock.elapsedTime;
    if (this.prefsAt < 0 || t0 - this.prefsAt > 1) {
      this.prefsAt = t0;
      this.prefs = readViewPrefs();
    }
    const label = r.label.current;
    if (level !== this.shown) {
      this.shown = level;
      this.text = '';
      this.scan(r.group.current, level !== null);
      this.scanAt = t0;
      if (r.holo.current) r.holo.current.visible = level !== null;
      if (label) {
        if (level) {
          label.dataset.anomaly = level;
          label.dataset.alarm = a?.severity ?? 'warning'; // compatibilidad con selectores existentes (e2e, estilos)
          label.style.setProperty('--anomaly', ANOMALY_HEX[level]);
        } else {
          delete label.dataset.anomaly;
          delete label.dataset.alarm;
          label.style.removeProperty('--anomaly');
        }
      }
      if (r.note.current) r.note.current.textContent = level ? ANOMALY_LABEL[level] : '';
      if (!level) {
        if (r.holoText.current) r.holoText.current.textContent = '';
        anomalyLights.delete(this.id);
      }
    }
    if (!a || !level) return;

    // rótulo con tag, valor y límite (sólo escribe en el DOM si cambia)
    const t = anomalyText(a, p.values, p.tag, p.name);
    // el tag y el nombre ya van en la cabecera del rótulo; aquí: tipo de alarma, valor y límite
    const line = `${a.kind ? `${a.kind} · ` : ''}${t.value}${t.limit ? `\n${t.limit}` : ''}`;
    if (this.text !== line && r.holoText.current) {
      this.text = line;
      r.holoText.current.textContent = line;
    }
    // mallas nuevas (modelo GLB cargado más tarde)
    if (t0 - this.scanAt > 1) {
      this.scanAt = t0;
      this.scan(r.group.current, true);
    }

    const { still, contrast } = this.prefs;
    const k = pulseAt(t0, still, level);
    this.color.set(ANOMALY_HEX[level]);
    setOutline(this.mat, this.color, outlineWidthPx(level, contrast), state.size.width, state.size.height, 0.55 + 0.45 * k);

    // marcador holográfico: anillos que giran y flotan (quietos con reduced-motion)
    const g = r.holo.current;
    if (g) {
      g.position.y = p.labelPos[1] + 0.2 + (still ? 0 : Math.sin(t0 * 1.6) * 0.06);
      if (r.ringA.current) r.ringA.current.rotation.z = still ? 0 : t0 * 0.9;
      if (r.ringB.current) r.ringB.current.rotation.z = still ? 0 : -t0 * 1.4;
      r.disc.current?.scale.setScalar(still ? 1 : 1 + 0.04 * Math.sin(t0 * 3));
      const paint = (mesh: THREE.Mesh | null, opacity: number) => {
        const m = mesh?.material as THREE.MeshBasicMaterial | undefined;
        if (m) {
          m.color.copy(this.color);
          m.opacity = opacity;
        }
      };
      paint(r.ringA.current, 0.55 + 0.4 * k);
      paint(r.ringB.current, 0.55 + 0.4 * k);
      paint(r.disc.current, 0.1 + 0.1 * k);
      paint(r.beam.current, 0.35 + 0.25 * k);
    }

    // luz puntual del mismo color (la reparte el pool de `AnomalyLights`)
    if (p.maxLights > 0) {
      this.reg.level = level;
      this.reg.rank = ANOMALY_RANK[level];
      this.reg.color.copy(this.color);
      this.reg.pulse = k;
      const root = r.group.current;
      if (root) {
        root.getWorldPosition(this.reg.pos);
        this.reg.pos.y += p.labelPos[1] * 0.55 + 0.8;
      }
      anomalyLights.set(this.id, this.reg);
    }
  }

  dispose(): void {
    for (const o of this.outlines.values()) o.removeFromParent();
    this.outlines.clear();
    this.mat.dispose();
    anomalyLights.delete(this.id);
  }
}

/**
 * Anomalía sobre el equipo (§13, ISA-101): contorno brillante (ámbar atención · rojo crítica · magenta sin reconocer
 * > 5 min), marcador holográfico flotante (anillos + rótulo con tag, valor y límite) y luz puntual del mismo color.
 * El resto del modelo no se tiñe. Todo se actualiza en `useFrame` leyendo el store de forma transitoria (sin React).
 * Respeta `prefers-reduced-motion` (sin pulso ni giro) y el contraste alto (contornos más gruesos).
 */
export function AnomalyFx({ id, name, tag, radius, labelPos, groupRef, labelRef, noteRef, holoRef }: Props) {
  const target = useAssetTarget(id);
  const prof = useQualityProfile();
  const [rig] = useState(() => new AnomalyRig(id));
  useEffect(() => () => rig.dispose(), [rig]);
  const holo = useRef<THREE.Group>(null);
  const ringA = useRef<THREE.Mesh>(null);
  const ringB = useRef<THREE.Mesh>(null);
  const disc = useRef<THREE.Mesh>(null);
  const beam = useRef<THREE.Mesh>(null);
  const size = Math.min(0.9, Math.max(0.45, radius * 0.28));

  useFrame((state) => {
    rig.update(
      state,
      { anomaly: anomalyAt(target.current.anomaly ?? null, Date.now()), values: target.current.state?.values, name, tag, labelPos, size, maxLights: prof.maxAnomalyLights },
      { group: groupRef, label: labelRef, note: noteRef, holoText: holoRef, holo, ringA, ringB, disc, beam },
    );
  });

  return (
    <group ref={holo} position={[labelPos[0], labelPos[1] + 0.2, labelPos[2]]} visible={false} userData={{ noOutline: true }}>
      <mesh ref={ringA} rotation-x={-Math.PI / 2} raycast={() => {}}>
        <ringGeometry args={[size, size + 0.07, 48]} />
        <meshBasicMaterial transparent opacity={0.9} toneMapped={false} side={THREE.DoubleSide} depthWrite={false} />
      </mesh>
      <mesh ref={ringB} rotation-x={-Math.PI / 2} position-y={0.04} raycast={() => {}}>
        <ringGeometry args={[size * 0.68, size * 0.72, 40, 1, 0, Math.PI * 1.5]} />
        <meshBasicMaterial transparent opacity={0.9} toneMapped={false} side={THREE.DoubleSide} depthWrite={false} />
      </mesh>
      <mesh ref={disc} rotation-x={-Math.PI / 2} position-y={-0.02} raycast={() => {}}>
        <circleGeometry args={[size * 0.64, 32]} />
        <meshBasicMaterial transparent opacity={0.15} toneMapped={false} side={THREE.DoubleSide} depthWrite={false} />
      </mesh>
      {/* haz vertical que une el marcador con el equipo */}
      <mesh ref={beam} position-y={-0.35} raycast={() => {}}>
        <cylinderGeometry args={[0.012, 0.012, 0.7, 6]} />
        <meshBasicMaterial transparent opacity={0.5} toneMapped={false} depthWrite={false} />
      </mesh>
    </group>
  );
}
