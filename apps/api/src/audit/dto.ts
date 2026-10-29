import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';

export class AuditListQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  /** Paginación: sólo entradas con id menor (el `id` de la última de la página anterior). */
  @IsOptional()
  @Matches(/^[1-9][0-9]{0,17}$/, { message: 'before debe ser un id numérico' })
  before?: string;

  /** id (UUID) o email del actor. */
  @IsOptional()
  @IsString()
  @MaxLength(254)
  actor?: string;

  @IsOptional()
  @Matches(/^[a-z]+\.[a-z_]+$/, { message: 'action inválida (p. ej. asset.delete)' })
  action?: string;
}
