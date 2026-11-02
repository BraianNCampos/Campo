import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useLatencyStore } from '@/store/latency-store';
import { useLiveStore } from '@/store/live-store';
import { LatencyBadge } from './LatencyBadge';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  useLiveStore.getState().reset();
  useLatencyStore.getState().reset();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const badge = () => host.querySelector('[data-testid="latency-badge"]') as HTMLElement;

/** Mide `ms` de latencia con una muestra pintada en `now`. */
function measure(ms: number, now = 1_000_000) {
  const st = useLatencyStore.getState();
  st.addSync(0, 0, 0);
  st.noteIngest('a', now - ms);
  act(() => {
    st.paint('scene', now);
    st.refresh(now);
  });
}

describe('LatencyBadge', () => {
  it('demo: «Demo» (con la latencia del búfer simulado si existe)', () => {
    act(() => root.render(<LatencyBadge />));
    expect(badge().textContent).toBe('Demo');
    act(() => useLiveStore.setState({ latencyMs: 42 }));
    expect(badge().textContent).toBe('Demo · 42 ms');
    expect(badge().dataset.level).toBe('none');
  });

  it('en vivo sin muestras: «Latencia —»', () => {
    useLiveStore.setState({ mode: 'live', connection: 'open' });
    act(() => root.render(<LatencyBadge />));
    expect(badge().textContent).toBe('Latencia —');
  });

  it.each([
    [120, 'ok'],
    [800, 'warn'],
    [2500, 'crit'],
  ])('muestra p50/p95 con color: %i ms → %s', (ms, level) => {
    useLiveStore.setState({ mode: 'live', connection: 'open' });
    act(() => root.render(<LatencyBadge />));
    measure(ms);
    expect(badge().dataset.level).toBe(level);
    expect(badge().textContent).toContain('p50');
    expect(badge().textContent).toContain('p95');
    if (level !== 'ok') expect(badge().textContent).toMatch(/elevada|crítica/);
  });
});
