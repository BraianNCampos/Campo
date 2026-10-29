import { Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../config/app-config';
import { AuthService } from './auth.service';
import { UsersRepository } from './users.repository';

/** Crea el admin semilla (ADMIN_EMAIL / ADMIN_PASSWORD) si no existe. Nunca pisa uno existente. */
@Injectable()
export class AdminSeeder implements OnApplicationBootstrap {
  private readonly log = new Logger(AdminSeeder.name);

  constructor(
    private readonly users: UsersRepository,
    private readonly auth: AuthService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const { adminEmail, adminPassword } = this.cfg;
    if (!adminEmail || !adminPassword) return;
    try {
      if (await this.users.findByEmail(adminEmail)) return;
      const created = await this.users.create({
        email: adminEmail,
        passwordHash: await this.auth.hashPassword(adminPassword),
        role: 'admin',
      });
      if (created) this.log.log({ msg: 'admin semilla creado', email: adminEmail });
    } catch (err) {
      this.log.error({ msg: 'no se pudo crear el admin semilla', error: (err as Error).message });
    }
  }
}
