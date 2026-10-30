'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ModuleId } from '@campo/shared';
import { mobileNav, moduleHref, showAdminLink } from '@/lib/modules/nav';
import { useSessionStore } from '@/store/session-store';
import { IconBell, IconMonitor, IconMore, IconSettings, IconUser } from '../icons';
import { useModuleBadges } from '../modules/derived';
import { MODULE_ICON, MODULE_SHORT } from '../modules/module-meta';
import { NavBadge } from './NavBadge';

const tab = (active: boolean) =>
  `relative flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 px-1 text-[11px] font-semibold ${active ? 'text-fg' : 'text-muted'}`;

/** Barra inferior móvil: hasta 4 destinos; si hay más de 4 módulos, 3 + «Más» (resto de módulos, Alarmas, Modo pared, Mi cuenta). */
export function BottomBar({ moduleIds }: { moduleIds: readonly ModuleId[] }) {
  const pathname = usePathname();
  const nav = mobileNav(moduleIds);
  const badges = useModuleBadges(moduleIds);
  const role = useSessionStore((s) => s.me?.role);
  const [more, setMore] = useState(false);
  if (nav.bar.length === 0) return null;
  const moreActive = nav.more.some((m) => pathname === moduleHref(m.id)) || pathname === '/alarmas';

  return (
    <>
      {more && (
        <div className="fixed inset-0 z-30" onClick={() => setMore(false)} aria-hidden="true" />
      )}
      {more && (
        <div id="more-sheet" role="menu" aria-label="Más secciones" data-testid="more-sheet" className="absolute inset-x-2 bottom-[calc(3.5rem+env(safe-area-inset-bottom)+0.5rem)] z-40 rounded-xl border border-line bg-surface p-2 shadow-2xl">
          {nav.more.map((m) => {
            const Icon = MODULE_ICON[m.id];
            return (
              <Link key={m.id} prefetch={false} role="menuitem" href={moduleHref(m.id)} onClick={() => setMore(false)} data-testid={`module-nav-${m.id}`} className="flex min-h-11 items-center gap-3 rounded-lg px-3 text-sm font-semibold hover:bg-surface-2">
                <Icon className="text-xl" /> <span className="flex-1">{m.label}</span> <NavBadge badge={badges[m.id]} />
              </Link>
            );
          })}
          <Link prefetch={false} role="menuitem" href="/alarmas" onClick={() => setMore(false)} className="flex min-h-11 items-center gap-3 rounded-lg px-3 text-sm font-semibold hover:bg-surface-2">
            <IconBell className="text-xl" /> Alarmas
          </Link>
          <Link prefetch={false} role="menuitem" href="/pared" onClick={() => setMore(false)} className="flex min-h-11 items-center gap-3 rounded-lg px-3 text-sm font-semibold hover:bg-surface-2">
            <IconMonitor className="text-xl" /> Modo pared
          </Link>
          {showAdminLink(role) && (
            <Link prefetch={false} role="menuitem" href="/admin" onClick={() => setMore(false)} className="flex min-h-11 items-center gap-3 rounded-lg px-3 text-sm font-semibold hover:bg-surface-2">
              <IconSettings className="text-xl" /> Administración
            </Link>
          )}
          <Link prefetch={false} role="menuitem" href="/admin/account" onClick={() => setMore(false)} className="flex min-h-11 items-center gap-3 rounded-lg px-3 text-sm font-semibold hover:bg-surface-2">
            <IconUser className="text-xl" /> Mi cuenta
          </Link>
        </div>
      )}
      <nav aria-label="Módulos" data-testid="bottom-bar" className="relative z-40 flex border-t border-line bg-surface pb-[env(safe-area-inset-bottom)]">
        {nav.bar.map((m) => {
          const Icon = MODULE_ICON[m.id];
          const active = pathname === moduleHref(m.id);
          const b = badges[m.id];
          return (
            <Link key={m.id} prefetch={false} href={moduleHref(m.id)} data-testid={`module-nav-${m.id}`} aria-current={active ? 'page' : undefined} onClick={() => setMore(false)} className={tab(active)}>
              {active && <span aria-hidden="true" className="absolute top-0 h-0.5 w-10 rounded-full bg-accent" />}
              <span className="relative">
                <Icon className="text-2xl" />
                {b && b.attention > 0 && <span aria-hidden="true" className={`absolute -top-0.5 -right-1.5 size-2.5 rounded-full ring-2 ring-surface ${b.critical ? 'bg-crit' : 'bg-warn'}`} />}
              </span>
              {MODULE_SHORT[m.id]}
            </Link>
          );
        })}
        {nav.more.length > 0 && (
          <button type="button" aria-expanded={more} aria-controls="more-sheet" data-testid="nav-more" onClick={() => setMore((o) => !o)} className={tab(moreActive || more)}>
            <IconMore className="text-2xl" />
            Más
          </button>
        )}
      </nav>
    </>
  );
}
