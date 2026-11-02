import { useEffect, type RefObject } from 'react';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Foco atrapado dentro de `ref` mientras `active`, Esc cierra y al terminar el foco vuelve a quien lo tenía. */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, active: boolean, onClose: () => void): void {
  useEffect(() => {
    const el = ref.current;
    if (!active || !el) return;
    const opener = document.activeElement as HTMLElement | null;
    const items = () => [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((x) => x.offsetParent !== null || x === document.activeElement);
    (items()[0] ?? el).focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const list = items();
      if (list.length === 0) {
        e.preventDefault();
        return;
      }
      const first = list[0]!;
      const last = list[list.length - 1]!;
      const cur = document.activeElement;
      if (!el.contains(cur)) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && cur === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && cur === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      if (opener && document.contains(opener)) opener.focus();
    };
  }, [ref, active, onClose]);
}
