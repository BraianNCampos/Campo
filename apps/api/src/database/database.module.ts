import { Global, Inject, Logger, Module, OnApplicationShutdown } from '@nestjs/common';
import { Pool } from 'pg';
import { APP_CONFIG, AppConfig } from '../config/app-config';
import { PG_POOL } from './tokens';

@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      inject: [APP_CONFIG],
      useFactory: (cfg: AppConfig) => {
        const pool = new Pool({
          connectionString: cfg.databaseUrl,
          max: cfg.pgPoolMax,
          application_name: 'campo-api',
          statement_timeout: 15_000,
          connectionTimeoutMillis: 5_000,
        });
        const log = new Logger('pg');
        pool.on('error', (err) => log.error({ msg: 'pg pool error', error: err.message }));
        return pool;
      },
    },
  ],
  exports: [PG_POOL],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end().catch(() => undefined);
  }
}
