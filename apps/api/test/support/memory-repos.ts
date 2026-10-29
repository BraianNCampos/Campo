import { randomUUID } from 'node:crypto';
import type { AlarmEvent } from '@campo/shared';
import type { AlarmRecord, AlarmRule, AlarmRuleInput } from '../../src/alarms/alarm.types';
import { AlarmRulesRepository } from '../../src/alarms/alarm-rules.repository';
import { AlarmsRepository, ListAlarmsFilter } from '../../src/alarms/alarms.repository';
import { Asset, AssetsRepository } from '../../src/plants/assets.repository';
import { User, UsersRepository } from '../../src/auth/users.repository';
import { HistoryPlan } from '../../src/history/history.planner';
import { HistoryPoint, HistoryRepository } from '../../src/history/history.repository';

export class MemoryUsersRepository extends UsersRepository {
  readonly users: User[] = [];

  findByEmail(email: string): Promise<User | null> {
    return Promise.resolve(
      this.users.find((u) => u.email.toLowerCase() === email.toLowerCase()) ?? null,
    );
  }

  create(input: { email: string; passwordHash: string; role: User['role'] }): Promise<User | null> {
    if (this.users.some((u) => u.email.toLowerCase() === input.email.toLowerCase())) {
      return Promise.resolve(null);
    }
    const user: User = { id: randomUUID(), active: true, ...input };
    this.users.push(user);
    return Promise.resolve(user);
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

  list(plant?: string): Promise<AlarmRule[]> {
    return Promise.resolve([...this.rules.values()].filter((r) => !plant || r.plant === plant));
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

  list(f: ListAlarmsFilter): Promise<AlarmRecord[]> {
    return Promise.resolve(
      [...this.alarms.values()]
        .filter((a) => (!f.state || a.state === f.state) && (!f.plant || a.plant === f.plant))
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
