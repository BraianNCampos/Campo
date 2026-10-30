import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = path.join(process.cwd(), 'src');
const SKIP = [path.join(SRC, 'components', 'admin'), path.join(SRC, 'lib', 'admin'), path.join(SRC, 'app', 'admin')];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    if (SKIP.includes(p)) return [];
    return statSync(p).isDirectory() ? files(p) : /\.(tsx?)$/.test(f) && !/\.test\./.test(f) ? [p] : [];
  });
}

/** Imperativos y formas en tuteo/neutro que no deben volver a la interfaz (voseo rioplatense). */
const TUTEO = /['"`>][^'"`<]*\b(Selecciona|Contacta|Añade|Añádelos|Elige|Pulsa|Crea la|Introduce|Haz clic|Vuelve a|Inténtalo|Reintenta\b|Arrastra|Usa la|Cierra sesión|tu rol)\b/;

describe('voseo rioplatense en los textos de la interfaz', () => {
  it('no quedan imperativos en tuteo en la zona de la aplicación (fuera de administración)', () => {
    const bad: string[] = [];
    for (const f of files(SRC)) {
      readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
        if (TUTEO.test(line)) bad.push(`${path.relative(SRC, f)}:${i + 1}: ${line.trim().slice(0, 90)}`);
      });
    }
    expect(bad).toEqual([]);
  });
  it('los textos clave usan voseo', () => {
    const read = (p: string) => readFileSync(path.join(SRC, p), 'utf8');
    expect(read('components/modules/NoModules.tsx')).toContain('Contactá a Campos Ingeniería');
    expect(read('components/MobileShell.tsx')).toContain('Cargala');
    expect(read('components/wall/WallScreen.tsx')).toContain('mantené apretado');
    expect(read('app/login/page.tsx')).toContain('Ingresá');
    expect(read('components/NoPlants.tsx')).toContain('Pedile');
  });
});
