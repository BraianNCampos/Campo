import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type Redis from 'ioredis';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app.setup';
import { AlarmRulesRepository } from '../../src/alarms/alarm-rules.repository';
import { AlarmsRepository } from '../../src/alarms/alarms.repository';
import { AuthService } from '../../src/auth/auth.service';
import { UsersRepository } from '../../src/auth/users.repository';
import { APP_CONFIG, AppConfig, parseEnv } from '../../src/config/app-config';
import { PG_POOL } from '../../src/database/tokens';
import { HistoryRepository } from '../../src/history/history.repository';
import { Asset, AssetsRepository } from '../../src/plants/assets.repository';
import { REDIS, REDIS_SUB } from '../../src/redis/tokens';
import {
  MemoryAlarmRulesRepository,
  MemoryAlarmsRepository,
  MemoryAssetsRepository,
  MemoryHistoryRepository,
  MemoryUsersRepository,
} from './memory-repos';
import { createRedisMocks } from './redis-mock';

export const DEMO_ASSETS: Asset[] = [
  { plant: 'demo', id: 'tk-01', name: 'Tanque 01', type: 'tank', model3dRef: 'tank', metadata: {} },
  { plant: 'demo', id: 'pump-01', name: 'Bomba 01', type: 'pump', model3dRef: null, metadata: {} },
];

export interface TestApp {
  app: INestApplication;
  cfg: AppConfig;
  redis: Redis;
  users: MemoryUsersRepository;
  rules: MemoryAlarmRulesRepository;
  alarms: MemoryAlarmsRepository;
  history: MemoryHistoryRepository;
  pool: { query: jest.Mock; end: jest.Mock; on: jest.Mock };
  /** Crea un usuario y devuelve su JWT. */
  tokenFor(role: 'admin' | 'engineer' | 'operator' | 'viewer'): Promise<string>;
}

/** App completa (guards, pipes, gateway WS...) con repositorios en memoria y Redis mock. */
export async function createTestApp(overrides: Partial<AppConfig> = {}): Promise<TestApp> {
  const cfg: AppConfig = { ...parseEnv(process.env), ...overrides };
  const { redis, sub } = createRedisMocks();
  await redis.flushall();
  const users = new MemoryUsersRepository();
  const rules = new MemoryAlarmRulesRepository();
  const alarms = new MemoryAlarmsRepository();
  const history = new MemoryHistoryRepository();
  const pool = {
    query: jest.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] }),
    end: jest.fn().mockResolvedValue(undefined),
    on: jest.fn(),
  };

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(APP_CONFIG)
    .useValue(cfg)
    .overrideProvider(PG_POOL)
    .useValue(pool)
    .overrideProvider(REDIS)
    .useValue(redis)
    .overrideProvider(REDIS_SUB)
    .useValue(sub)
    .overrideProvider(UsersRepository)
    .useValue(users)
    .overrideProvider(AssetsRepository)
    .useValue(new MemoryAssetsRepository(DEMO_ASSETS))
    .overrideProvider(AlarmRulesRepository)
    .useValue(rules)
    .overrideProvider(AlarmsRepository)
    .useValue(alarms)
    .overrideProvider(HistoryRepository)
    .useValue(history)
    .compile();

  const app = moduleRef.createNestApplication({ logger: false });
  configureApp(app, cfg);
  await app.init();

  const auth = app.get(AuthService);
  const passwords = new Map<string, string>();
  const tokenFor: TestApp['tokenFor'] = async (role) => {
    const email = `${role}@campo.test`;
    const password = `${role}-password-123`;
    if (!passwords.has(email)) {
      passwords.set(email, password);
      await users.create({ email, passwordHash: await auth.hashPassword(password), role });
    }
    const res = await auth.login(email, password);
    return res.accessToken;
  };

  return { app, cfg, redis, users, rules, alarms, history, pool, tokenFor };
}
