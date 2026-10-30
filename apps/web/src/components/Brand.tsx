/**
 * Identidad de Campo (Campos Ingeniería): un anillo claro con un segmento ámbar.
 * Geometría medida sobre el logo oficial (viewBox centrado en el anillo).
 */
const RING = 'M727.4 347.6A267 267 0 1 0 727.4 676.4L647.0 613.6A165 165 0 1 1 647.0 410.4Z';
const SEGMENT = 'M740.8 686.8A284 284 0 0 0 740.8 337.2L631.3 422.7A145 145 0 0 1 631.3 601.3Z';

/** El anillo solo. `size` en px o en cualquier unidad CSS (p. ej. "0.8em"). */
export function BrandMark({ size = 28, className }: { size?: number | string; className?: string }) {
  return (
    <svg viewBox="217 212 600 600" width={size} height={size} className={className} aria-hidden="true" focusable="false">
      <path d={RING} fill="var(--color-fg)" />
      <path d={SEGMENT} fill="var(--color-accent)" />
    </svg>
  );
}

/** Logotipo "campo": la última "o" es el anillo de la marca. */
export function Wordmark({ className = 'text-lg' }: { className?: string }) {
  return (
    <span
      className={`inline-flex items-baseline font-extrabold lowercase leading-none tracking-tight ${className}`}
      role="img"
      aria-label="Campo"
    >
      <span aria-hidden="true">camp</span>
      <BrandMark size="0.6em" className="ml-[0.05em] translate-y-[0.035em]" />
    </span>
  );
}

/** Marca de tamaño fijo para espacios reducidos (pantallas de carga, cabeceras compactas). */
export function Logo({ size = 28 }: { size?: number }) {
  return <BrandMark size={size} />;
}
