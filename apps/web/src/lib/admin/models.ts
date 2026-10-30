import type { ModelInfo } from '@campo/shared';
import { modelIdOf } from '@/lib/catalog';

/** Tamaño máximo de un GLB (docs/architecture.md §10.2). */
export const MODEL_MAX_BYTES = 10 * 1024 * 1024;

/** "1,2 MB", "340 KB", "812 B". */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${Math.round(n)} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`.replace('.', ',');
  const mb = kb / 1024;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`.replace('.', ',');
}

/** Valida en cliente un archivo antes de enviarlo (la API vuelve a validar). Devuelve el mensaje o null. */
export function validateModelFile(file: { name: string; size: number }): string | null {
  if (!/\.glb$/i.test(file.name)) return 'El archivo debe ser un modelo GLB (extensión .glb).';
  if (file.size <= 0) return 'El archivo está vacío.';
  if (file.size > MODEL_MAX_BYTES) return `El archivo pesa ${formatBytes(file.size)} y el máximo es ${formatBytes(MODEL_MAX_BYTES)}.`;
  return null;
}

/** Nombre del modelo a partir del archivo: sin extensión, sin espacios sobrantes, ≤ 100 caracteres. */
export function modelNameFromFile(fileName: string): string {
  const base = fileName.replace(/\.glb$/i, '').replace(/[_\s]+/g, ' ').trim();
  return (base || 'modelo').slice(0, 100);
}

/** `model:<uuid>` → `<uuid>` (reexport cómodo para la UI de administración). */
export { modelIdOf };

/** Activos que usan cada modelo: id de modelo → ids de activo. */
export function modelUsage(assets: readonly { id: string; model3dRef: string | null }[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const a of assets) {
    const id = modelIdOf(a.model3dRef);
    if (id) (out[id] ??= []).push(a.id);
  }
  return out;
}

export const sortModels = (list: readonly ModelInfo[]): ModelInfo[] => [...list].sort((a, b) => b.createdAt - a.createdAt || a.name.localeCompare(b.name));
