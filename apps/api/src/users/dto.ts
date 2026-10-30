import { ID_PATTERN } from '@campo/shared';
import type { Role } from '@campo/shared';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsOptional,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';
import { ROLES } from '../auth/auth.types';
import { PasswordRules } from '../common/password-rules';

const lowerTrim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

export class UserIdParam {
  @IsUUID()
  id!: string;
}

export class UserListQuery {
  /** Sólo platform_admin: filtra por cliente. Un admin siempre ve el suyo. */
  @IsOptional()
  @Matches(ID_PATTERN, { message: 'orgId inválido' })
  orgId?: string;
}

export class CreateUserDto {
  @Transform(lowerTrim)
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @PasswordRules()
  password!: string;

  /** Si es `platform_admin` el servicio decide (403 para un admin); la validación sólo comprueba que sea un rol. */
  @IsIn(ROLES)
  role!: Role;

  /** Cliente del usuario. Obligatorio para platform_admin (salvo al crear otro platform_admin); implícito para admin. */
  @IsOptional()
  @Matches(ID_PATTERN, { message: 'orgId inválido' })
  orgId?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @ArrayUnique()
  @Matches(ID_PATTERN, { each: true, message: 'plants: ids de planta inválidos' })
  plants?: string[];
}

export class UpdateUserDto {
  @IsOptional()
  @IsIn(ROLES)
  role?: Role;

  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @IsOptional()
  @PasswordRules()
  password?: string;
}

export class SetPlantsDto {
  @IsArray()
  @ArrayMaxSize(200)
  @ArrayUnique()
  @Matches(ID_PATTERN, { each: true, message: 'plants: ids de planta inválidos' })
  plants!: string[];
}
