import type { Role } from '@campo/shared';

export type SectionId = 'orgs' | 'users' | 'plants' | 'rules' | 'audit' | 'account';

export interface Section {
  id: SectionId;
  href: string;
  label: string;
  /** Etiqueta corta para la barra móvil */
  short: string;
  roles: readonly Role[];
}

const ALL: readonly Role[] = ['platform_admin', 'admin', 'engineer', 'operator', 'viewer'];

/** Secciones de /admin y quién puede verlas (docs/architecture.md §9.2 y §11). `platform_admin` hereda todo y además ve Clientes. La API es la autoridad final. */
export const SECTIONS: readonly Section[] = [
  { id: 'orgs', href: '/admin/orgs', label: 'Clientes', short: 'Clientes', roles: ['platform_admin'] },
  { id: 'users', href: '/admin/users', label: 'Usuarios', short: 'Usuarios', roles: ['platform_admin', 'admin'] },
  { id: 'plants', href: '/admin/plants', label: 'Plantas y activos', short: 'Plantas', roles: ['platform_admin', 'admin', 'engineer'] },
  { id: 'rules', href: '/admin/rules', label: 'Reglas de alarma', short: 'Reglas', roles: ['platform_admin', 'admin', 'engineer'] },
  { id: 'audit', href: '/admin/audit', label: 'Auditoría', short: 'Auditoría', roles: ['platform_admin', 'admin'] },
  { id: 'account', href: '/admin/account', label: 'Mi cuenta', short: 'Cuenta', roles: ALL },
];

export function canAccessSection(role: Role | null | undefined, id: SectionId): boolean {
  if (!role) return false;
  return SECTIONS.find((s) => s.id === id)?.roles.includes(role) ?? false;
}

export function visibleSections(role: Role | null | undefined): Section[] {
  return SECTIONS.filter((s) => canAccessSection(role, s.id));
}

/** ¿Muestra el enlace "Administración" en la cabecera? (Mi cuenta es para todos.) */
export function canSeeAdminLink(role: Role | null | undefined): boolean {
  return role === 'platform_admin' || role === 'admin' || role === 'engineer';
}

/** Primera sección a la que lleva /admin. */
export function landingSection(role: Role | null | undefined): Section | null {
  return visibleSections(role)[0] ?? null;
}

export function sectionForPath(pathname: string): SectionId | null {
  return SECTIONS.find((s) => pathname === s.href || pathname.startsWith(`${s.href}/`))?.id ?? null;
}

/** Sólo el admin (de cliente o de plataforma) crea/renombra/borra plantas; engineer gestiona activos de las suyas. */
export const canManagePlants = (role: Role | null | undefined) => role === 'admin' || role === 'platform_admin';

/** Personal de Campos Ingeniería: gestiona clientes y ve todos. */
export const isPlatformAdmin = (role: Role | null | undefined) => role === 'platform_admin';

/** ¿Puede crear/editar activos y reglas? */
export const canEditCatalog = (role: Role | null | undefined) => role === 'platform_admin' || role === 'admin' || role === 'engineer';
