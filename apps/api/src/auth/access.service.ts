import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Observable, Subject } from 'rxjs';
import { APP_CONFIG, AppConfig } from '../config/app-config';
import { AuthInvalidationBus } from './auth-invalidation';
import { AuthUser } from './auth.types';
import { OrgsRepository, toSummary } from '../orgs/orgs.repository';
import { toAuthUser } from './plant-access';
import { User, UsersRepository } from './users.repository';

interface Entry {
  user: AuthUser | null;
  tokenVersion: number;
  /** Cliente del usuario (para invalidar por cliente). */
  orgId: string | null;
  expires: number;
}

/** Prefijo del payload del bus cuando lo invalidado es un cliente entero (y no un usuario). */
const ORG_PREFIX = 'org:';

const MAX_ENTRIES = 5000;

/**
 * Directorio de acceso: dado el id del token devuelve el usuario ACTUAL (rol, cliente, plantas) de la base,
 * con caché en memoria de `AUTH_CACHE_TTL_MS` (30 s; 0 = sin caché). `null` = no existe, está inactivo o su
 * cliente está desactivado (o ya no existe).
 *
 * Invalidación: `invalidate(id)` (usuario) e `invalidateOrg(id)` (cambio de `active`/`modules`/nombre del
 * cliente) limpian al instante la caché de este proceso y avisan a las demás réplicas por el
 * AuthInvalidationBus. Otras réplicas, si el aviso se pierde, convergen por TTL.
 */
@Injectable()
export class AccessService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(AccessService.name);
  private readonly cache = new Map<string, Entry>();
  /** Se incrementa en cada invalidación: una carga iniciada antes no puede dejar datos viejos en la caché. */
  private generation = 0;
  private readonly changed = new Subject<string>();
  private unsubscribe?: () => void;

  /** Emite el id de cada usuario invalidado (local o remoto); el gateway WS revalida sus sockets. */
  readonly invalidations$: Observable<string> = this.changed.asObservable();
  private readonly orgChanged = new Subject<string>();
  /** Emite el id de cada cliente invalidado; el gateway WS revalida todos sus sockets. */
  readonly orgInvalidations$: Observable<string> = this.orgChanged.asObservable();

  constructor(
    private readonly users: UsersRepository,
    private readonly orgs: OrgsRepository,
    private readonly bus: AuthInvalidationBus,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  onModuleInit(): void {
    this.unsubscribe = this.bus.subscribe((id) =>
      id.startsWith(ORG_PREFIX) ? this.dropOrg(id.slice(ORG_PREFIX.length)) : this.drop(id),
    );
  }

  onModuleDestroy(): void {
    this.unsubscribe?.();
    this.changed.complete();
    this.orgChanged.complete();
  }

  /**
   * Usuario de la petición a partir del registro de la base, o null si no puede operar: inactivo, o su
   * cliente está desactivado / no existe. Única definición de "sesión válida" (login, REST y WebSocket).
   */
  async project(user: User): Promise<AuthUser | null> {
    if (!user.active) return null;
    if (user.orgId === null) {
      // Sólo platform_admin puede no tener cliente; cualquier otro rol sin cliente es un estado inválido.
      return user.role === 'platform_admin' ? toAuthUser(user, null) : null;
    }
    if (user.role === 'platform_admin') return null; // inválido: el personal de plataforma no tiene cliente
    const org = await this.orgs.findById(user.orgId);
    return org && org.active ? toAuthUser(user, toSummary(org)) : null;
  }

  /**
   * `fresh` ignora la caché (y la refresca): lo usa la revalidación periódica de los WebSocket.
   * `tv` es la versión de sesión del token: si se indica y no coincide con la vigente (contraseña
   * cambiada, usuario desactivado, revocación) devuelve null, igual que un usuario inactivo.
   */
  async getAccess(
    userId: string,
    opts: { fresh?: boolean; tv?: number } = {},
  ): Promise<AuthUser | null> {
    const entry = await this.load(userId, opts.fresh === true);
    if (opts.tv !== undefined && opts.tv !== entry.tokenVersion) return null;
    return entry.user;
  }

  private async load(userId: string, fresh: boolean): Promise<Entry> {
    const ttl = this.cfg.authCacheTtlMs;
    if (ttl > 0 && !fresh) {
      const hit = this.cache.get(userId);
      if (hit && hit.expires > Date.now()) return hit;
    }
    const generation = this.generation;
    const found = await this.users.findById(userId);
    const entry: Entry = {
      user: found ? await this.project(found) : null,
      tokenVersion: found?.tokenVersion ?? 0,
      orgId: found?.orgId ?? null,
      expires: Date.now() + ttl,
    };
    if (ttl > 0 && generation === this.generation) {
      if (this.cache.size >= MAX_ENTRIES) this.cache.clear();
      this.cache.set(userId, entry);
    }
    return entry;
  }

  /** Llamar tras modificar al usuario (rol, activo, contraseña, plantas, revocación). */
  async invalidate(userId: string): Promise<void> {
    this.drop(userId);
    try {
      await this.bus.publish(userId);
    } catch (err) {
      this.log.warn({ msg: 'invalidación remota fallida', error: (err as Error).message });
    }
  }

  /** Llamar tras cambiar `active`, `modules` o el nombre de un cliente: todos sus usuarios se releen. */
  async invalidateOrg(orgId: string): Promise<void> {
    this.dropOrg(orgId);
    try {
      await this.bus.publish(ORG_PREFIX + orgId);
    } catch (err) {
      this.log.warn({ msg: 'invalidación remota fallida', error: (err as Error).message });
    }
  }

  private dropOrg(orgId: string): void {
    this.generation++;
    for (const [id, e] of this.cache) if (e.orgId === orgId) this.cache.delete(id);
    this.orgChanged.next(orgId);
  }

  private drop(userId: string): void {
    this.generation++;
    this.cache.delete(userId);
    this.changed.next(userId);
  }
}
