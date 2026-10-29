import { randomUUID } from 'node:crypto';
import { redisKeys, type AlarmEvent } from '@campo/shared';
import type Redis from 'ioredis';
import type { AlarmRecord, AlarmRule, AlarmRuleInput } from '../../src/alarms/alarm.types';
import { AlarmRulesRepository } from '../../src/alarms/alarm-rules.repository';
import { AlarmsRepository, ListAlarmsFilter } from '../../src/alarms/alarms.repository';
import { Asset, AssetsRepository } from '../../src/plants/assets.repository';
import { UpdateResult, User, UserPatch, UsersRepository } from '../../src/auth/users.repository';
import { PlantCatalog } from '../../src/auth/plant-catalog';
import { HistoryPlan } from '../../src/history/history.planner';
import { HistoryPoint, HistoryRepository } from '../../src/history/history.repository';

export class MemoryUsersRepository extends UsersRepository {
  readonly users: User[] = [];
  /** Cuenta de lecturas a la "base" (para probar la caché). */
  reads = 0;

  findByEmail(email: string): Promise<User | null> {
    return Promise.resolve(
      this.users.find((u) => u.email.toLowerCase() === email.toLowerCase()) ?? null,
    );
  }

  findById(id: string): Promise<User | null> {
    this.reads++;
    return Promise.resolve(this.users.find((u) => u.id === id) ?? null);
  }

  list(): Promise<User[]> {
    return Promise.resolve([...this.users]);
  }

  create(input: { email: string; passwordHash: string; role: User['role'] }): Promise<User | null> {
    if (this.users.some((u) => u.email.toLowerCase() === input.email.toLowerCase())) {
      return Promise.resolve(null);
    }
    const user: User = { id: randomUUID(), active: true, plants: [], ...input };
    this.users.push(user);
    return Promise.resolve(user);
  }

  update(id: string, patch: UserPatch): Promise<UpdateResult> {
    const cur = this.users.find((u) => u.id === id);
    if (!cur) return Promise.resolve({ status: 'not_found' });
    const role = patch.role ?? cur.role;
    const active = patch.active ?? cur.active;
    if (cur.role === 'admin' && cur.active && !(role === 'admin' && active)) {
      const others = this.users.filter((u) => u.id !== id && u.role === 'admin' && u.active);
      if (others.length === 0) return Promise.resolve({ status: 'last_admin' });
    }
    Object.assign(cur, { role, active, passwordHash: patch.passwordHash ?? cur.passwordHash });
    return Promise.resolve({ status: 'ok', user: cur });
  }

  setPlants(id: string, plants: string[]): Promise<User | null> {
    const cur = this.users.find((u) => u.id === id);
    if (!cur) return Promise.resolve(null);
    cur.plants = [...new Set(plants)].sort();
    return Promise.resolve(cur);
  }
}

/** Una planta existe si tiene activos (catálogo) o estado vivo en Redis. */
export class MemoryPlantCatalog extends PlantCatalog {
  constructor(
    private readonly assets: Asset[],
    private readonly redis: Redis,
  ) {
    super();
  }

  async exists(plant: string): Promise<boolean> {
    return (
      this.assets.some((a) => a.plant === plant) ||
      (await this.redis.exists(redisKeys.state(plant))) > 0
    );
  }
}

export class MemoryAssetsRepository extends AssetsRepository {
  constructor(private readonly assets: Asset[] = []) {
    super();
  }

  listByPlant(plant: string): Promise<Asset[]> {
    return Promise.resolve(this.assets.filter((a) => a.plant === plant));
  }
}

export class MemoryAlarmRulesRepository extends AlarmRulesRepository {
  readonly rules = new Map<string, AlarmRule>();

  list(plant?: string, plants?: string[]): Promise<AlarmRule[]> {
    return Promise.resolve(
      [...this.rules.values()].filter(
        (r) => (!plant || r.plant === plant) && (!plants || plants.includes(r.plant)),
      ),
    );
  }

  get(id: string): Promise<AlarmRule | null> {
    return Promise.resolve(this.rules.get(id) ?? null);
  }

  create(input: AlarmRuleInput): Promise<AlarmRule> {
    const now = Date.now();
    const rule: AlarmRule = { ...input, id: randomUUID(), createdAt: now, updatedAt: now };
    this.rules.set(rule.id, rule);
    return Promise.resolve(rule);
  }

  update(id: string, patch: Partial<AlarmRuleInput>): Promise<AlarmRule | null> {
    const cur = this.rules.get(id);
    if (!cur) return Promise.resolve(null);
    const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    const next = { ...cur, ...defined, updatedAt: Date.now() };
    this.rules.set(id, next);
    return Promise.resolve(next);
  }

  delete(id: string): Promise<boolean> {
    return Promise.resolve(this.rules.delete(id));
  }
}

export class MemoryAlarmsRepository extends AlarmsRepository {
  readonly alarms = new Map<string, AlarmRecord>();

  insert(a: AlarmEvent): Promise<void> {
    this.alarms.set(a.id, { ...a, state: 'active', acknowledged: false });
    return Promise.resolve();
  }

  markCleared(id: string, clearedAt: number): Promise<AlarmRecord | null> {
    const cur = this.alarms.get(id);
    if (!cur) return Promise.resolve(null);
    const next: AlarmRecord = { ...cur, state: 'cleared', clearedAt };
    this.alarms.set(id, next);
    return Promise.resolve(next);
  }

  ack(id: string, userId: string, at: number) {
    const cur = this.alarms.get(id);
    if (!cur) return Promise.resolve(null);
    if (cur.acknowledged) return Promise.resolve({ record: cur, changed: false });
    const next: AlarmRecord = {
      ...cur,
      acknowledged: true,
      acknowledgedBy: userId,
      acknowledgedAt: at,
    };
    this.alarms.set(id, next);
    return Promise.resolve({ record: next, changed: true });
  }

  findById(id: string): Promise<AlarmRecord | null> {
    return Promise.resolve(this.alarms.get(id) ?? null);
  }

  list(f: ListAlarmsFilter): Promise<AlarmRecord[]> {
    return Promise.resolve(
      [...this.alarms.values()]
        .filter(
          (a) =>
            (!f.state || a.state === f.state) &&
            (!f.plant || a.plant === f.plant) &&
            (!f.plants || f.plants.includes(a.plant)),
        )
        .sort((a, b) => b.ts - a.ts)
        .slice(0, f.limit),
    );
  }

  findActive(): Promise<AlarmRecord[]> {
    return Promise.resolve([...this.alarms.values()].filter((a) => a.state === 'active'));
  }
}

export class MemoryHistoryRepository extends HistoryRepository {
  readonly calls: { plant: string; asset: string; metric: string; plan: HistoryPlan }[] = [];
  points: HistoryPoint[] = [];

  query(plant: string, asset: string, metric: string, plan: HistoryPlan): Promise<HistoryPoint[]> {
    this.calls.push({ plant, asset, metric, plan });
    return Promise.resolve(this.points);
  }
}
