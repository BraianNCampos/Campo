import { randomUUID } from 'node:crypto';
import {
  redisKeys,
  type AlarmEvent,
  type AuditEntry,
  type ModelInfo,
  type Org,
  type Plant,
} from '@campo/shared';
import type Redis from 'ioredis';
import type { PlantScope } from '../../src/auth/plant-access';
import {
  OrgDeleteResult,
  OrgPatch,
  OrgRecord,
  OrgsRepository,
} from '../../src/orgs/orgs.repository';
import type { AlarmRecord, AlarmRule, AlarmRuleInput } from '../../src/alarms/alarm.types';
import { AlarmRulesRepository } from '../../src/alarms/alarm-rules.repository';
import { AlarmsRepository, ListAlarmsFilter } from '../../src/alarms/alarms.repository';
import { AuditRepository, AuditQuery, NewAuditEntry } from '../../src/audit/audit.repository';
import { ModelsRepository, NewModel } from '../../src/models/models.repository';
import { Asset, AssetPatch, AssetsRepository } from '../../src/plants/assets.repository';
import { PlantFilter, PlantsRepository, RemoveResult } from '../../src/plants/plants.repository';
import {
  NewUser,
  UpdateResult,
  User,
  UserPatch,
  UsersRepository,
} from '../../src/auth/users.repository';
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

  list(filter: { orgId?: string } = {}): Promise<User[]> {
    return Promise.resolve(
      this.users.filter((u) => filter.orgId === undefined || u.orgId === filter.orgId),
    );
  }

  create(input: NewUser): Promise<User | null> {
    if (this.users.some((u) => u.email.toLowerCase() === input.email.toLowerCase())) {
      return Promise.resolve(null);
    }
    const user: User = {
      id: randomUUID(),
      active: true,
      tokenVersion: 0,
      plants: [],
      ...input,
    };
    this.users.push(user);
    return Promise.resolve(user);
  }

  update(id: string, patch: UserPatch): Promise<UpdateResult> {
    const cur = this.users.find((u) => u.id === id);
    if (!cur) return Promise.resolve({ status: 'not_found' });
    const role = patch.role ?? cur.role;
    const active = patch.active ?? cur.active;
    if (
      (cur.role === 'admin' || cur.role === 'platform_admin') &&
      cur.active &&
      !(role === cur.role && active)
    ) {
      const others = this.users.filter(
        (u) => u.id !== id && u.role === cur.role && u.active && u.orgId === cur.orgId,
      );
      if (others.length === 0) return Promise.resolve({ status: 'last_admin' });
    }
    Object.assign(cur, {
      role,
      active,
      passwordHash: patch.passwordHash ?? cur.passwordHash,
      tokenVersion: cur.tokenVersion + (patch.revokeTokens ? 1 : 0),
    });
    return Promise.resolve({ status: 'ok', user: cur });
  }

  setPlants(id: string, plants: string[]): Promise<User | null> {
    const cur = this.users.find((u) => u.id === id);
    if (!cur) return Promise.resolve(null);
    cur.plants = [...new Set(plants)].sort();
    return Promise.resolve(cur);
  }

  idsByOrg(orgId: string): Promise<string[]> {
    return Promise.resolve(this.users.filter((u) => u.orgId === orgId).map((u) => u.id));
  }

  revokeByOrg(orgId: string): Promise<string[]> {
    const mine = this.users.filter((u) => u.orgId === orgId);
    for (const u of mine) u.tokenVersion++;
    return Promise.resolve(mine.map((u) => u.id));
  }

  promoteToPlatformAdmin(id: string): Promise<User | null> {
    const cur = this.users.find((u) => u.id === id);
    if (!cur) return Promise.resolve(null);
    if (cur.role !== 'platform_admin') {
      Object.assign(cur, { role: 'platform_admin', orgId: null, plants: [] });
      cur.tokenVersion++;
    }
    return Promise.resolve(cur);
  }
}

export class MemoryOrgsRepository extends OrgsRepository {
  readonly orgs = new Map<string, OrgRecord>();

  constructor(
    private readonly plants: () => MemoryPlantsRepository,
    private readonly users: MemoryUsersRepository,
  ) {
    super();
  }

  findById(id: string): Promise<OrgRecord | null> {
    const o = this.orgs.get(id);
    return Promise.resolve(o ? { ...o, modules: [...o.modules] } : null);
  }

  list(): Promise<Org[]> {
    return Promise.resolve(
      [...this.orgs.values()]
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .map((o) => ({
          ...o,
          modules: [...o.modules],
          plants: this.plants().plantsOf(o.id).length,
          users: this.users.users.filter((u) => u.orgId === o.id).length,
        })),
    );
  }

  create(org: Omit<OrgRecord, 'createdAt'>): Promise<OrgRecord | null> {
    if (this.orgs.has(org.id)) return Promise.resolve(null);
    const rec = { ...org, createdAt: Date.now() };
    this.orgs.set(org.id, rec);
    return Promise.resolve({ ...rec });
  }

  update(id: string, patch: OrgPatch): Promise<OrgRecord | null> {
    const cur = this.orgs.get(id);
    if (!cur) return Promise.resolve(null);
    const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    const next = { ...cur, ...defined };
    this.orgs.set(id, next);
    return Promise.resolve({ ...next });
  }

  delete(id: string): Promise<OrgDeleteResult> {
    if (!this.orgs.has(id)) return Promise.resolve('not_found');
    if (this.plants().plantsOf(id).length > 0 || this.users.users.some((u) => u.orgId === id)) {
      return Promise.resolve('has_children');
    }
    this.orgs.delete(id);
    return Promise.resolve('ok');
  }
}

export class MemoryAssetsRepository extends AssetsRepository {
  constructor(readonly assets: Asset[] = []) {
    super();
  }

  listByPlant(plant: string): Promise<Asset[]> {
    return Promise.resolve(this.assets.filter((a) => a.plant === plant));
  }

  get(plant: string, id: string): Promise<Asset | null> {
    return Promise.resolve(this.assets.find((a) => a.plant === plant && a.id === id) ?? null);
  }

  async create(asset: Asset): Promise<Asset | null> {
    if (await this.get(asset.plant, asset.id)) return null;
    this.assets.push({ ...asset });
    return { ...asset };
  }

  async update(plant: string, id: string, patch: AssetPatch): Promise<Asset | null> {
    const cur = this.assets.find((a) => a.plant === plant && a.id === id);
    if (!cur) return null;
    const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    Object.assign(cur, defined);
    return Promise.resolve({ ...cur });
  }

  delete(plant: string, id: string): Promise<boolean> {
    const i = this.assets.findIndex((a) => a.plant === plant && a.id === id);
    if (i >= 0) this.assets.splice(i, 1);
    return Promise.resolve(i >= 0);
  }
}

/** Tabla `plants` en memoria (cada planta pertenece a un cliente). */
export class MemoryPlantsRepository extends PlantsRepository {
  readonly names = new Map<string, string>();
  readonly orgs = new Map<string, string>();
  /** Lo que en SQL borra la transacción de `remove` (reglas, alarmas, modelos): se engancha en test-app. */
  readonly onRemoved: ((id: string) => void)[] = [];

  constructor(
    private readonly assets: MemoryAssetsRepository,
    private readonly users: MemoryUsersRepository,
  ) {
    super();
  }

  private count(id: string): number {
    return this.assets.assets.filter((a) => a.plant === id).length;
  }

  plantsOf(orgId: string): string[] {
    return [...this.orgs].filter(([, o]) => o === orgId).map(([id]) => id);
  }

  orgOf(id: string): string | null {
    return this.orgs.get(id) ?? null;
  }

  /** Registra una planta ya existente de un cliente (fixtures). */
  register(id: string, orgId: string, name = id): void {
    this.names.set(id, name);
    this.orgs.set(id, orgId);
  }

  list(filter: PlantFilter = {}): Promise<Plant[]> {
    return Promise.resolve(
      [...this.names.keys()]
        .filter((id) => !filter.ids || filter.ids.includes(id))
        .filter((id) => filter.orgId === undefined || this.orgs.get(id) === filter.orgId)
        .sort()
        .map((id) => ({
          id,
          name: this.names.get(id) ?? id,
          assets: this.count(id),
          orgId: this.orgs.get(id) as string,
        })),
    );
  }

  isRegistered(id: string): Promise<boolean> {
    return Promise.resolve(this.names.has(id) || this.count(id) > 0);
  }

  async create(id: string, name: string, orgId: string): Promise<boolean> {
    if (await this.isRegistered(id)) return false;
    this.register(id, orgId, name);
    return true;
  }

  async rename(id: string, name: string): Promise<Plant | null> {
    if (!this.names.has(id)) return null;
    this.names.set(id, name);
    return (await this.list({ ids: [id] }))[0] ?? null;
  }

  remove(id: string): Promise<RemoveResult> {
    if (this.count(id) > 0) return Promise.resolve({ status: 'has_assets' });
    if (!this.names.delete(id)) return Promise.resolve({ status: 'not_found' });
    this.orgs.delete(id);
    const unassigned = this.users.users.filter((u) => u.plants.includes(id));
    for (const u of unassigned) u.plants = u.plants.filter((p) => p !== id);
    for (const hook of this.onRemoved) hook(id);
    return Promise.resolve({ status: 'ok', unassignedUserIds: unassigned.map((u) => u.id) });
  }
}

export class MemoryPlantCatalog extends PlantCatalog {
  constructor(
    private readonly plants: MemoryPlantsRepository,
    private readonly redis: Redis,
  ) {
    super();
  }

  orgOf(plant: string): Promise<string | null> {
    return Promise.resolve(this.plants.orgOf(plant));
  }

  async isLive(plant: string): Promise<boolean> {
    return (await this.redis.exists(redisKeys.state(plant))) > 0;
  }
}

export class MemoryAuditRepository extends AuditRepository {
  readonly entries: AuditEntry[] = [];
  /** Cliente de cada entrada (`AuditEntry` del contrato no lo expone). */
  readonly orgOfEntry = new Map<string, string | null>();
  /** Para simular un fallo de la tabla de auditoría. */
  failWith?: Error;
  private seq = 0;

  insert(e: NewAuditEntry): Promise<void> {
    if (this.failWith) return Promise.reject(this.failWith);
    const { orgId, ...entry } = e;
    const id = String(++this.seq);
    this.orgOfEntry.set(id, orgId);
    this.entries.push({ ...entry, id, ts: Date.now() });
    return Promise.resolve();
  }

  list(q: AuditQuery): Promise<AuditEntry[]> {
    const actor = q.actor?.toLowerCase();
    return Promise.resolve(
      this.entries
        .filter(
          (e) =>
            (q.orgId === undefined || this.orgOfEntry.get(e.id) === q.orgId) &&
            (!q.before || Number(e.id) < Number(q.before)) &&
            (!actor ||
              e.actorId?.toLowerCase() === actor ||
              e.actorEmail?.toLowerCase() === actor) &&
            (!q.action || e.action === q.action),
        )
        .sort((a, b) => Number(b.id) - Number(a.id))
        .slice(0, q.limit),
    );
  }
}

/** Mismo criterio que el SQL: `scope.plants` = lista permitida, `scope.orgId` = plantas de ese cliente. */
const inScope = (scope: PlantScope, plant: string, orgOf: (p: string) => string | null): boolean =>
  (!scope.plants || scope.plants.includes(plant)) &&
  (scope.orgId === undefined || orgOf(plant) === scope.orgId);

export class MemoryAlarmRulesRepository extends AlarmRulesRepository {
  readonly rules = new Map<string, AlarmRule>();

  constructor(private readonly orgOf: (plant: string) => string | null = () => null) {
    super();
  }

  list(plant?: string, scope: PlantScope = {}): Promise<AlarmRule[]> {
    return Promise.resolve(
      [...this.rules.values()].filter(
        (r) => (!plant || r.plant === plant) && inScope(scope, r.plant, this.orgOf),
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

  constructor(private readonly orgOf: (plant: string) => string | null = () => null) {
    super();
  }

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
            inScope(f.scope, a.plant, this.orgOf),
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

/** Tabla `asset_models` en memoria (UNIQUE(plant, sha256) incluido). */
export class MemoryModelsRepository extends ModelsRepository {
  readonly rows: (ModelInfo & { data: Buffer; createdBy: string | null })[] = [];
  /** Lecturas del contenido (para comprobar que un 304 no lo carga). */
  dataReads = 0;

  constructor(private readonly assets: MemoryAssetsRepository) {
    super();
  }

  insert(m: NewModel): Promise<{ model: ModelInfo; created: boolean }> {
    const found = this.rows.find((r) => r.plant === m.plant && r.sha256 === m.sha256);
    if (found) return Promise.resolve({ model: this.info(found), created: false });
    const row = {
      id: randomUUID(),
      plant: m.plant,
      name: m.name,
      size: m.data.length,
      sha256: m.sha256,
      createdAt: Date.now(),
      data: m.data,
      createdBy: m.createdBy,
    };
    this.rows.push(row);
    return Promise.resolve({ model: this.info(row), created: true });
  }

  private info(r: ModelInfo): ModelInfo {
    return {
      id: r.id,
      plant: r.plant,
      name: r.name,
      size: r.size,
      sha256: r.sha256,
      createdAt: r.createdAt,
    };
  }

  list(plant: string): Promise<ModelInfo[]> {
    return Promise.resolve(
      this.rows
        .filter((r) => r.plant === plant)
        .sort((a, b) => b.createdAt - a.createdAt)
        .map((r) => this.info(r)),
    );
  }

  getInfo(id: string): Promise<ModelInfo | null> {
    const r = this.rows.find((x) => x.id === id);
    return Promise.resolve(r ? this.info(r) : null);
  }

  getData(id: string): Promise<Buffer | null> {
    this.dataReads++;
    return Promise.resolve(this.rows.find((x) => x.id === id)?.data ?? null);
  }

  exists(plant: string, id: string): Promise<boolean> {
    return Promise.resolve(this.rows.some((r) => r.plant === plant && r.id === id));
  }

  assetsUsing(plant: string, id: string): Promise<string[]> {
    return Promise.resolve(
      this.assets.assets
        .filter((a) => a.plant === plant && a.model3dRef === `model:${id}`)
        .map((a) => a.id)
        .sort(),
    );
  }

  delete(plant: string, id: string): Promise<ModelInfo | null> {
    const i = this.rows.findIndex((r) => r.plant === plant && r.id === id);
    if (i < 0) return Promise.resolve(null);
    const [r] = this.rows.splice(i, 1);
    return Promise.resolve(this.info(r));
  }

  deleteByPlant(plant: string): Promise<number> {
    const before = this.rows.length;
    for (let i = this.rows.length - 1; i >= 0; i--)
      if (this.rows[i].plant === plant) this.rows.splice(i, 1);
    return Promise.resolve(before - this.rows.length);
  }
}

/** Repositorio de clientes autónomo para tests unitarios (sin plantas registradas). */
export function memoryOrgs(users: MemoryUsersRepository): MemoryOrgsRepository {
  const noPlants = { plantsOf: () => [] as string[] } as unknown as MemoryPlantsRepository;
  return new MemoryOrgsRepository(() => noPlants, users);
}
