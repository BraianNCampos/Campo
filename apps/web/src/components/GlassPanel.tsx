import type { ElementType, HTMLAttributes } from 'react';

/**
 * Panel de vidrio: fondo translúcido con desenfoque, borde fino y sombra mínima (clase `.glass`, globals.css).
 * Degrada a superficie sólida sin soporte de `backdrop-filter` y en el tema de alto contraste.
 */
export function GlassPanel({
  as: Tag = 'div',
  className = '',
  ...rest
}: { as?: ElementType; className?: string } & HTMLAttributes<HTMLElement>) {
  return <Tag className={`glass ${className}`} {...rest} />;
}
