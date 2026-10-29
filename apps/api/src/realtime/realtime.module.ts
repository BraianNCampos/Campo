import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PlantsModule } from '../plants/plants.module';
import { LiveGateway } from './live.gateway';

@Module({
  imports: [AuthModule, PlantsModule],
  providers: [LiveGateway],
})
export class RealtimeModule {}
