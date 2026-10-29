import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerModule } from '@nestjs/throttler';
import { APP_CONFIG, AppConfig } from '../config/app-config';
import { AdminSeeder } from './admin-seeder';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { RolesGuard } from './roles.guard';
import { PgUsersRepository, UsersRepository } from './users.repository';

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
  controllers: [AuthController],
  providers: [
    AuthService,
    AdminSeeder,
    { provide: UsersRepository, useClass: PgUsersRepository },
    // Orden importa: primero autenticación, luego roles.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
  exports: [AuthService],
})
export class AuthModule {}
