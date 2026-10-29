import type { Role } from '@campo/shared';

export type SectionId = 'users' | 'plants' | 'rules' | 'audit' | 'account';

export interface Section {
  id: SectionId;
  href: string;
  label: string;
  /** Etiqueta corta para la barra móvil */
  short: string;
  roles: readonly Role[];
}

const ALL: readonly Role[] = ['admin', 'engineer', 'operator', 'viewer'];

/** Secciones de /admin y quién puede verlas (docs/architecture.md §9.2). La API es la autoridad final. */
export const SECTIONS: readonly Section[] = [
  { id: 'users', href: '/admin/users', label: 'Usuarios', short: 'Usuarios', roles: ['admin'] },
  { id: 'plants', href: '/admin/plants', label: 'Plantas y activos', short: 'Plantas', roles: ['admin', 'engineer'] },
  { id: 'rules', href: '/admin/rules', label: 'Reglas de alarma', short: 'Reglas', roles: ['admin', 'engineer'] },
  { id: 'audit', href: '/admin/audit', label: 'Auditoría', short: 'Auditoría', roles: ['admin'] },
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
  return role === 'admin' || role === 'engineer';
}

/** Primera sección a la que lleva /admin. */
export function landingSection(role: Role | null | undefined): Section | null {
  return visibleSections(role)[0] ?? null;
}

export function sectionForPath(pathname: string): SectionId | null {
  return SECTIONS.find((s) => pathname === s.href || pathname.startsWith(`${s.href}/`))?.id ?? null;
}

/** Sólo el admin crea/renombra/borra plantas; engineer gestiona activos de las suyas. */
export const canManagePlants = (role: Role | null | undefined) => role === 'admin';
