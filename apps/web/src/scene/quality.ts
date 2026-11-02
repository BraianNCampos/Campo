import { createContext, useContext } from 'react';

/** Niveles de calidad del 3D (docs/architecture.md §13). 'high' = GPU discreta/integrada decente; 'low' = render por software. */
export type Quality = 'high' | 'medium' | 'low';

export const QUALITIES: readonly Quality[] = ['high', 'medium', 'low'];

/** Qué activa cada nivel. Todo lo caro se apaga de forma escalonada. */
export interface QualityProfile {
  /** ratio de píxeles máximo del canvas */
  dpr: number;
  /** sombras proyectadas por la luz principal (tamaño del mapa; 0 = sin sombras) */
  shadowMap: number;
  /** sombras de contacto horneadas (ContactShadows) */
  contactShadows: boolean;
  /** entorno de estudio procedural para los reflejos PBR */
  environment: boolean;
  /** luces de relleno adicionales (puntuales/area) */
  fillLights: boolean;
  /** segmentos radiales de cilindros (silo/tanque) */
  radial: number;
  /** nervaduras/rodillos/peldaños: multiplicador de detalle (0..1) */
  detail: number;
  /** texturas procedurales (hormigón, banda, chapa) */
  textures: boolean;
  /** luces puntuales máximas simultáneas de anomalía */
  maxAnomalyLights: number;
  /** MSAA (sólo se decide al crear el contexto WebGL) */
  msaa: boolean;
  /** tuberías: soportes y juntas */
  pipeDetail: boolean;
  /** frecuencia máxima de frames (frameloop bajo demanda) */
  fps: number;
}

export const QUALITY_PROFILE: Record<Quality, QualityProfile> = {
  high: { dpr: 1.5, shadowMap: 2048, contactShadows: true, environment: true, fillLights: true, radial: 48, detail: 1, textures: true, maxAnomalyLights: 6, msaa: true, pipeDetail: true, fps: 30 },
  medium: { dpr: 1.25, shadowMap: 1024, contactShadows: false, environment: true, fillLights: true, radial: 28, detail: 0.6, textures: true, maxAnomalyLights: 3, msaa: true, pipeDetail: true, fps: 30 },
  low: { dpr: 1, shadowMap: 0, contactShadows: false, environment: false, fillLights: false, radial: 16, detail: 0.3, textures: false, maxAnomalyLights: 1, msaa: false, pipeDetail: false, fps: 20 },
};

/** Detecta renderizado WebGL por software (SwiftShader/llvmpipe): muy lento con MSAA y sombras. */
export function isSoftwareRenderer(): boolean {
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    if (!gl) return true;
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    const name = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : '';
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return /swiftshader|llvmpipe|software|softpipe/i.test(name);
  } catch {
    return false;
  }
}

/** Valor de `?quality=` si es un nivel válido; si no, null. */
export function forcedQuality(search = typeof location === 'undefined' ? '' : location.search): Quality | null {
  const forced = new URLSearchParams(search).get('quality');
  return forced === 'low' || forced === 'medium' || forced === 'high' ? forced : null;
}

/**
 * `?quality=low|medium|high` fuerza el nivel (y desactiva el ajuste automático); si no, 'low' sólo con render por
 * software y 'high' en el resto (el `PerformanceMonitor` baja o sube después según los fps reales).
 */
export function detectQuality(search = typeof location === 'undefined' ? '' : location.search): Quality {
  return forcedQuality(search) ?? (isSoftwareRenderer() ? 'low' : 'high');
}

/** Un nivel menos de calidad (o el mismo si ya es el mínimo). */
export function stepDown(q: Quality): Quality {
  return q === 'high' ? 'medium' : 'low';
}

/** Un nivel más de calidad sin pasar de `cap`. */
export function stepUp(q: Quality, cap: Quality = 'high'): Quality {
  const next: Quality = q === 'low' ? 'medium' : 'high';
  return QUALITIES.indexOf(next) < QUALITIES.indexOf(cap) ? cap : next;
}

export const QualityContext = createContext<Quality>('high');
export const useQuality = (): Quality => useContext(QualityContext);
export const useQualityProfile = (): QualityProfile => QUALITY_PROFILE[useContext(QualityContext)];
