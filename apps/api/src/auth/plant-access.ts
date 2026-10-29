import { ForbiddenException } from '@nestjs/common';
import type { Role } from '@campo/shared';
import type { AuthUser } from './auth.types';

/** Marca de "todas las plantas" en `plants` (sólo admin). Nunca coincide con un id de planta. */
export const ALL_PLANTS = '*';

/** Proyecta un usuario de la base al usuario de la petición (`plants` = ["*"] para admin). */
export function toAuthUser(u: {
  id: string;
  email: string;
  role: Role;
  plants: string[];
}): AuthUser {
  return {
    id: u.id,
    email: u.email,
    role: u.role,
    plants: u.role === 'admin' ? [ALL_PLANTS] : [...u.plants],
  };
}

/** admin: todas; el resto: sólo las asignadas (sin asignaciones = sin acceso). */
export function canAccessPlant(user: Pick<AuthUser, 'role' | 'plants'>, plant: string): boolean {
  return user.role === 'admin' || user.plants.includes(plant);
}

/**
 * Plantas por las que filtrar listados: `undefined` = sin filtro (admin), si no la lista asignada.
 */
export function plantFilter(user: Pick<AuthUser, 'role' | 'plants'>): string[] | undefined {
  return user.role === 'admin' ? undefined : user.plants;
}

/** 403 con mensaje genérico: no revela si la planta existe. Lleva la planta para el log de denegaciones. */
export class PlantAccessDenied extends ForbiddenException {
  constructor(readonly plant: string) {
    super('No tiene acceso a esta planta');
  }
}

export function assertPlantAccess(user: AuthUser, plant: string): void {
  if (!canAccessPlant(user, plant)) throw new PlantAccessDenied(plant);
}
