import { CatalogCoalescer } from './catalog-coalescer';

describe('CatalogCoalescer', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('una ráfaga de avisos de una planta produce un único aviso al cerrar la ventana', () => {
    const out: string[] = [];
    const c = new CatalogCoalescer(250, (p) => out.push(p));
    for (let i = 0; i < 20; i++) c.push('demo');
    jest.advanceTimersByTime(249);
    expect(out).toEqual([]);
    jest.advanceTimersByTime(1);
    expect(out).toEqual(['demo']);
    jest.advanceTimersByTime(1000);
    expect(out).toEqual(['demo']);
  });

  it('cada planta tiene su ventana; tras emitir, un aviso nuevo abre otra', () => {
    const out: string[] = [];
    const c = new CatalogCoalescer(250, (p) => out.push(p));
    c.push('demo');
    jest.advanceTimersByTime(100);
    c.push('norte');
    jest.advanceTimersByTime(150);
    expect(out).toEqual(['demo']);
    jest.advanceTimersByTime(100);
    expect(out).toEqual(['demo', 'norte']);
    c.push('demo');
    jest.advanceTimersByTime(250);
    expect(out).toEqual(['demo', 'norte', 'demo']);
  });

  it('dispose cancela lo pendiente', () => {
    const out: string[] = [];
    const c = new CatalogCoalescer(250, (p) => out.push(p));
    c.push('demo');
    c.dispose();
    jest.advanceTimersByTime(1000);
    expect(out).toEqual([]);
  });
});
