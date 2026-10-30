import { MODULES, type ModuleDef, type ModuleId, type OrgSummary, type Role } from '@campo/shared';

/**
 * Qué módulos ve un usuario (docs/architecture.md §11.4).
 * - Un usuario de cliente ve los módulos de su cliente.
 * - El personal de plataforma (`org: null`, `platform_admin`) ve los de la planta elegida: los del cliente dueño de la
 *   planta si se conocen y, si no, todos.
 * - Cualquier otro caso (sin cliente) no ve ninguno.
 */
export function activeModuleIds(
  org: OrgSummary | null | undefined,
  role: Role | null | undefined,
  plantOrgId?: string | null,
  orgs: readonly OrgSummary[] = [],
): ModuleId[] {
  if (org) return [...org.modules];
  if (role !== 'platform_admin') return [];
  const owner = plantOrgId ? orgs.find((o) => o.id === plantOrgId) : undefined;
  return owner ? [...owner.modules] : MODULES.map((m) => m.id);
}

/** Definiciones de los módulos activos, en el orden del registro. */
export function activeModules(ids: readonly ModuleId[]): ModuleDef[] {
  return MODULES.filter((m) => ids.includes(m.id));
}

export const moduleHref = (id: ModuleId): string => `/m/${id}`;

export const isModuleId = (v: string): v is ModuleId => MODULES.some((m) => m.id === v);

/** Primera pantalla a la que lleva `/`: el primer módulo activo, o `null` si no hay ninguno. */
export function landingHref(ids: readonly ModuleId[]): string | null {
  const first = activeModules(ids)[0];
  return first ? moduleHref(first.id) : null;
}

/** Con un solo módulo no se muestra la barra lateral de secciones. */
export const showSectionNav = (ids: readonly ModuleId[]): boolean => ids.length > 1;

export const MOBILE_BAR_MAX = 4;

export interface MobileNav {
  /** destinos directos de la barra inferior (módulos) */
  bar: ModuleDef[];
  /** módulos que quedan tras «Más» (vacío si todo cabe) */
  more: ModuleDef[];
}

/**
 * Barra inferior móvil: como máximo 4 destinos. Si hay más de 4 módulos, se muestran 3 y el resto va a «Más»
 * (que además lleva Alarmas, Modo pared y Mi cuenta). Con un solo módulo no hay barra.
 */
export function mobileNav(ids: readonly ModuleId[]): MobileNav {
  const mods = activeModules(ids);
  if (mods.length < 2) return { bar: [], more: [] };
  if (mods.length <= MOBILE_BAR_MAX) return { bar: mods, more: [] };
  return { bar: mods.slice(0, MOBILE_BAR_MAX - 1), more: mods.slice(MOBILE_BAR_MAX - 1) };
}

/** ¿Puede el rol ver/usar los enlaces de administración? */
export const showAdminLink = (role: Role | null | undefined): boolean =>
  role === 'admin' || role === 'engineer' || role === 'platform_admin';

/** Roles que pueden reconocer alarmas (la API es la autoridad). */
export const canAckAlarms = (role: Role | null | undefined): boolean =>
  role === 'admin' || role === 'engineer' || role === 'operator' || role === 'platform_admin';

/** La pestaña «Reglas» enlaza a la administración de reglas. */
export const canManageRules = showAdminLink;

export const rulesHref = (plant: string, module: ModuleId): string =>
  `/admin/rules?plant=${encodeURIComponent(plant)}&module=${encodeURIComponent(module)}`;
