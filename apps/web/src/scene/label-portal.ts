/**
 * Contenedor DOM estable para las etiquetas HTML (`<Html portal>` de drei). Sin esto, drei calcula el
 * destino con `events.connected` (null en el primer render) y re-ejecuta el efecto con otro destino
 * sobre el mismo elemento: crea dos raíces React en él y al desmontar (cambio de planta o de ruta)
 * falla con "removeChild … not a child". Con un destino fijo desde el primer render sólo hay una.
 */
export const labelPortal: { current: HTMLElement | null } = { current: null };

/** Tipado que exige drei (`RefObject<HTMLElement>`): siempre está fijado antes de que se rendericen las etiquetas. */
export const labelPortalRef = labelPortal as unknown as { current: HTMLElement };
