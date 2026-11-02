import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssetDef, Limit } from '@campo/shared';
import { emptyBatch } from '@/lib/batcher';
import { clearHistory } from '@/store/history';
import { useLiveStore } from '@/store/live-store';
import { ModuleCard } from '../modules/ModuleCard';
import { TrendPanel } from './TrendPanel';
import { trendMetrics, trendRefLines } from './trend-model';
import { useTrendStore } from './trend-store';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const lim = (metric: string, operator: Limit['operator'], threshold: number, severity: Limit['severity'] = 'warning'): Limit => ({ asset: 'tk-01', metric, operator, threshold, severity });
const tank: AssetDef = { plant: 'demo', id: 'tk-01', name: 'Tanque Norte', type: 'tank', model3dRef: null, metadata: { setpoints: { level: 60 } } };

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null); // jsdom no dibuja canvas
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  useLiveStore.getState().reset();
  useTrendStore.getState().close();
  clearHistory();
  act(() => {
    useLiveStore.getState().setCatalog([tank]);
    useLiveStore.getState().setLimits([lim('level', 'gt', 90, 'critical'), lim('level', 'lt', 10), lim('temp', 'gt', 35)]);
    const b = emptyBatch();
    b.telemetry['tk-01'] = { ts: Date.now(), quality: 'good', values: { level: 72, temp: 21 } };
    useLiveStore.getState().applyBatch(b);
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  act(() => root.unmount());
  host.remove();
});

describe('modelo de la tendencia', () => {
  it('métrica principal primero y las secundarias que ya tienen dato', () => {
    expect(trendMetrics(tank, { ts: 1, quality: 'good', values: { level: 1, temp: 2 } }, 'level')).toEqual(['level', 'temp']);
    expect(trendMetrics(tank, { ts: 1, quality: 'good', values: { level: 1 } }, 'level')).toEqual(['level']);
    expect(trendMetrics(undefined, undefined, 'level')).toEqual(['level']);
  });
  it('líneas: SP y cada límite rotulado (HH, HI, LO, LL)', () => {
    const l = trendRefLines([lim('level', 'gt', 90, 'critical'), lim('level', 'lt', 10)], 60);
    expect(l.map((x) => [x.label, x.kind])).toEqual([['SP 60', 'sp'], ['HH 90', 'critical'], ['LO 10', 'warning']]);
    expect(trendRefLines([], undefined)).toEqual([]);
  });
});

describe('panel de tendencia', () => {
  const click = (el: Element | null) => act(() => (el as HTMLElement).click());
  const key = (k: string, shift = false) => act(() => void document.dispatchEvent(new KeyboardEvent('keydown', { key: k, shiftKey: shift, bubbles: true, cancelable: true })));

  it('un clic en la tarjeta lo abre con SP y límites; Esc lo cierra y devuelve el foco', () => {
    act(() => root.render(<><ModuleCard id="tk-01" /><TrendPanel /></>));
    expect(host.querySelector('[data-testid="trend-panel"]')).toBeNull();
    const opener = host.querySelector<HTMLButtonElement>('[data-testid="trend-open-tk-01"]')!;
    opener.focus();
    click(opener);
    const panel = host.querySelector('[data-testid="trend-panel"]')!;
    expect(panel.getAttribute('role')).toBe('dialog');
    expect(panel.getAttribute('aria-modal')).toBe('true');
    const lines = [...host.querySelectorAll('[data-testid="trend-lines"] li')].map((x) => x.textContent);
    expect(lines).toEqual(['SP 60 %', 'HH 90 %', 'LO 10 %']);
    expect(host.querySelector('[data-testid="trend-chart"]')?.getAttribute('data-state')).toBe('ready');
    key('Escape');
    expect(host.querySelector('[data-testid="trend-panel"]')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('el foco queda atrapado: Tab en el último pasa al primero y Mayús+Tab al revés', () => {
    act(() => useTrendStore.getState().show('tk-01', 'level'));
    act(() => root.render(<TrendPanel />));
    const focusables = [...host.querySelectorAll<HTMLElement>('button')];
    // jsdom no calcula offsetParent: los botones del panel cuentan como visibles solo si el filtro lo permite
    const first = focusables[0]!;
    const last = focusables[focusables.length - 1]!;
    last.focus();
    key('Tab');
    expect(document.activeElement).not.toBe(document.body);
    first.focus();
    key('Tab', true);
    expect(host.contains(document.activeElement)).toBe(true);
  });

  it('selector de métrica secundaria y de ventana', () => {
    act(() => useTrendStore.getState().show('tk-01', 'level'));
    act(() => root.render(<TrendPanel />));
    expect(host.querySelectorAll('[data-testid^="trend-window-"]')).toHaveLength(4);
    expect(host.querySelector('[data-testid="trend-window-1h"]')?.getAttribute('aria-pressed')).toBe('true');
    click(host.querySelector('[data-testid="trend-window-24h"]'));
    expect(host.querySelector('[data-testid="trend-window-24h"]')?.getAttribute('aria-pressed')).toBe('true');
    click(host.querySelector('[data-testid="trend-metric-temp"]'));
    expect(useTrendStore.getState().open?.metric).toBe('temp');
    expect([...host.querySelectorAll('[data-testid="trend-lines"] li')].map((x) => x.textContent)).toEqual(['HI 35 °C']);
  });

  it('cerrar con el botón y con el fondo', () => {
    act(() => useTrendStore.getState().show('tk-01', 'level'));
    act(() => root.render(<TrendPanel />));
    click(host.querySelector('[data-testid="trend-close"]'));
    expect(useTrendStore.getState().open).toBeNull();
  });
});
