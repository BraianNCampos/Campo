import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Observable, Subject } from 'rxjs';
import { APP_CONFIG, AppConfig } from '../config/app-config';
import { AuthInvalidationBus } from './auth-invalidation';
import { AuthUser } from './auth.types';
import { toAuthUser } from './plant-access';
import { UsersRepository } from './users.repository';

interface Entry {
  user: AuthUser | null;
  tokenVersion: number;
  expires: number;
}

const MAX_ENTRIES = 5000;

/**
 * Directorio de acceso: dado el id del token devuelve el usuario ACTUAL (rol, activo, plantas) de la base,
 * con caché en memoria de `AUTH_CACHE_TTL_MS` (30 s; 0 = sin caché). `null` = no existe o está inactivo.
 *
 * Invalidación: `invalidate(id)` limpia al instante la caché de este proceso y avisa a las demás réplicas
 * por el AuthInvalidationBus. Otras réplicas, si el aviso se pierde, convergen por TTL.
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

  constructor(
    private readonly users: UsersRepository,
    private readonly bus: AuthInvalidationBus,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  onModuleInit(): void {
    this.unsubscribe = this.bus.subscribe((id) => this.drop(id));
  }

  onModuleDestroy(): void {
    this.unsubscribe?.();
    this.changed.complete();
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
      user: found && found.active ? toAuthUser(found) : null,
      tokenVersion: found?.tokenVersion ?? 0,
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

  private drop(userId: string): void {
    this.generation++;
    this.cache.delete(userId);
    this.changed.next(userId);
  }
}
