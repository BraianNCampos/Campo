const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

export function focusableIn(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => !el.hasAttribute('inert') && el.getAttribute('aria-hidden') !== 'true');
}

/**
 * Destino del foco al pulsar Tab dentro de un diálogo (foco atrapado): del último al primero y
 * viceversa; si el foco está fuera del diálogo, entra en él. `null` = dejar que el navegador actúe.
 */
export function nextFocusTarget(items: HTMLElement[], active: Element | null, backwards: boolean, container: HTMLElement): HTMLElement | null {
  if (items.length === 0) return container;
  const first = items[0]!;
  const last = items[items.length - 1]!;
  if (!active || !container.contains(active) || active === container) return backwards ? last : first;
  if (backwards && active === first) return last;
  if (!backwards && active === last) return first;
  return null;
}
