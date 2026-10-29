'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { canSeeAdminLink } from '@/lib/admin/access';
import { getToken } from '@/lib/auth';
import { config } from '@/lib/env';
import { signOut, useSessionStore } from '@/store/session-store';
import { IconLogout, IconSettings, IconUser } from './icons';

const itemCls = 'flex min-h-11 items-center gap-3 rounded-lg px-3 text-sm font-semibold hover:bg-surface-2';
const iconBtn = 'flex size-11 items-center justify-center rounded-lg border border-line text-xl hover:bg-surface-2';

function useLogout() {
  const router = useRouter();
  return () => {
    signOut();
    router.replace('/login');
  };
}

/** Escritorio (≥768px): enlaces visibles "Administración" (admin/engineer) y "Mi cuenta", y cerrar sesión. */
export function UserLinks() {
  const role = useSessionStore((s) => s.me?.role);
  const logout = useLogout();
  const showLogout = !config.mock && !!getToken();
  return (
    <nav aria-label="Cuenta" className="hidden items-center gap-2 md:flex">
      {canSeeAdminLink(role) && (
        <Link prefetch={false} href="/admin" className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-line px-3 text-sm font-semibold hover:bg-surface-2">
          <IconSettings className="text-base" /> Administración
        </Link>
      )}
      <Link prefetch={false} href="/admin/account" className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-line px-3 text-sm font-semibold hover:bg-surface-2">
        <IconUser className="text-base" /> Mi cuenta
      </Link>
      {showLogout && (
        <button type="button" aria-label="Cerrar sesión" onClick={logout} className={iconBtn}>
          <IconLogout />
        </button>
      )}
    </nav>
  );
}

/** Móvil (<768px): un solo botón con el menú de usuario (Administración, Mi cuenta, Cerrar sesión). */
export function UserMenu() {
  const me = useSessionStore((s) => s.me);
  const logout = useLogout();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const showLogout = !config.mock && !!getToken();

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
        <div id="user-menu" className="absolute top-full right-0 z-40 mt-2 w-64 rounded-xl border border-line bg-surface p-2 shadow-2xl">
          {me && (
            <p className="truncate px-3 py-2 text-xs text-muted">
              {me.email} · {me.role}
            </p>
          )}
          {canSeeAdminLink(me?.role) && (
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
