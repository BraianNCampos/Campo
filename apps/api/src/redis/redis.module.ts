import { Global, Inject, Logger, Module, OnApplicationShutdown } from '@nestjs/common';
import Redis from 'ioredis';
import { APP_CONFIG, AppConfig } from '../config/app-config';
import { CatalogNotifier } from './catalog-notifier';
import { RealtimeBus } from './realtime-bus';
import { REDIS, REDIS_SUB } from './tokens';

function create(cfg: AppConfig, name: string): Redis {
  const client = new Redis(cfg.redisUrl, {
    connectionName: `campo-api-${name}`,
    lazyConnect: false,
  });
  const log = new Logger(`redis:${name}`);
  client.on('error', (err: Error) => log.error({ msg: 'redis error', error: err.message }));
  return client;
}

@Global()
@Module({
  providers: [
    { provide: REDIS, inject: [APP_CONFIG], useFactory: (cfg: AppConfig) => create(cfg, 'cmd') },
    {
      provide: REDIS_SUB,
      inject: [APP_CONFIG],
      useFactory: (cfg: AppConfig) => create(cfg, 'sub'),
    },
    RealtimeBus,
    CatalogNotifier,
  ],
  exports: [REDIS, REDIS_SUB, RealtimeBus, CatalogNotifier],
})
export class RedisModule implements OnApplicationShutdown {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(REDIS_SUB) private readonly sub: Redis,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await Promise.allSettled([this.redis.quit(), this.sub.quit()]);
  }
}
