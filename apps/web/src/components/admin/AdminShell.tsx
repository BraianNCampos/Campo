'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { canAccessSection, landingSection, sectionForPath, visibleSections, type SectionId } from '@/lib/admin/access';
import { useSessionStore } from '@/store/session-store';
import { Logo } from '../Brand';
import { IconAudit, IconBack, IconCritical, IconPlant, IconRules, IconUser, IconUsers } from '../icons';
import { SessionGate } from '../SessionGate';
import { btn, EmptyState } from './ui';
import { ToastRegion } from './ToastRegion';

const ICONS: Record<SectionId, typeof IconUsers> = {
  users: IconUsers,
  plants: IconPlant,
  rules: IconRules,
  audit: IconAudit,
  account: IconUser,
};

function AdminFrame({ children }: { children: ReactNode }) {
  const me = useSessionStore((s) => s.me);
  const pathname = usePathname();
  const sections = visibleSections(me?.role);
  const current = sectionForPath(pathname);

  return (
    <div className="flex h-dvh flex-col md:flex-row">
      {/* Móvil: barra superior compacta */}
      <header className="flex items-center justify-between gap-3 border-b border-line bg-surface px-4 pt-[max(0.5rem,env(safe-area-inset-top))] pb-2 md:hidden">
        <div className="flex items-center gap-3">
          <Logo />
          <p className="text-lg leading-tight font-bold">Administración</p>
        </div>
        <Link href="/" className={btn('secondary', 'px-3')}>
          <IconBack className="text-base" /> Panel
        </Link>
      </header>

      {/* Escritorio: barra lateral */}
      <aside className="hidden w-64 shrink-0 flex-col border-r border-line bg-surface md:flex">
        <div className="flex items-center gap-3 px-5 pt-5 pb-4">
          <Logo />
          <div className="leading-tight">
            <p className="text-lg font-bold">Campo</p>
            <p className="text-xs text-muted">Administración</p>
          </div>
        </div>
        <nav aria-label="Administración" className="flex flex-1 flex-col gap-1 px-3">
          {sections.map((s) => {
            const Icon = ICONS[s.id];
            const active = current === s.id;
            return (
              <Link
                key={s.id}
                href={s.href}
                aria-current={active ? 'page' : undefined}
                className={`flex min-h-11 items-center gap-3 rounded-lg px-3 text-sm font-semibold ${
                  active ? 'bg-accent/15 text-accent' : 'text-muted hover:bg-surface-2 hover:text-fg'
                }`}
              >
                <Icon className="text-xl" />
                {s.label}
              </Link>
            );
          })}
        </nav>
        <div className="flex flex-col gap-2 border-t border-line p-4">
          {me && (
            <p className="truncate text-xs text-muted" title={me.email}>
              {me.email}
              <span className="block font-semibold text-fg">{me.role}</span>
            </p>
          )}
          <Link href="/" className={btn('secondary')}>
            <IconBack className="text-base" /> Volver al panel
          </Link>
        </div>
      </aside>

      <main id="main" className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="mx-auto w-full max-w-6xl p-4 md:p-6">{children}</div>
      </main>

      {/* Móvil: pestañas inferiores */}
      <nav
        aria-label="Administración"
        style={{ gridTemplateColumns: `repeat(${Math.max(1, sections.length)}, minmax(0, 1fr))` }}
        className="grid border-t border-line bg-surface pb-[env(safe-area-inset-bottom)] md:hidden"
      >
        {sections.map((s) => {
          const Icon = ICONS[s.id];
          const active = current === s.id;
          return (
            <Link
              key={s.id}
              href={s.href}
              aria-current={active ? 'page' : undefined}
              className={`relative flex min-h-14 flex-col items-center justify-center gap-0.5 text-xs font-semibold ${active ? 'text-accent' : 'text-muted'}`}
            >
              {active && <span className="absolute top-0 h-0.5 w-10 rounded-full bg-accent" aria-hidden="true" />}
              <Icon className="text-2xl" />
              {s.short}
            </Link>
          );
        })}
      </nav>
      <ToastRegion />
    </div>
  );
}

export function AdminShell({ children }: { children: ReactNode }) {
  return (
    <SessionGate>
      <AdminFrame>{children}</AdminFrame>
    </SessionGate>
  );
}

/** Protege una sección en cliente según el rol (la API sigue siendo la autoridad: devolverá 403). */
export function RequireSection({ section, children }: { section: SectionId; children: ReactNode }) {
  const role = useSessionStore((s) => s.me?.role);
  if (canAccessSection(role, section)) return <>{children}</>;
  const landing = landingSection(role);
  return (
    <EmptyState
      icon={<IconCritical />}
      title="No tienes acceso a esta sección"
      action={landing && <Link href={landing.href} className={btn('primary')}>Ir a {landing.label}</Link>}
    >
      Tu rol ({role ?? 'desconocido'}) no permite gestionar esto. Si lo necesitas, pide a un administrador que cambie tu rol.
    </EmptyState>
  );
}

/** /admin → primera sección disponible para el rol. */
export function AdminHome() {
  const router = useRouter();
  const role = useSessionStore((s) => s.me?.role);
  useEffect(() => {
    const l = landingSection(role);
    if (l) router.replace(l.href);
  }, [role, router]);
  return null;
}
