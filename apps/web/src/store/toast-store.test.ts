import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toast, useToastStore } from './toast-store';

beforeEach(() => {
  vi.useFakeTimers();
  useToastStore.getState().clear();
});
afterEach(() => vi.useRealTimers());

describe('toast-store', () => {
  it('añade y expira solo', () => {
    toast.success('Hecho');
    expect(useToastStore.getState().toasts.map((t) => t.text)).toEqual(['Hecho']);
    vi.advanceTimersByTime(5100);
    expect(useToastStore.getState().toasts).toEqual([]);
  });
  it('los errores duran más y se limita el apilado', () => {
    toast.error('Mal');
    vi.advanceTimersByTime(7000);
    expect(useToastStore.getState().toasts).toHaveLength(1);
    for (let i = 0; i < 6; i++) toast.info(`n${i}`);
    expect(useToastStore.getState().toasts.length).toBeLessThanOrEqual(3);
  });
  it('dismiss manual', () => {
    const id = useToastStore.getState().push('x');
    useToastStore.getState().dismiss(id);
    expect(useToastStore.getState().toasts).toEqual([]);
  });
});
