import { ID_PATTERN } from '@campo/shared';
import type { AlarmKind, Severity } from '@campo/shared';
import { PartialType } from '@nestjs/mapped-types';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
  ValidationArguments,
  ValidationOptions,
  registerDecorator,
} from 'class-validator';
import {
  KINDS,
  OPERATORS,
  Operator,
  ROC_DIRECTIONS,
  RULE_LIMITS,
  RocDirection,
  SEVERITIES,
  SUPPRESS_OPERATORS,
  SuppressOperator,
  kindOperatorError,
} from './alarm.types';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/** `kind` coherente con `operator` (HH/HI/DEV/ROC: gt|gte; LO/LL: lt|lte). Sólo si vienen los dos. */
function KindMatchesOperator(options?: ValidationOptions): PropertyDecorator {
  return (target, propertyName) =>
    registerDecorator({
      name: 'kindMatchesOperator',
      target: target.constructor,
      propertyName: propertyName as string,
      options,
      validator: {
        validate: (kind: unknown, args: ValidationArguments) => {
          const operator = (args.object as { operator?: Operator }).operator;
          return (
            !operator ||
            !KINDS.includes(kind as AlarmKind) ||
            !kindOperatorError(kind as AlarmKind, operator)
          );
        },
        defaultMessage: (args: ValidationArguments) => {
          const operator = (args.object as { operator?: Operator }).operator as Operator;
          return (
            kindOperatorError(args.value as AlarmKind, operator) ?? 'kind incoherente con operator'
          );
        },
      },
    });
}

/** Condición de supresión por estado (§12.1). */
export class SuppressWhenDto {
  @Matches(/^[a-z0-9*][a-z0-9_*-]{0,63}$/, {
    message: 'suppressWhen.asset: id exacto o patrón con * (p. ej. pump-01)',
  })
  asset!: string;

  @Matches(/^[A-Za-z0-9_.-]{1,64}$/, { message: 'suppressWhen.metric inválida' })
  metric!: string;

  @IsIn(SUPPRESS_OPERATORS)
  operator!: SuppressOperator;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  value!: number;
}

export class CreateRuleDto {
  @Matches(ID_PATTERN, { message: 'plant inválida' })
  plant!: string;

  @Matches(/^[a-z0-9*][a-z0-9_*-]{0,63}$/, {
    message: 'asset: id exacto o patrón con * (p. ej. tk-*)',
  })
  asset!: string;

  @Matches(/^[A-Za-z0-9_.-]{1,64}$/, { message: 'metric inválida' })
  metric!: string;

  @IsIn(OPERATORS)
  operator!: Operator;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  threshold!: number;

  @IsIn(SEVERITIES)
  severity!: Severity;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(86_400)
  forSeconds?: number;

  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  hysteresis?: number;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  // ---- ISA-18.2 (§12.1). Todo opcional: sin ello la regla se comporta como antes. ----

  /** Por defecto se deriva de operator + severity. */
  @IsOptional()
  @IsIn(KINDS)
  @KindMatchesOperator()
  kind?: AlarmKind;

  @IsOptional()
  @IsInt()
  @Min(RULE_LIMITS.rocWindowMin)
  @Max(RULE_LIMITS.rocWindowMax)
  rocWindowSeconds?: number;

  @IsOptional()
  @IsIn(ROC_DIRECTIONS)
  rocDirection?: RocDirection;

  /** Retardo de retorno a normal (s). */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(RULE_LIMITS.offDelayMax)
  offDelaySeconds?: number;

  /** `null` quita la condición de supresión. */
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => SuppressWhenDto)
  suppressWhen?: SuppressWhenDto | null;

  /** Racionalización: `null` la borra. */
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(RULE_LIMITS.descriptionMax)
  description?: string | null;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(RULE_LIMITS.consequenceMax)
  consequence?: string | null;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(RULE_LIMITS.responseMax)
  response?: string | null;

  /** Obligatorio al poner `enabled=false` (lo exige el servicio); `null` la borra. */
  @IsOptional()
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MinLength(RULE_LIMITS.reasonMin, { message: 'outOfServiceReason: al menos 3 caracteres' })
  @MaxLength(RULE_LIMITS.reasonMax)
  outOfServiceReason?: string | null;
}

/** PATCH: todos los campos opcionales. */
export class UpdateRuleDto extends PartialType(CreateRuleDto) {}

export class IdParam {
  @IsUUID()
  id!: string;
}

export class RuleListQuery {
  @IsOptional()
  @Matches(ID_PATTERN, { message: 'plant inválida' })
  plant?: string;
}

export class ListAlarmsQuery {
  /** `active` = lista de alarmas (unacked, acked, rtn_unacked); `cleared` = cerradas; `shelved` = postergadas. */
  @IsOptional()
  @IsIn(['active', 'cleared', 'shelved'])
  state?: 'active' | 'cleared' | 'shelved';

  @IsOptional()
  @Matches(ID_PATTERN, { message: 'plant inválida' })
  plant?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;
}

/** Postergar (§12.2): 1–480 minutos y un motivo de al menos 3 caracteres. */
export class ShelveDto {
  @IsInt()
  @Min(1)
  @Max(480)
  minutes!: number;

  @Transform(trim)
  @IsString()
  @MinLength(3, { message: 'reason: al menos 3 caracteres' })
  @MaxLength(200)
  reason!: string;
}

/** Política de alarmas de una planta (los tres valores; PUT sustituye). */
export class AlarmPolicyDto {
  @IsInt()
  @Min(1)
  @Max(10_000)
  ratePerDay!: number;

  @IsInt()
  @Min(1)
  @Max(1_000)
  peak10min!: number;

  @IsInt()
  @Min(1)
  @Max(720)
  staleHours!: number;
}

export class KpiQuery {
  @IsOptional()
  @IsIn(['24h', '7d', '30d'])
  window?: '24h' | '7d' | '30d';
}
