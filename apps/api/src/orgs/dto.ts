import { ID_PATTERN, MODULE_IDS } from '@campo/shared';
import type { ModuleId } from '@campo/shared';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { PasswordRules } from '../common/password-rules';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;
const lowerTrim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

export class OrgIdParam {
  @Matches(ID_PATTERN, { message: 'id debe cumplir ^[a-z0-9][a-z0-9_-]{0,63}$' })
  id!: string;
}

const MODULES_MSG = `modules: cada elemento debe ser uno de ${MODULE_IDS.join(', ')}`;

export class CreateOrgDto {
  @Matches(ID_PATTERN, { message: 'id debe cumplir ^[a-z0-9][a-z0-9_-]{0,63}$' })
  id!: string;

  @Transform(trim)
  @IsString()
  @IsNotEmpty({ message: 'name no puede estar vacío' })
  @MaxLength(100)
  name!: string;

  @IsArray()
  @ArrayMaxSize(MODULE_IDS.length)
  @ArrayUnique()
  @IsIn(MODULE_IDS, { each: true, message: MODULES_MSG })
  modules!: ModuleId[];

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

/** PATCH: todo opcional; el `id` no cambia. */
export class UpdateOrgDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @IsNotEmpty({ message: 'name no puede estar vacío' })
  @MaxLength(100)
  name?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MODULE_IDS.length)
  @ArrayUnique()
  @IsIn(MODULE_IDS, { each: true, message: MODULES_MSG })
  modules?: ModuleId[];

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class CreateOrgAdminDto {
  @Transform(lowerTrim)
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @PasswordRules()
  password!: string;
}
