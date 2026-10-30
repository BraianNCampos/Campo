import { Injectable, NotFoundException } from '@nestjs/common';
import type { AuthUser } from './auth.types';
import { PlantAccessDenied, PlantScope, isPlatform, plantAllowed, scopeOf } from './plant-access';
import { PlantCatalog } from './plant-catalog';

/**
 * Punto ÚNICO de decisión de acceso a plantas (y, por tanto, a todo lo que cuelga de una planta: activos,
 * modelos, reglas, alarmas, estado, histórico, límites). Combina las reglas puras de `plant-access.ts` con el
 * cliente propietario de la planta (`plants.org_id`), que se consulta SIEMPRE en la base y nunca se cachea:
 * una planta borrada y recreada por otro cliente no puede heredar accesos.
 */
@Injectable()
export class TenantScope {
  constructor(private readonly catalog: PlantCatalog) {}

  /**
   * Exige acceso a la planta y devuelve su cliente (`null` sólo para un platform_admin sobre una planta con
   * telemetría pero sin registrar). Sin acceso -> 403 genérico, exista o no la planta y sea de quien sea
   * (los ids de planta son adivinables: un 404 distinto revelaría que existe en otro cliente).
   * platform_admin sobre una planta inexistente -> 404.
   */
  async assertPlant(user: AuthUser, plant: string): Promise<string | null> {
    const org = await this.catalog.orgOf(plant);
    if (!plantAllowed(user, plant, org)) throw new PlantAccessDenied(plant);
    if (isPlatform(user) && org === null && !(await this.catalog.isLive(plant))) {
      throw new NotFoundException('Planta no encontrada');
    }
    return org;
  }

  /** Como `assertPlant` pero booleano (WebSocket). `orgs` memoriza consultas dentro de una pasada. */
  async canAccessPlant(
    user: AuthUser,
    plant: string,
    orgs?: Map<string, string | null>,
  ): Promise<boolean> {
    if (isPlatform(user)) return true;
    let org = orgs?.get(plant);
    if (org === undefined) {
      org = await this.catalog.orgOf(plant);
      orgs?.set(plant, org);
    }
    return plantAllowed(user, plant, org);
  }

  /** Restricción para listados de plantas/reglas/alarmas. */
  scope(user: AuthUser): PlantScope {
    return scopeOf(user);
  }

  /** Cliente propietario de una planta registrada (sin comprobar permisos). */
  orgOf(plant: string): Promise<string | null> {
    return this.catalog.orgOf(plant);
  }
}
