import { create } from 'zustand';

interface ModelStatusState {
  /** activo → motivo por el que su modelo 3D no se pudo cargar (el 3D usa el procedural) */
  failed: Record<string, string>;
  setFailed(asset: string, reason: string | null): void;
  clear(): void;
}

/** Sin dependencias de three: lo lee el panel de detalle (DOM) sin arrastrar el bundle 3D. */
export const useModelStatus = create<ModelStatusState>()((set, get) => ({
  failed: {},
  setFailed(asset, reason) {
    const cur = get().failed;
    if (reason === null) {
      if (!(asset in cur)) return;
      const { [asset]: _gone, ...rest } = cur;
      void _gone;
      set({ failed: rest });
    } else if (cur[asset] !== reason) {
      set({ failed: { ...cur, [asset]: reason } });
    }
  },
  clear() {
    if (Object.keys(get().failed).length > 0) set({ failed: {} });
  },
}));
