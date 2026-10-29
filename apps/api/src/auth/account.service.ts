import { BadRequestException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { AccessService } from './access.service';
import { AuthService } from './auth.service';
import type { AuthUser } from './auth.types';
import { ChangePasswordDto } from './dto';
import { UsersRepository } from './users.repository';

/** Operaciones del propio usuario sobre su cuenta. */
@Injectable()
export class AccountService {
  private readonly log = new Logger(AccountService.name);

  constructor(
    private readonly users: UsersRepository,
    private readonly auth: AuthService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Cambia la contraseña propia. Sube `token_version`: todos los tokens y WebSockets anteriores dejan de
   * valer (también los de otros dispositivos) y se devuelve un token nuevo para no echar a quien la cambia.
   * Contraseña actual errónea -> 400 (no 401: la sesión sigue siendo válida).
   */
  async changePassword(actor: AuthUser, dto: ChangePasswordDto): Promise<{ accessToken: string }> {
    const user = await this.users.findById(actor.id);
    if (!user || !user.active) throw new UnauthorizedException('Sesión no válida');
    if (!(await this.auth.verifyPassword(dto.currentPassword, user.passwordHash))) {
      this.log.warn({ msg: 'cambio de contraseña: la actual no coincide', userId: user.id });
      throw new BadRequestException('La contraseña actual no es correcta');
    }
    if (dto.newPassword === dto.currentPassword) {
      throw new BadRequestException('La nueva contraseña debe ser distinta de la actual');
    }
    const res = await this.users.update(user.id, {
      passwordHash: await this.auth.hashPassword(dto.newPassword),
      revokeTokens: true,
    });
    if (res.status !== 'ok') throw new UnauthorizedException('Sesión no válida');
    await this.access.invalidate(user.id);
    this.log.log({ msg: 'contraseña cambiada', userId: user.id });
    await this.audit.record(actor, 'me.password', `user:${user.id}`);
    return { accessToken: await this.auth.signToken(res.user) };
  }
}
