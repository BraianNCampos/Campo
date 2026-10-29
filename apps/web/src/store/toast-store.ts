import { create } from 'zustand';

export type ToastKind = 'success' | 'error' | 'info';
export interface Toast {
  id: number;
  kind: ToastKind;
  text: string;
}

interface ToastState {
  toasts: Toast[];
  push(text: string, kind?: ToastKind, ttlMs?: number): number;
  dismiss(id: number): void;
  clear(): void;
}

let nextId = 1;

/** Avisos no intrusivos (se anuncian con aria-live en <ToastRegion/>). */
export const useToastStore = create<ToastState>()((set, get) => ({
  toasts: [],
  push(text, kind = 'success', ttlMs = 6000) {
    const id = nextId++;
    set({ toasts: [...get().toasts.slice(-3), { id, kind, text }] });
    if (ttlMs > 0) setTimeout(() => get().dismiss(id), ttlMs);
    return id;
  },
  dismiss(id) {
    set({ toasts: get().toasts.filter((t) => t.id !== id) });
  },
  clear() {
    set({ toasts: [] });
  },
}));

export const toast = {
  success: (text: string) => useToastStore.getState().push(text, 'success'),
  error: (text: string) => useToastStore.getState().push(text, 'error', 10_000),
  info: (text: string) => useToastStore.getState().push(text, 'info'),
};
