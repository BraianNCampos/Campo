import * as THREE from 'three';

/** Texturas procedurales (canvas 2D, sin descargas). Fuera del navegador (SSR/pruebas) devuelven `null`. */
function canvas(w: number, h: number): { c: HTMLCanvasElement; g: CanvasRenderingContext2D } | null {
  if (typeof document === 'undefined') return null;
  try {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const g = c.getContext('2d');
    return g ? { c, g } : null;
  } catch {
    return null;
  }
}

/** PRNG determinista (mulberry32) para que las texturas sean estables entre cargas. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function finish(c: HTMLCanvasElement, color: boolean, repeat: [number, number] = [1, 1]): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(...repeat);
  t.anisotropy = 4;
  if (color) t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

/** Hormigón: moteado fino gris (se multiplica por el color del material). */
export function concreteTexture(repeat: [number, number] = [1, 1]): THREE.CanvasTexture | null {
  const cv = canvas(256, 256);
  if (!cv) return null;
  const { c, g } = cv;
  const r = rng(11);
  g.fillStyle = '#d9d9d9';
  g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 5200; i++) {
    const v = 150 + Math.floor(r() * 100);
    g.fillStyle = `rgba(${v},${v},${v},${0.18 + r() * 0.3})`;
    const s = 1 + r() * 2.2;
    g.fillRect(r() * 256, r() * 256, s, s);
  }
  // manchas suaves
  for (let i = 0; i < 26; i++) {
    const x = r() * 256, y = r() * 256, rad = 14 + r() * 38;
    const grad = g.createRadialGradient(x, y, 0, x, y, rad);
    const dark = r() > 0.5;
    grad.addColorStop(0, dark ? 'rgba(90,90,90,0.12)' : 'rgba(255,255,255,0.1)');
    grad.addColorStop(1, 'rgba(128,128,128,0)');
    g.fillStyle = grad;
    g.fillRect(x - rad, y - rad, rad * 2, rad * 2);
  }
  return finish(c, true, repeat);
}

/** Chapa trapezoidal/ondulada: relieve vertical (para `bumpMap`). */
export function corrugatedTexture(repeat: [number, number] = [1, 1]): THREE.CanvasTexture | null {
  const cv = canvas(128, 16);
  if (!cv) return null;
  const { c, g } = cv;
  const grad = g.createLinearGradient(0, 0, 128, 0);
  const n = 8;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    grad.addColorStop(t, i % 2 === 0 ? '#202020' : '#e8e8e8');
    if (i < n) grad.addColorStop(Math.min(1, t + 0.5 / n), '#808080');
  }
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 16);
  return finish(c, false, repeat);
}

/** Banda transportadora: goma oscura con tacos transversales; se anima desplazando `offset.x`. */
export function beltTexture(): THREE.CanvasTexture | null {
  const cv = canvas(256, 128);
  if (!cv) return null;
  const { c, g } = cv;
  const r = rng(5);
  g.fillStyle = '#23262b';
  g.fillRect(0, 0, 256, 128);
  for (let i = 0; i < 1400; i++) {
    const v = 28 + Math.floor(r() * 30);
    g.fillStyle = `rgb(${v},${v + 1},${v + 4})`;
    g.fillRect(r() * 256, r() * 128, 1 + r() * 2, 1 + r() * 2);
  }
  // tacos (cleats) cada 64 px
  for (let x = 0; x < 256; x += 64) {
    g.fillStyle = '#3a3f46';
    g.fillRect(x, 0, 7, 128);
    g.fillStyle = 'rgba(255,255,255,0.1)';
    g.fillRect(x, 0, 2, 128);
  }
  // bordes laterales
  g.fillStyle = '#15171a';
  g.fillRect(0, 0, 256, 7);
  g.fillRect(0, 121, 256, 7);
  return finish(c, true);
}
