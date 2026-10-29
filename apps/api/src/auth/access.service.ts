import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Observable, Subject } from 'rxjs';
import { APP_CONFIG, AppConfig } from '../config/app-config';
import { AuthInvalidationBus } from './auth-invalidation';
import { AuthUser } from './auth.types';
import { toAuthUser } from './plant-access';
import { UsersRepository } from './users.repository';

interface Entry {
  user: AuthUser | null;
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

  /** `fresh` ignora la caché (y la refresca): lo usa la revalidación periódica de los WebSocket. */
  async getAccess(userId: string, opts: { fresh?: boolean } = {}): Promise<AuthUser | null> {
    const ttl = this.cfg.authCacheTtlMs;
    if (ttl > 0 && !opts.fresh) {
      const hit = this.cache.get(userId);
      if (hit && hit.expires > Date.now()) return hit.user;
    }
    const generation = this.generation;
    const found = await this.users.findById(userId);
    const user = found && found.active ? toAuthUser(found) : null;
    if (ttl > 0 && generation === this.generation) {
      if (this.cache.size >= MAX_ENTRIES) this.cache.clear();
      this.cache.set(userId, { user, expires: Date.now() + ttl });
    }
    return user;
  }

  /** Llamar tras modificar al usuario (rol, activo, contraseña, plantas). */
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
