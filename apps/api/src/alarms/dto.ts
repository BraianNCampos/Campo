import { ID_PATTERN } from '@campo/shared';
import type { Severity } from '@campo/shared';
import { PartialType } from '@nestjs/mapped-types';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsUUID,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { OPERATORS, Operator, SEVERITIES } from './alarm.types';

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
  @IsOptional()
  @IsIn(['active', 'cleared'])
  state?: 'active' | 'cleared';

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
