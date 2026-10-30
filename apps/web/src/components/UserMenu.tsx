'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { showAdminLink } from '@/lib/modules/nav';
import { getToken } from '@/lib/auth';
import { config } from '@/lib/env';
import { signOut, useSessionStore } from '@/store/session-store';
import { IconLogout, IconMonitor, IconSettings, IconUser } from './icons';
import { ViewAsSelect } from './ViewAsSelect';

const itemCls = 'flex min-h-11 items-center gap-3 rounded-lg px-3 text-sm font-semibold hover:bg-surface-2';
const linkCls = 'inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-line px-3 text-sm font-semibold hover:bg-surface-2';
const iconBtn = 'flex size-11 items-center justify-center rounded-lg border border-line text-xl hover:bg-surface-2';

export function useLogout() {
  const router = useRouter();
  return () => {
    signOut();
    router.replace('/login');
  };
}

export const canLogout = () => !config.mock && !!getToken();

/** Escritorio: enlaces visibles «Modo pared», «Administración» y «Mi cuenta», «Ver como» (demo) y cerrar sesión. */
export function UserLinks() {
  const role = useSessionStore((s) => s.me?.role);
  const logout = useLogout();
  return (
    <nav aria-label="Cuenta" className="hidden items-center gap-2 md:flex">
      {config.mock && <ViewAsSelect className="w-52 [&>span]:sr-only" />}
      <Link prefetch={false} href="/pared" className={linkCls}>
        <IconMonitor className="text-base" /> Modo pared
      </Link>
      {showAdminLink(role) && (
        <Link prefetch={false} href="/admin" className={linkCls}>
          <IconSettings className="text-base" /> Administración
        </Link>
      )}
      <Link prefetch={false} href="/admin/account" className={linkCls}>
        <IconUser className="text-base" /> Mi cuenta
      </Link>
      {canLogout() && (
        <button type="button" aria-label="Cerrar sesión" onClick={logout} className={iconBtn}>
          <IconLogout />
        </button>
      )}
    </nav>
  );
}

/** Móvil (<768px): un solo botón con el menú de usuario. */
export function UserMenu() {
  const me = useSessionStore((s) => s.me);
  const logout = useLogout();
  const showLogout = canLogout();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        root.current?.querySelector('button')?.focus();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={root} className="relative md:hidden">
      <button
        type="button"
        aria-label="Menú de usuario"
        aria-expanded={open}
        aria-controls="user-menu"
        data-testid="user-menu-button"
        onClick={() => setOpen((o) => !o)}
        className={iconBtn}
      >
        <IconUser />
      </button>
      {open && (
        <div id="user-menu" className="absolute top-full right-0 z-40 mt-2 w-72 rounded-xl border border-line bg-surface p-2 shadow-2xl">
          {me && (
            <p className="truncate px-3 py-2 text-xs text-muted">
              {me.email} · {me.role}
              {me.org && <span className="block font-semibold text-fg">{me.org.name}</span>}
            </p>
          )}
          {config.mock && <ViewAsSelect className="px-2 pb-2" />}
          <Link prefetch={false} href="/pared" className={itemCls} onClick={() => setOpen(false)}>
            <IconMonitor className="text-xl" /> Modo pared
          </Link>
          {showAdminLink(me?.role) && (
            <Link prefetch={false} href="/admin" className={itemCls} onClick={() => setOpen(false)}>
              <IconSettings className="text-xl" /> Administración
            </Link>
          )}
          <Link prefetch={false} href="/admin/account" className={itemCls} onClick={() => setOpen(false)}>
            <IconUser className="text-xl" /> Mi cuenta
          </Link>
          {showLogout && (
            <button type="button" onClick={logout} className={`${itemCls} w-full text-left`}>
              <IconLogout className="text-xl" /> Cerrar sesión
            </button>
          )}
        </div>
      )}
    </div>
  );
}
