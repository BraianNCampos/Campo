import { Controller, Get } from '@nestjs/common';
import type { Me } from '@campo/shared';
import type { AuthUser } from './auth.types';
import { CurrentUser } from './decorators';

@Controller('me')
export class MeController {
  /** Usuario vigente (rol y plantas de la base). `plants` = ["*"] para admin. */
  @Get()
  me(@CurrentUser() user: AuthUser): Me {
    return { id: user.id, email: user.email, role: user.role, plants: user.plants };
  }
}
