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

export class CreateUserDto {
  @Transform(lowerTrim)
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @PasswordRules()
  password!: string;

  @IsIn(ROLES)
  role!: Role;

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
