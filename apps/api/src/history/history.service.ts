import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../config/app-config';
import { HistoryQueryDto } from './dto';
import { HistoryPlan, planHistory } from './history.planner';
import { HistoryPoint, HistoryRepository } from './history.repository';

export interface HistoryResponse {
  plant: string;
  asset: string;
  metric: string;
  source: HistoryPlan['source'];
  bucket: HistoryPlan['bucket'];
  from: number;
  to: number;
  points: HistoryPoint[];
}

const DEFAULT_RANGE_MS = 3_600_000;

@Injectable()
export class HistoryService {
  constructor(
    private readonly repo: HistoryRepository,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  async get(
    plant: string,
    asset: string,
    q: HistoryQueryDto,
    now: Date = new Date(),
  ): Promise<HistoryResponse> {
    const to = q.to ?? now;
    const from = q.from ?? new Date(to.getTime() - DEFAULT_RANGE_MS);
    const plan = planHistory(
      { from, to, bucket: q.bucket },
      { maxPoints: this.cfg.historyMaxPoints, maxRangeDays: this.cfg.historyMaxRangeDays },
    );
    const points = await this.repo.query(plant, asset, q.metric, plan);
    return {
      plant,
      asset,
      metric: q.metric,
      source: plan.source,
      bucket: plan.bucket,
      from: from.getTime(),
      to: to.getTime(),
      points,
    };
  }
}
