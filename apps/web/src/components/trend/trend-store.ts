import { create } from 'zustand';

/** Qué tendencia está abierta (null = ninguna). La abre cualquier tarjeta de nivel 2. */
interface TrendState {
  open: { asset: string; metric: string } | null;
  show(asset: string, metric: string): void;
  setMetric(metric: string): void;
  close(): void;
}

export const useTrendStore = create<TrendState>()((set, get) => ({
  open: null,
  show: (asset, metric) => set({ open: { asset, metric } }),
  setMetric: (metric) => {
    const o = get().open;
    if (o && o.metric !== metric) set({ open: { ...o, metric } });
  },
  close: () => set({ open: null }),
}));
