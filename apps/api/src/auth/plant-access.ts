import { ForbiddenException } from '@nestjs/common';
import type { OrgSummary, Role } from '@campo/shared';
import type { AuthUser } from './auth.types';

/**
 * Reglas de acceso por cliente y planta (docs/architecture.md §11.1). Funciones puras: la ÚNICA definición
 * de quién puede ver qué. `TenantScope` las aplica a peticiones y los repositorios reciben un `PlantScope`.
 */

/** Marca de "todas las plantas (de su ámbito)" en `Me.plants` (admin y platform_admin). Nunca coincide con un id. */
export const ALL_PLANTS = '*';

/** Restricción de un listado: `undefined` = sin restricción en esa dimensión; `plants: []` = ninguna. */
export interface PlantScope {
  /** Sólo plantas de este cliente. */
  orgId?: string;
  /** Sólo estas plantas (asignadas). */
  plants?: string[];
}

export const isPlatform = (u: Pick<AuthUser, 'role'>): boolean => u.role === 'platform_admin';

/** Id del cliente del usuario (`null` = personal de plataforma). */
export const orgIdOf = (u: Pick<AuthUser, 'org'>): string | null => u.org?.id ?? null;

/** Proyecta un usuario de la base (y su cliente) al usuario de la petición. */
export function toAuthUser(
  u: { id: string; email: string; role: Role; plants: string[] },
  org: OrgSummary | null,
): AuthUser {
  const all = u.role === 'admin' || u.role === 'platform_admin';
  return {
    id: u.id,
    email: u.email,
    role: u.role,
    plants: all ? [ALL_PLANTS] : [...u.plants],
    org,
  };
}

/**
 * ¿Puede el usuario acceder a la planta cuyo cliente propietario es `plantOrg` (`null` = no registrada)?
 * - platform_admin: cualquiera (que exista lo decide quien llama);
 * - el resto: la planta debe estar registrada y ser de SU cliente; admin ve todas las de su cliente,
 *   engineer/operator/viewer sólo las asignadas.
 * Un usuario no platform sin cliente (estado imposible en la base) no accede a nada.
 */
export function plantAllowed(user: AuthUser, plant: string, plantOrg: string | null): boolean {
  if (isPlatform(user)) return true;
  const own = orgIdOf(user);
  if (own === null || plantOrg === null || own !== plantOrg) return false;
  return user.role === 'admin' || user.plants.includes(plant);
}

/** Filtro de listados (plantas, reglas, alarmas): lo que el usuario puede ver. */
export function scopeOf(user: AuthUser): PlantScope {
  if (isPlatform(user)) return {};
  const own = orgIdOf(user);
  if (own === null) return { plants: [] };
  return user.role === 'admin' ? { orgId: own } : { orgId: own, plants: user.plants };
}

/** 403 con mensaje genérico: no revela si la planta existe ni de quién es. Lleva la planta para el log. */
export class PlantAccessDenied extends ForbiddenException {
  constructor(readonly plant: string) {
    super('No tiene acceso a esta planta');
  }
}
