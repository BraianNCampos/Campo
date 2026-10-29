import { assetKind } from '@/lib/assets';

export type Vec3 = [number, number, number];

/** Altura del eje de las tuberías sobre el suelo. */
export const PIPE_Y = 0.8;

/** Posiciones de la planta demo (tk-01..04, pump-01..02, valve-01..02). */
export const LAYOUT: Record<string, Vec3> = {
  'tk-01': [-8, 0, -3.5],
  'tk-02': [-8, 0, 3.5],
  'tk-03': [7, 0, -3.5],
  'tk-04': [7, 0, 3.5],
  'valve-01': [-4.6, 0, -3.5],
  'valve-02': [-4.6, 0, 3.5],
  'pump-01': [-1.8, 0, -3.5],
  'pump-02': [-1.8, 0, 3.5],
};

/** Activos que no están en LAYOUT se colocan en una fila trasera, por tipo. */
export function positionFor(id: string, index: number): Vec3 {
  const known = LAYOUT[id];
  if (known) return known;
  const kind = assetKind(id);
  const row = kind === 'tank' ? 0 : kind === 'pump' ? 1 : 2;
  return [-9 + (index % 7) * 3, 0, 8 + row * 2.6 + Math.floor(index / 7) * 8];
}

/** Línea de proceso: la bomba (y su válvula) gobiernan el caudal de las tuberías asociadas. */
export interface Line {
  pump: string;
  valve: string;
}
export const LINES: Line[] = [
  { pump: 'pump-01', valve: 'valve-01' },
  { pump: 'pump-02', valve: 'valve-02' },
];

export interface PipeDef {
  id: string;
  points: Vec3[];
  /** bombas cuyo caudal alimenta esta tubería (se suma, máx. 1) */
  pumps: string[];
}

const y = PIPE_Y;
export const PIPES: PipeDef[] = [
  { id: 'in-1a', pumps: ['pump-01'], points: [[-6.6, y, -3.5], [-5.2, y, -3.5]] },
  { id: 'in-1b', pumps: ['pump-01'], points: [[-4.0, y, -3.5], [-2.9, y, -3.5]] },
  { id: 'in-2a', pumps: ['pump-02'], points: [[-6.6, y, 3.5], [-5.2, y, 3.5]] },
  { id: 'in-2b', pumps: ['pump-02'], points: [[-4.0, y, 3.5], [-2.9, y, 3.5]] },
  { id: 'out-1', pumps: ['pump-01'], points: [[-0.7, y, -3.5], [2.2, y, -3.5], [2.2, y, 0]] },
  { id: 'out-2', pumps: ['pump-02'], points: [[-0.7, y, 3.5], [2.2, y, 3.5], [2.2, y, 0]] },
  { id: 'trunk', pumps: ['pump-01', 'pump-02'], points: [[2.2, y, 0], [4.4, y, 0]] },
  { id: 'br-3', pumps: ['pump-01', 'pump-02'], points: [[4.4, y, 0], [4.4, y, -3.5], [5.6, y, -3.5]] },
  { id: 'br-4', pumps: ['pump-01', 'pump-02'], points: [[4.4, y, 0], [4.4, y, 3.5], [5.6, y, 3.5]] },
];
