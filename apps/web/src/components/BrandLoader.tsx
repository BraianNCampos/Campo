import { BrandMark } from './Brand';

/** Pantalla de carga con la marca: el anillo late despacio (sin movimiento si se prefiere reducirlo). */
export function BrandLoader({ label = 'Cargando' }: { label?: string }) {
  return (
    <div className="flex h-dvh flex-col items-center justify-center gap-4 bg-bg" role="status" aria-label={label}>
      <BrandMark size={56} className="animate-pulse" />
      <p className="text-xs font-semibold tracking-[0.18em] text-muted uppercase">{label}</p>
    </div>
  );
}
