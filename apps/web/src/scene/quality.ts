export type Quality = 'high' | 'low';

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

/**
 * `?quality=low|high` fuerza el nivel; si no, 'low' sólo con render por software.
 * Nivel bajo: sin MSAA, dpr 1, sin sombras de contacto.
 */
export function detectQuality(search = typeof location === 'undefined' ? '' : location.search): Quality {
  const forced = new URLSearchParams(search).get('quality');
  if (forced === 'low' || forced === 'high') return forced;
  return isSoftwareRenderer() ? 'low' : 'high';
}
