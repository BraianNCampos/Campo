import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Role } from '@campo/shared';
import type Redis from 'ioredis';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app.setup';
import { AlarmRulesRepository } from '../../src/alarms/alarm-rules.repository';
import { AlarmsRepository } from '../../src/alarms/alarms.repository';
import { AuthService } from '../../src/auth/auth.service';
import { PlantCatalog } from '../../src/auth/plant-catalog';
import { UsersRepository } from '../../src/auth/users.repository';
import { APP_CONFIG, AppConfig, parseEnv } from '../../src/config/app-config';
import { PG_POOL } from '../../src/database/tokens';
import { HistoryRepository } from '../../src/history/history.repository';
import { AuditRepository } from '../../src/audit/audit.repository';
import { ModelsRepository } from '../../src/models/models.repository';
import { Asset, AssetsRepository } from '../../src/plants/assets.repository';
import { PlantsRepository } from '../../src/plants/plants.repository';
import { REDIS, REDIS_SUB } from '../../src/redis/tokens';
import {
  MemoryAlarmRulesRepository,
  MemoryAlarmsRepository,
  MemoryAssetsRepository,
  MemoryAuditRepository,
  MemoryHistoryRepository,
  MemoryModelsRepository,
  MemoryPlantCatalog,
  MemoryPlantsRepository,
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
  assets: MemoryAssetsRepository;
  models: MemoryModelsRepository;
  plants: MemoryPlantsRepository;
  audit: MemoryAuditRepository;
  pool: { query: jest.Mock; end: jest.Mock; on: jest.Mock };
  /**
   * Crea (una vez por rol) un usuario `<rol>@campo.test` y devuelve su JWT.
   * Los roles distintos de admin quedan asignados a la planta `demo`.
   */
  tokenFor(role: Role): Promise<string>;
  /** Crea un usuario con email/plantas concretos y devuelve su id, email y JWT. */
  makeUser(
    email: string,
    role: Role,
    plants?: string[],
  ): Promise<{ id: string; email: string; token: string }>;
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
  const assets = new MemoryAssetsRepository(DEMO_ASSETS.map((a) => ({ ...a })));
  const models = new MemoryModelsRepository(assets);
  const plants = new MemoryPlantsRepository(assets, users);
  const audit = new MemoryAuditRepository();
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
    .useValue(assets)
    .overrideProvider(ModelsRepository)
    .useValue(models)
    .overrideProvider(PlantsRepository)
    .useValue(plants)
    .overrideProvider(AuditRepository)
    .useValue(audit)
    .overrideProvider(PlantCatalog)
    .useValue(new MemoryPlantCatalog(plants, redis))
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
  const makeUser: TestApp['makeUser'] = async (email, role, plants = []) => {
    const password = `${role}-password-123`;
    const created = await users.create({
      email,
      passwordHash: await auth.hashPassword(password),
      role,
    });
    // Si ya existe (p. ej. el admin semilla, cuya contraseña coincide) se reutiliza.
    const user = created ?? (await users.findByEmail(email));
    if (!user) throw new Error(`no se pudo crear ${email}`);
    if (created) await users.setPlants(user.id, plants);
    const { accessToken } = await auth.login(email, password);
    return { id: user.id, email, token: accessToken };
  };
  const tokens = new Map<Role, string>();
  const tokenFor: TestApp['tokenFor'] = async (role) => {
    let token = tokens.get(role);
    if (!token) {
      token = (await makeUser(`${role}@campo.test`, role, role === 'admin' ? [] : ['demo'])).token;
      tokens.set(role, token);
    }
    return token;
  };

  return {
    app,
    cfg,
    redis,
    users,
    rules,
    alarms,
    history,
    assets,
    models,
    plants,
    audit,
    pool,
    tokenFor,
    makeUser,
  };
}
