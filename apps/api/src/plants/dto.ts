import { ID_PATTERN, TAG_PATTERN } from '@campo/shared';
import type { AssetType } from '@campo/shared';
import { OmitType, PartialType } from '@nestjs/mapped-types';
import { Transform } from 'class-transformer';
import {
  IsIn,
  IsNumber,
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
/** Los tags son en mayúsculas: se normaliza antes de validar (la unicidad no distingue mayúsculas). */
const upperTrim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toUpperCase() : value;

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

  /** Etiqueta estándar (§14.1), p. ej. `TNK-101`; única por planta sin distinguir mayúsculas. `null` = sin tag. */
  @IsOptional()
  @Transform(upperTrim)
  @Matches(TAG_PATTERN, {
    message:
      'tag debe cumplir ^(TNK|PMP|VLV|MTR|XMTR|PID|COMP|CONV)-[0-9]{3,4}[A-Z]?$ (p. ej. TNK-101)',
  })
  tag?: string | null;
}

/** PATCH: todo opcional; el `id` no se puede cambiar (no está en el DTO -> 400 por forbidNonWhitelisted). */
export class UpdateAssetDto extends PartialType(OmitType(CreateAssetDto, ['id'] as const)) {}

/** `:plant/:asset/setpoints/:metric`. */
export class SetpointParams {
  @Matches(ID_PATTERN, { message: 'plant debe cumplir ^[a-z0-9][a-z0-9_-]{0,63}$' })
  plant!: string;

  @Matches(ID_PATTERN, { message: 'asset debe cumplir ^[a-z0-9][a-z0-9_-]{0,63}$' })
  asset!: string;

  @Matches(/^[A-Za-z0-9_.-]{1,64}$/, { message: 'metric inválida' })
  metric!: string;
}

export class SetpointDto {
  @IsNumber({ allowNaN: false, allowInfinity: false })
  value!: number;
}
