'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ModuleId } from '@campo/shared';
import { activeModules, moduleHref, showAdminLink } from '@/lib/modules/nav';
import { useLiveStore } from '@/store/live-store';
import { signOut, useSessionStore } from '@/store/session-store';
import { useRouter } from 'next/navigation';
import { Wordmark } from '../Brand';
import { IconBell, IconLogout, IconMonitor, IconSettings, IconUser } from '../icons';
import { useModuleBadges } from '../modules/derived';
import { MODULE_ICON } from '../modules/module-meta';
import { canLogout } from '../UserMenu';
import { ViewAsSelect } from '../ViewAsSelect';
import { NavBadge } from './NavBadge';

const item = (active: boolean) =>
  `flex min-h-11 items-center gap-3 rounded-lg px-3 text-sm font-semibold ${active ? 'bg-surface-2 text-fg' : 'text-muted hover:bg-surface-2 hover:text-fg'}`;

/** Barra lateral de escritorio con una entrada por módulo activo; sólo existe con 2 o más módulos. */
export function Sidebar({ moduleIds }: { moduleIds: readonly ModuleId[] }) {
  const pathname = usePathname();
  const router = useRouter();
  const mods = activeModules(moduleIds);
  const badges = useModuleBadges(moduleIds);
  const me = useSessionStore((s) => s.me);
  const alarmCount = useLiveStore((s) => Object.keys(s.alarms).length);
  const critical = useLiveStore((s) => Object.values(s.alarms).some((a) => a.severity === 'critical'));
  const orgName = me?.org ? me.org.name : 'Campos Ingeniería';

  return (
    <aside aria-label="Secciones" data-testid="sidebar" className="flex w-60 shrink-0 flex-col border-r border-line bg-surface">
      <div className="px-5 pt-5 pb-4">
        <p className="m-0"><Wordmark className="text-3xl" /></p>
        <p className="mt-1.5 truncate text-xs text-muted" title={orgName}>{orgName}</p>
      </div>
      <nav aria-label="Módulos" className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-3">
        <p className="px-3 pt-1 pb-1.5 text-[11px] font-semibold tracking-[0.14em] text-muted uppercase">Módulos</p>
        {mods.map((m) => {
          const Icon = MODULE_ICON[m.id];
          const active = pathname === moduleHref(m.id);
          return (
            <Link key={m.id} prefetch={false} href={moduleHref(m.id)} data-testid={`module-nav-${m.id}`} aria-current={active ? 'page' : undefined} className={`${item(active)} relative`}>
              {active && <span aria-hidden="true" className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-accent" />}
              <Icon className="shrink-0 text-xl" />
              <span className="min-w-0 flex-1 truncate">{m.label}</span>
              <NavBadge badge={badges[m.id]} testId={`module-badge-${m.id}`} />
            </Link>
          );
        })}
        <p className="px-3 pt-4 pb-1.5 text-[11px] font-semibold tracking-[0.14em] text-muted uppercase">General</p>
        <Link prefetch={false} href="/alarmas" data-testid="nav-alarms" aria-current={pathname === '/alarmas' ? 'page' : undefined} className={item(pathname === '/alarmas')}>
          <IconBell className="shrink-0 text-xl" />
          <span className="flex-1">Alarmas</span>
          {alarmCount > 0 && (
            <span className={`min-w-5 rounded-full px-1.5 text-center font-mono text-[11px] leading-5 font-bold ${critical ? 'bg-crit text-bg' : 'bg-warn text-bg'}`}>{alarmCount}</span>
          )}
        </Link>
        <Link prefetch={false} href="/pared" data-testid="nav-wall" className={item(false)}>
          <IconMonitor className="shrink-0 text-xl" />
          <span className="flex-1">Modo pared</span>
        </Link>
      </nav>
      <div className="flex flex-col gap-0.5 border-t border-line p-3">
        <ViewAsSelect className="mb-2" />
        {showAdminLink(me?.role) && (
          <Link prefetch={false} href="/admin" className={item(false)}>
            <IconSettings className="shrink-0 text-xl" /> Administración
          </Link>
        )}
        <Link prefetch={false} href="/admin/account" className={item(false)}>
          <IconUser className="shrink-0 text-xl" /> Mi cuenta
        </Link>
        {me && (
          <p className="truncate px-3 pt-1 text-xs text-muted" title={me.email}>
            {me.email}
            <span className="block font-semibold text-fg">{me.role}</span>
          </p>
        )}
        {canLogout() && (
          <button
            type="button"
            onClick={() => {
              signOut();
              router.replace('/login');
            }}
            className={`${item(false)} w-full text-left`}
          >
            <IconLogout className="shrink-0 text-xl" /> Cerrar sesión
          </button>
        )}
      </div>
    </aside>
  );
}
