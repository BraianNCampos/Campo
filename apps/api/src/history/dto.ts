import { Transform } from 'class-transformer';
import { IsDate, IsIn, IsOptional, Matches } from 'class-validator';
import { BUCKET_NAMES, BucketName } from './history.planner';

/** Acepta ISO-8601 o epoch en ms (número o string numérico). Valor inválido -> Invalid Date. */
export function parseTimeInput(value: unknown): unknown {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'number') return new Date(value);
  if (typeof value === 'string') {
    return /^\d{10,16}$/.test(value) ? new Date(Number(value)) : new Date(value);
  }
  return new Date(NaN);
}

export class HistoryQueryDto {
  @Matches(/^[A-Za-z0-9_.-]{1,64}$/, { message: 'metric inválida' })
  metric!: string;

  @IsOptional()
  @Transform(({ value }) => parseTimeInput(value))
  @IsDate({ message: 'from debe ser ISO-8601 o epoch ms' })
  from?: Date;

  @IsOptional()
  @Transform(({ value }) => parseTimeInput(value))
  @IsDate({ message: 'to debe ser ISO-8601 o epoch ms' })
  to?: Date;

  @IsOptional()
  @IsIn(BUCKET_NAMES)
  bucket?: BucketName;
}
