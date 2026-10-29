import { create } from 'zustand';

export type MobileTab = 'summary' | 'alarms' | '3d';

interface UiState {
  selectedId: string | null;
  mobileTab: MobileTab;
  /** ventana de las curvas, en segundos */
  windowSec: number;
  select(id: string | null): void;
  setTab(tab: MobileTab): void;
  setWindowSec(s: number): void;
}

export const useUiStore = create<UiState>()((set) => ({
  selectedId: null,
  mobileTab: 'summary',
  windowSec: 120,
  select: (selectedId) => set({ selectedId }),
  setTab: (mobileTab) => set({ mobileTab }),
  setWindowSec: (windowSec) => set({ windowSec }),
}));
