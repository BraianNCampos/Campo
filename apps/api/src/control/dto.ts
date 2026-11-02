import { ID_PATTERN } from '@campo/shared';
import type { OrderCommand, OrderStatus } from '@campo/shared';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsNumber, IsOptional, IsUUID, Matches, Max, Min } from 'class-validator';
import { ORDER_COMMANDS, ORDER_STATUSES } from './control.types';

export class OrderPreviewDto {
  @IsIn(ORDER_COMMANDS)
  command!: OrderCommand;

  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  target?: number;
}

export class OrderConfirmDto {
  @IsUUID()
  confirmId!: string;
}

export class OrderIdParam {
  @IsUUID()
  id!: string;
}

export class ListOrdersQuery {
  @IsOptional()
  @Matches(ID_PATTERN, { message: 'asset inválido' })
  asset?: string;

  @IsOptional()
  @IsIn(ORDER_STATUSES)
  status?: OrderStatus;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  /** Paginación: sólo órdenes pedidas antes de este instante (epoch ms, el `requestedAt` de la última de la página anterior). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  before?: number;
}

export class InterlocksQuery {
  @IsOptional()
  @IsIn(ORDER_COMMANDS)
  command?: OrderCommand;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  target?: number;
}
