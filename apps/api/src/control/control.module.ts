import { Module } from '@nestjs/common';
import { AlarmsModule } from '../alarms/alarms.module';
import { CatalogModule } from '../plants/catalog.module';
import { CommandBus, MqttCommandBus } from './command-bus';
import { ConfirmStore, ControlClock, RateLimiter } from './control-support';
import { OrdersController, PlantOrdersController } from './orders.controller';
import { OrdersRepository, PgOrdersRepository } from './orders.repository';
import { OrdersService } from './orders.service';

/** Control de llenado (§14.3): órdenes por MQTT con confirmación en dos pasos, enclavamientos y registro. */
@Module({
  imports: [CatalogModule, AlarmsModule],
  controllers: [PlantOrdersController, OrdersController],
  providers: [
    OrdersService,
    ConfirmStore,
    RateLimiter,
    ControlClock,
    { provide: OrdersRepository, useClass: PgOrdersRepository },
    { provide: CommandBus, useClass: MqttCommandBus },
  ],
})
export class ControlModule {}
