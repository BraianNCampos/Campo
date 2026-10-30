import { Body, Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import type { Me } from '@campo/shared';
import { AccountService } from './account.service';
import type { AuthUser } from './auth.types';
import { CurrentUser } from './decorators';
import { ChangePasswordDto } from './dto';
import { UserThrottlerGuard } from './user-throttler.guard';

@Controller('me')
export class MeController {
  constructor(private readonly account: AccountService) {}

  /** Usuario vigente (rol, cliente y plantas de la base). `plants` = ["*"] para admin y platform_admin. */
  @Get()
  me(@CurrentUser() user: AuthUser): Me {
    return { id: user.id, email: user.email, role: user.role, plants: user.plants, org: user.org };
  }

  /** Cambia la contraseña propia y devuelve un token nuevo (los anteriores quedan revocados). Con rate limit. */
  @UseGuards(UserThrottlerGuard)
  @Post('password')
  @HttpCode(200)
  changePassword(
    @CurrentUser() user: AuthUser,
    @Body() dto: ChangePasswordDto,
  ): Promise<{ accessToken: string }> {
    return this.account.changePassword(user, dto);
  }
}
