'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import { getHistoryVersion, subscribeHistory } from '@/store/history';

const MOBILE_QUERY = '(max-width: 767px)';

function subscribeMq(cb: () => void) {
  const mq = window.matchMedia(MOBILE_QUERY);
  mq.addEventListener('change', cb);
  return () => mq.removeEventListener('change', cb);
}

/** undefined hasta montar en cliente (evita montar el Canvas por error en móvil). */
export function useIsMobile(): boolean | undefined {
  return useSyncExternalStore<boolean | undefined>(
    subscribeMq,
    () => window.matchMedia(MOBILE_QUERY).matches,
    () => undefined,
  );
}

function subscribeOnline(cb: () => void) {
  window.addEventListener('online', cb);
  window.addEventListener('offline', cb);
  return () => {
    window.removeEventListener('online', cb);
    window.removeEventListener('offline', cb);
  };
}

export function useOnline(): boolean {
  return useSyncExternalStore(
    subscribeOnline,
    () => navigator.onLine,
    () => true,
  );
}

/** Se actualiza ≤2 Hz cuando llegan datos nuevos al histórico. */
export function useHistoryVersion(): number {
  return useSyncExternalStore(subscribeHistory, getHistoryVersion, getHistoryVersion);
}

/** Reloj para textos relativos ("hace 5 s"). */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
}

/** Captura `beforeinstallprompt` para ofrecer un botón "Instalar". */
export function useInstallPrompt() {
  const [evt, setEvt] = useState<BeforeInstallPromptEvent | null>(null);
  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setEvt(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => setEvt(null);
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);
  return evt
    ? async () => {
        await evt.prompt();
        setEvt(null);
      }
    : null;
}
