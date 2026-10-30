import { Global, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerModule } from '@nestjs/throttler';
import { APP_CONFIG, AppConfig } from '../config/app-config';
import { AccessService } from './access.service';
import { AccountService } from './account.service';
import { AdminSeeder } from './admin-seeder';
import { AuthInvalidationBus, RedisInvalidationBus } from './auth-invalidation';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { DenialLogFilter } from './denial-log.filter';
import { JwtAuthGuard } from './jwt-auth.guard';
import { MeController } from './me.controller';
import { PgOrgsRepository, OrgsRepository } from '../orgs/orgs.repository';
import { PlantAccessGuard } from './plant-access.guard';
import { PgPlantCatalog, PlantCatalog } from './plant-catalog';
import { RolesGuard } from './roles.guard';
import { TenantScope } from './tenant-scope';
import { PgUsersRepository, UsersRepository } from './users.repository';

/** Global: PlantAccessGuard, TenantScope, AccessService y los repositorios de usuarios/clientes se usan desde otros módulos. */
@Global()
@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [APP_CONFIG],
      useFactory: (cfg: AppConfig) => ({
        secret: cfg.jwtSecret,
        signOptions: { algorithm: 'HS256', expiresIn: cfg.jwtExpiresIn as never },
      }),
    }),
    ThrottlerModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (cfg: AppConfig) => ({
        throttlers: [{ ttl: cfg.loginRateTtlMs, limit: cfg.loginRateLimit }],
      }),
    }),
  ],
  controllers: [AuthController, MeController],
  providers: [
    AuthService,
    AccessService,
    AccountService,
    AdminSeeder,
    PlantAccessGuard,
    TenantScope,
    { provide: OrgsRepository, useClass: PgOrgsRepository },
    { provide: UsersRepository, useClass: PgUsersRepository },
    { provide: AuthInvalidationBus, useClass: RedisInvalidationBus },
    { provide: PlantCatalog, useClass: PgPlantCatalog },
    // Orden importa: primero autenticación, luego roles.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_FILTER, useClass: DenialLogFilter },
  ],
  exports: [
    AuthService,
    AccessService,
    UsersRepository,
    OrgsRepository,
    PlantCatalog,
    PlantAccessGuard,
    TenantScope,
  ],
})
export class AuthModule {}
