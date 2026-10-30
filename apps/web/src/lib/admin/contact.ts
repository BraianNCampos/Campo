/** Correo de Campos Ingeniería para pedir más módulos (configurable con `NEXT_PUBLIC_CONTACT_EMAIL`). */
export const DEFAULT_CONTACT_EMAIL = 'info@camposingenieria.ar';

const EMAIL = /^[^\s@<>"',;:]+@[^\s@<>"',;:]+\.[^\s@<>"',;:]+$/;

/** Valor de la variable de entorno si es un correo razonable; si no, el correo por defecto. */
export function resolveContactEmail(raw: string | undefined | null): string {
  const v = raw?.trim() ?? '';
  return EMAIL.test(v) ? v : DEFAULT_CONTACT_EMAIL;
}

// Next sólo sustituye referencias literales a process.env.NEXT_PUBLIC_*.
export const CONTACT_EMAIL = resolveContactEmail(process.env.NEXT_PUBLIC_CONTACT_EMAIL);

/** Enlace `mailto:` con un asunto opcional ya codificado. */
export function contactHref(email = CONTACT_EMAIL, subject?: string): string {
  return `mailto:${email}${subject ? `?subject=${encodeURIComponent(subject)}` : ''}`;
}
