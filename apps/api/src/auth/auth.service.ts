import { Inject, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomBytes } from 'node:crypto';
import * as bcrypt from 'bcryptjs';
import { APP_CONFIG, AppConfig } from '../config/app-config';
import type { LoginResponse } from '@campo/shared';
import { JwtPayload, ROLES, TokenClaims } from './auth.types';
import { toAuthUser } from './plant-access';
import { User, UsersRepository } from './users.repository';

@Injectable()
export class AuthService {
  private readonly log = new Logger(AuthService.name);
  private dummyHash?: string;

  constructor(
    private readonly users: UsersRepository,
    private readonly jwt: JwtService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  hashPassword(password: string): Promise<string> {
    return bcrypt.hash(password, this.cfg.bcryptRounds);
  }

  verifyPassword(password: string, hash: string): Promise<boolean> {
    return bcrypt.compare(password, hash);
  }

  async login(email: string, password: string): Promise<LoginResponse> {
    const user = await this.users.findByEmail(email.trim().toLowerCase());
    // Siempre se ejecuta un compare para que el tiempo no revele si el usuario existe.
    const hash = user?.passwordHash ?? (await this.getDummyHash());
    const ok = await bcrypt.compare(password, hash);
    if (!user || !ok || !user.active) {
      this.log.warn({ msg: 'login fallido', email: email.trim().toLowerCase() });
      throw new UnauthorizedException('Credenciales inválidas');
    }
    this.log.log({ msg: 'login ok', userId: user.id, role: user.role });
    return { accessToken: await this.signToken(user), user: toAuthUser(user) };
  }

  /** Emite un JWT con la versión de sesión ACTUAL del usuario (`tv`). */
  signToken(user: Pick<User, 'id' | 'email' | 'role' | 'tokenVersion'>): Promise<string> {
    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      role: user.role,
      tv: user.tokenVersion,
    };
    return this.jwt.signAsync(payload);
  }

  /**
   * Verifica la firma/expiración del JWT y devuelve sus afirmaciones, o null si es inválido.
   * No consulta la base: quien autoriza debe pasar por AccessService (rol/activo/plantas/`tv` vigentes).
   * Un token sin `tv` (anterior a la revocación) cuenta como versión 0; un `tv` que no es un entero >= 0 es inválido.
   */
  async verifyToken(token: string): Promise<TokenClaims | null> {
    try {
      const p = await this.jwt.verifyAsync<JwtPayload>(token, { algorithms: ['HS256'] });
      if (!p || typeof p.sub !== 'string' || !ROLES.includes(p.role)) return null;
      if (p.tv !== undefined && !(Number.isInteger(p.tv) && p.tv >= 0)) return null;
      return { id: p.sub, email: p.email, role: p.role, tv: p.tv ?? 0 };
    } catch {
      return null;
    }
  }

  private async getDummyHash(): Promise<string> {
    this.dummyHash ??= await bcrypt.hash(randomBytes(16).toString('hex'), this.cfg.bcryptRounds);
    return this.dummyHash;
  }
}
