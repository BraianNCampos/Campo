import { ID_PATTERN } from '@campo/shared';
import type { AssetType } from '@campo/shared';
import { OmitType, PartialType } from '@nestjs/mapped-types';
import { Transform } from 'class-transformer';
import {
  IsIn,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidationOptions,
  registerDecorator,
} from 'class-validator';
import { ASSET_TYPES } from './assets.repository';

/** Tamaño máximo de `metadata` serializada (bytes UTF-8). */
export const METADATA_MAX_BYTES = 8 * 1024;

function MaxJsonBytes(max: number, options?: ValidationOptions): PropertyDecorator {
  return (target, propertyName) =>
    registerDecorator({
      name: 'maxJsonBytes',
      target: target.constructor,
      propertyName: propertyName as string,
      options: { message: `${String(propertyName)} no puede superar ${max} bytes`, ...options },
      validator: {
        validate: (v: unknown) => {
          try {
            return Buffer.byteLength(JSON.stringify(v), 'utf8') <= max;
          } catch {
            return false;
          }
        },
      },
    });
}

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class CreatePlantDto {
  @Matches(ID_PATTERN, { message: 'id debe cumplir ^[a-z0-9][a-z0-9_-]{0,63}$' })
  id!: string;

  /** Cliente propietario. Obligatorio para platform_admin; un admin siempre crea en el suyo. */
  @IsOptional()
  @Matches(ID_PATTERN, { message: 'orgId inválido' })
  orgId?: string;

  @Transform(trim)
  @IsString()
  @IsNotEmpty({ message: 'name no puede estar vacío' })
  @MaxLength(100)
  name!: string;
}

export class PlantListQuery {
  /** Sólo platform_admin: filtra por cliente. Un admin siempre ve el suyo. */
  @IsOptional()
  @Matches(ID_PATTERN, { message: 'orgId inválido' })
  orgId?: string;
}

export class UpdatePlantDto {
  @Transform(trim)
  @IsString()
  @IsNotEmpty({ message: 'name no puede estar vacío' })
  @MaxLength(100)
  name!: string;
}

export class CreateAssetDto {
  @Matches(ID_PATTERN, { message: 'id debe cumplir ^[a-z0-9][a-z0-9_-]{0,63}$' })
  id!: string;

  @Transform(trim)
  @IsString()
  @IsNotEmpty({ message: 'name no puede estar vacío' })
  @MaxLength(100)
  name!: string;

  @IsIn(ASSET_TYPES)
  type!: AssetType;

  /** `null` = sin modelo 3D. */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  model3dRef?: string | null;

  @IsOptional()
  @IsObject()
  @MaxJsonBytes(METADATA_MAX_BYTES)
  metadata?: Record<string, unknown>;
}

/** PATCH: todo opcional; el `id` no se puede cambiar (no está en el DTO -> 400 por forbidNonWhitelisted). */
export class UpdateAssetDto extends PartialType(OmitType(CreateAssetDto, ['id'] as const)) {}
