/** Tema de la interfaz: el oscuro de siempre o el de alto contraste para luz solar (docs/ux-isa.md §2.6). */
export type Theme = 'dark' | 'contrast';

export const THEME_KEY = 'campo.theme';

export function readTheme(): Theme {
  try {
    return globalThis.localStorage?.getItem(THEME_KEY) === 'contrast' ? 'contrast' : 'dark';
  } catch {
    return 'dark';
  }
}

/** Aplica el tema al documento y lo recuerda. */
export function applyTheme(theme: Theme, doc: Document = document): void {
  if (theme === 'contrast') doc.documentElement.setAttribute('data-theme', 'contrast');
  else doc.documentElement.removeAttribute('data-theme');
  doc.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'contrast' ? '#ffffff' : '#0a1620');
  try {
    globalThis.localStorage?.setItem(THEME_KEY, theme);
  } catch {
    /* sin almacenamiento: el cambio dura lo que la pestaña */
  }
}

export const nextTheme = (t: Theme): Theme => (t === 'contrast' ? 'dark' : 'contrast');

/** Script que corre antes de pintar para no mostrar un destello del tema equivocado. */
export const THEME_BOOT_SCRIPT = `try{if(localStorage.getItem('${THEME_KEY}')==='contrast')document.documentElement.setAttribute('data-theme','contrast')}catch(e){}`;
