import { Module } from '@nestjs/common';
import { AlarmsModule } from './alarms/alarms.module';
import { AuthModule } from './auth/auth.module';
import { AppConfigModule } from './config/config.module';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { HistoryModule } from './history/history.module';
import { PlantsModule } from './plants/plants.module';
import { RealtimeModule } from './realtime/realtime.module';
import { RedisModule } from './redis/redis.module';

@Module({
  imports: [
    AppConfigModule,
    DatabaseModule,
    RedisModule,
    AuthModule,
    PlantsModule,
    HistoryModule,
    AlarmsModule,
    RealtimeModule,
    HealthModule,
  ],
})
export class AppModule {}
