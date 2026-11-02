import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import type { InterlockItem, Order, OrderPreview } from '@campo/shared';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser, PlantOrgId, Roles } from '../auth/decorators';
import { PlantAccessGuard } from '../auth/plant-access.guard';
import { AssetParams, PlantParams } from '../common/params';
import {
  InterlocksQuery,
  ListOrdersQuery,
  OrderConfirmDto,
  OrderIdParam,
  OrderPreviewDto,
} from './dto';
import { OrdersService } from './orders.service';

/**
 * Control de llenado (§14.3). Ordenar: operator, engineer, admin y platform_admin (el viewer sólo lee). El
 * PlantAccessGuard da el mismo 403 a una planta ajena o inexistente.
 */
@Controller('plants/:plant')
@UseGuards(PlantAccessGuard)
export class PlantOrdersController {
  constructor(private readonly orders: OrdersService) {}

  /** Paso 1: valida y devuelve el resumen y un `confirmId` de un solo uso (60 s). No envía nada al equipo. */
  @Post('assets/:asset/commands/preview')
  @Roles('engineer', 'operator')
  @HttpCode(200)
  preview(
    @Param() p: AssetParams,
    @Body() dto: OrderPreviewDto,
    @CurrentUser() user: AuthUser,
    @PlantOrgId() orgId: string | null,
  ): Promise<OrderPreview> {
    return this.orders.preview(user, p.plant, orgId, p.asset, dto);
  }

  /** Paso 2: ejecuta la orden confirmada. */
  @Post('assets/:asset/commands')
  @Roles('engineer', 'operator')
  execute(
    @Param() p: AssetParams,
    @Body() dto: OrderConfirmDto,
    @CurrentUser() user: AuthUser,
    @PlantOrgId() orgId: string | null,
  ): Promise<Order> {
    return this.orders.execute(user, p.plant, orgId, p.asset, dto.confirmId);
  }

  /** Permisos de enclavamiento del equipo (nivel 4): operator+. */
  @Get('assets/:asset/interlocks')
  @Roles('engineer', 'operator')
  interlocks(
    @Param() p: AssetParams,
    @Query() q: InterlocksQuery,
    @PlantOrgId() orgId: string | null,
  ): Promise<InterlockItem[]> {
    return this.orders.interlocks(p.plant, orgId, p.asset, q);
  }

  /** Registro de órdenes: cualquier rol con acceso a la planta. */
  @Get('orders')
  list(
    @Param() p: PlantParams,
    @Query() q: ListOrdersQuery,
    @PlantOrgId() orgId: string | null,
  ): Promise<Order[]> {
    return this.orders.list(p.plant, orgId, q);
  }
}

@Controller('orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  /** Cancela una orden en curso enviando un `stop` al equipo. */
  @Post(':id/cancel')
  @Roles('engineer', 'operator')
  @HttpCode(200)
  cancel(@Param() p: OrderIdParam, @CurrentUser() user: AuthUser): Promise<Order> {
    return this.orders.cancel(user, p.id);
  }
}
