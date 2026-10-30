import { beforeEach, describe, expect, it } from 'vitest';
import { applyTheme, nextTheme, readTheme, THEME_BOOT_SCRIPT, THEME_KEY } from './theme';

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
});

describe('tema de alto contraste', () => {
  it('por defecto es el oscuro', () => {
    expect(readTheme()).toBe('dark');
  });
  it('se aplica al documento y se recuerda en localStorage', () => {
    applyTheme('contrast');
    expect(document.documentElement.getAttribute('data-theme')).toBe('contrast');
    expect(localStorage.getItem(THEME_KEY)).toBe('contrast');
    expect(readTheme()).toBe('contrast');
    applyTheme('dark');
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    expect(readTheme()).toBe('dark');
  });
  it('alterna y el script de arranque restaura el tema antes de pintar', () => {
    expect(nextTheme('dark')).toBe('contrast');
    expect(nextTheme('contrast')).toBe('dark');
    localStorage.setItem(THEME_KEY, 'contrast');
    new Function(THEME_BOOT_SCRIPT)();
    expect(document.documentElement.getAttribute('data-theme')).toBe('contrast');
  });
  it('un valor desconocido se trata como oscuro', () => {
    localStorage.setItem(THEME_KEY, 'otro');
    expect(readTheme()).toBe('dark');
  });
});
