/** Tiempo relativo en español: "ahora", "hace 5 min", "hace 2 h", "hace 3 d". */
export function formatRelativeTime(ts: number, now = Date.now()): string {
  const s = Math.round((now - ts) / 1000);
  if (s < 5) return 'ahora';
  if (s < 60) return `hace ${s} s`;
  if (s < 3600) return `hace ${Math.floor(s / 60)} min`;
  if (s < 86_400) return `hace ${Math.floor(s / 3600)} h`;
  if (s < 86_400 * 60) return `hace ${Math.floor(s / 86_400)} d`;
  return `hace ${Math.floor(s / (86_400 * 30))} meses`;
}

export function formatAbsoluteTime(ts: number): string {
  return new Date(ts).toLocaleString('es-AR', { dateStyle: 'medium', timeStyle: 'medium' });
}

export const prettyJson = (v: unknown): string => JSON.stringify(v, null, 2);

/** Une una lista para frases: "a, b y c". */
export function joinList(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} y ${items[items.length - 1]}`;
}
