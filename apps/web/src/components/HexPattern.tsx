/**
 * Patrón de hexágonos de la marca como fondo muy tenue (opacidad < 6 %). Decorativo: oculto a lectores de pantalla.
 * Se coloca como primer hijo de un contenedor `relative overflow-hidden`.
 */
const S = 14; // lado del hexágono
const H = (Math.sqrt(3) / 2) * S; // semialtura

function hex(cx: number, cy: number): string {
  const pts: [number, number][] = [[-S, 0], [-S / 2, -H], [S / 2, -H], [S, 0], [S / 2, H], [-S / 2, H]];
  return 'M' + pts.map(([x, y]) => `${(cx + x).toFixed(2)} ${(cy + y).toFixed(2)}`).join('L') + 'Z';
}

// mosaico de 3S × 4H con cuatro hexágonos (dos columnas desfasadas); los bordes repetidos coinciden entre mosaicos
const TILE_W = 3 * S;
const TILE_H = 4 * H;
const PATH = [hex(S, H), hex(S, 3 * H), hex(2.5 * S, 0), hex(2.5 * S, 2 * H), hex(2.5 * S, 4 * H)].join('');

export function HexPattern({ className = '' }: { className?: string }) {
  return (
    <svg aria-hidden="true" focusable="false" className={`pointer-events-none absolute inset-0 size-full text-fg opacity-[0.045] ${className}`}>
      <defs>
        <pattern id="campo-hex" width={TILE_W} height={TILE_H} patternUnits="userSpaceOnUse">
          <path d={PATH} fill="none" stroke="currentColor" strokeWidth="1" />
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill="url(#campo-hex)" />
    </svg>
  );
}
