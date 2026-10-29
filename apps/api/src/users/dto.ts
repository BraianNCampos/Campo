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
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
  ValidationOptions,
  registerDecorator,
} from 'class-validator';
import { ROLES } from '../auth/auth.types';

/** Política mínima de contraseñas. bcrypt sólo usa los primeros 72 bytes: se rechaza lo que excede. */
export const PASSWORD_MIN_LENGTH = 12;
const PASSWORD_MAX_BYTES = 72;

function MaxBytes(max: number, options?: ValidationOptions): PropertyDecorator {
  return (target, propertyName) =>
    registerDecorator({
      name: 'maxBytes',
      target: target.constructor,
      propertyName: propertyName as string,
      options: { message: `${String(propertyName)} no puede superar ${max} bytes`, ...options },
      validator: {
        validate: (v: unknown) => typeof v === 'string' && Buffer.byteLength(v, 'utf8') <= max,
      },
    });
}

const lowerTrim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

const PasswordRules = () => (target: object, key: string) => {
  IsString()(target, key);
  MinLength(PASSWORD_MIN_LENGTH, {
    message: `password debe tener al menos ${PASSWORD_MIN_LENGTH} caracteres`,
  })(target, key);
  MaxBytes(PASSWORD_MAX_BYTES)(target, key);
};

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
