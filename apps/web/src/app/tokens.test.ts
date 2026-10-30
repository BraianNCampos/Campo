import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(path.join(process.cwd(), 'src/app/globals.css'), 'utf8');
const token = (name: string): string => {
  const m = new RegExp(`--color-${name}:\\s*(#[0-9a-fA-F]{6})`).exec(css);
  if (!m) throw new Error(`token --color-${name} no encontrado`);
  return m[1]!;
};

const lum = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
export const contrast = (a: string, b: string) => {
  const [x, y] = [lum(a), lum(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};
/** Mezcla `fg` sobre `bg` con opacidad `t` (los fondos suaves `bg-warn/15`, etc.). */
const mix = (fg: string, bg: string, t: number) =>
  '#' + [1, 3, 5].map((i) => Math.round(parseInt(fg.slice(i, i + 2), 16) * t + parseInt(bg.slice(i, i + 2), 16) * (1 - t)).toString(16).padStart(2, '0')).join('');

const SURFACES = ['bg', 'surface', 'surface-2'] as const;

describe('contraste AA de los tokens (WCAG 2.1)', () => {
  it.each(['fg', 'muted', 'accent', 'ok', 'calm', 'warn', 'crit', 'bad'])('texto «%s» ≥ 4.5:1 sobre bg, surface y surface-2', (name) => {
    for (const s of SURFACES) expect(contrast(token(name), token(s)), `${name} sobre ${s}`).toBeGreaterThanOrEqual(4.5);
  });
  it('estados sobre sus fondos suaves (chips y alarmas con /10–/15)', () => {
    for (const name of ['warn', 'crit', 'calm', 'bad']) {
      for (const t of [0.1, 0.15]) {
        for (const s of ['bg', 'surface'] as const) expect(contrast(token(name), mix(token(name), token(s), t)), `${name}/${t * 100} sobre ${s}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
  it('texto oscuro (bg) sobre botones y insignias de ámbar y rojo', () => {
    for (const name of ['accent', 'warn', 'crit']) expect(contrast(token('bg'), token(name))).toBeGreaterThanOrEqual(4.5);
  });
  it('elementos gráficos (relleno de barras) ≥ 3:1 sobre surface', () => {
    for (const name of ['calm-bar', 'warn', 'crit', 'bad']) expect(contrast(token(name), token('surface')), name).toBeGreaterThanOrEqual(3);
  });
  it('lo normal (calm) no es ámbar: el ámbar queda para la atención', () => {
    expect(token('calm')).not.toBe(token('warn'));
    expect(token('calm-bar')).not.toBe(token('accent'));
  });
});

describe('modo de alto contraste (luz solar)', () => {
  const block = /html\[data-theme='contrast'\]\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
  const t = (name: string): string => {
    const m = new RegExp(`--color-${name}:\\s*(#[0-9a-fA-F]{6})`).exec(block);
    if (!m) throw new Error(`token --color-${name} no definido en el tema de alto contraste`);
    return m[1]!;
  };
  it('define todos los tokens de color del tema', () => {
    for (const n of ['bg', 'surface', 'surface-2', 'line', 'fg', 'muted', 'accent', 'ok', 'calm', 'calm-bar', 'warn', 'crit', 'bad']) expect(() => t(n)).not.toThrow();
  });
  it('es un tema claro', () => {
    expect(block).toContain('color-scheme: light');
    expect(lum(t('bg'))).toBeGreaterThan(lum(t('fg')));
  });
  it('texto principal AAA (≥ 7:1) sobre bg, surface y surface-2', () => {
    for (const n of ['fg', 'muted']) for (const s of SURFACES) expect(contrast(t(n), t(s)), `${n} sobre ${s}`).toBeGreaterThanOrEqual(7);
  });
  it('estados (ámbar, rojo, verde azulado, sin datos) con texto ≥ 4.5:1 en todas las superficies y sobre sus fondos suaves', () => {
    for (const n of ['accent', 'ok', 'calm', 'warn', 'crit', 'bad']) {
      for (const s of SURFACES) expect(contrast(t(n), t(s)), `${n} sobre ${s}`).toBeGreaterThanOrEqual(4.5);
    }
    for (const n of ['warn', 'crit', 'calm', 'bad']) for (const s of ['bg', 'surface'] as const) expect(contrast(t(n), mix(t(n), t(s), 0.15)), `${n}/15 sobre ${s}`).toBeGreaterThanOrEqual(4.5);
  });
  it('texto claro sobre botones y insignias de ámbar/rojo; bordes y barras ≥ 3:1', () => {
    for (const n of ['accent', 'crit']) expect(contrast(t('bg'), t(n))).toBeGreaterThanOrEqual(7);
    expect(contrast(t('line'), t('bg'))).toBeGreaterThanOrEqual(3);
    for (const n of ['calm-bar', 'crit']) expect(contrast(t(n), t('surface')), n).toBeGreaterThanOrEqual(3);
  });
});
