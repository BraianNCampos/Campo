import { Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../config/app-config';
import { AccessService } from './access.service';
import { AuthService } from './auth.service';
import { UsersRepository } from './users.repository';

/**
 * Siembra el `platform_admin` (ADMIN_EMAIL / ADMIN_PASSWORD):
 * - no existe -> se crea sin cliente;
 * - existe con otro rol/cliente (p. ej. el admin de antes de la Fase 6) -> se PROMUEVE a platform_admin y se
 *   le quita el cliente (queda registrado en el log); no se toca su contraseña;
 * - ya es platform_admin -> no se hace nada. Nunca se degrada a un platform_admin existente.
 */
@Injectable()
export class AdminSeeder implements OnApplicationBootstrap {
  private readonly log = new Logger(AdminSeeder.name);

  constructor(
    private readonly users: UsersRepository,
    private readonly auth: AuthService,
    private readonly access: AccessService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const { adminEmail, adminPassword } = this.cfg;
    if (!adminEmail || !adminPassword) return;
    try {
      const existing = await this.users.findByEmail(adminEmail);
      if (!existing) {
        const created = await this.users.create({
          email: adminEmail,
          passwordHash: await this.auth.hashPassword(adminPassword),
          role: 'platform_admin',
          orgId: null,
        });
        if (created) this.log.log({ msg: 'platform_admin semilla creado', email: adminEmail });
        return;
      }
      if (existing.role === 'platform_admin') return;
      const promoted = await this.users.promoteToPlatformAdmin(existing.id);
      if (!promoted) return;
      await this.access.invalidate(existing.id);
      this.log.warn({
        msg: 'usuario semilla promovido a platform_admin (ya no pertenece a ningún cliente)',
        email: adminEmail,
        userId: existing.id,
        previousRole: existing.role,
        previousOrg: existing.orgId,
      });
      if (!existing.active) {
        this.log.warn({ msg: 'el platform_admin semilla está desactivado', email: adminEmail });
      }
      if (existing.orgId) await this.warnIfNoAdmin(existing.orgId);
    } catch (err) {
      this.log.error({ msg: 'no se pudo sembrar el platform_admin', error: (err as Error).message });
    }
  }

  /** Tras la promoción su cliente puede quedar sin administrador: se avisa (POST /api/orgs/:id/admins lo arregla). */
  private async warnIfNoAdmin(orgId: string): Promise<void> {
    const users = await this.users.list({ orgId });
    if (!users.some((u) => u.role === 'admin' && u.active)) {
      this.log.warn({ msg: 'el cliente quedó sin administrador activo', orgId });
    }
  }
}
