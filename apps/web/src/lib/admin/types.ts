import type { AssetDef, AssetType, AuditEntry, ManagedUser, Me, Plant, Role, Severity } from '@campo/shared';

export type { AssetDef, AssetType, AuditEntry, ManagedUser, Me, Plant, Role, Severity };

export type Operator = 'gt' | 'lt' | 'gte' | 'lte';
export const OPERATORS: readonly Operator[] = ['gt', 'lt', 'gte', 'lte'];
export const ASSET_TYPES: readonly AssetType[] = ['tank', 'pump', 'valve', 'sensor'];
export const ROLES: readonly Role[] = ['admin', 'engineer', 'operator', 'viewer'];
export const SEVERITIES: readonly Severity[] = ['warning', 'critical'];

/** Regla tal como la devuelve `GET /api/alarm-rules` (ver apps/api/src/alarms/alarm.types.ts). */
export interface AlarmRule {
  id: string;
  plant: string;
  /** Id de activo exacto o patrón con `*` */
  asset: string;
  metric: string;
  operator: Operator;
  threshold: number;
  severity: Severity;
  forSeconds: number;
  hysteresis: number;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}
export type AlarmRuleInput = Omit<AlarmRule, 'id' | 'createdAt' | 'updatedAt'>;
export type AlarmRulePatch = Partial<AlarmRuleInput>;

export interface AssetInput {
  id: string;
  name: string;
  type: AssetType;
  model3dRef?: string | null;
  metadata?: Record<string, unknown>;
}
/** El id no se cambia. */
export type AssetPatch = Partial<Omit<AssetInput, 'id'>>;

export interface UserInput {
  email: string;
  password: string;
  role: Role;
  plants?: string[];
}
export interface UserPatch {
  role?: Role;
  active?: boolean;
  password?: string;
}

export interface AuditQuery {
  /** nº de entradas por página (def. 50) */
  limit?: number;
  /** devuelve entradas con id menor que éste (paginación hacia atrás) */
  before?: string;
  actor?: string;
  action?: string;
}

/** Cliente tipado de la API de administración (docs/architecture.md §4, §8.1, §9). */
export interface AdminApi {
  me(): Promise<Me>;
  changePassword(input: { currentPassword: string; newPassword: string }): Promise<{ accessToken: string }>;

  listPlants(): Promise<Plant[]>;
  createPlant(input: { id: string; name: string }): Promise<Plant>;
  renamePlant(id: string, name: string): Promise<Plant>;
  deletePlant(id: string): Promise<void>;

  listAssets(plant: string): Promise<AssetDef[]>;
  createAsset(plant: string, input: AssetInput): Promise<AssetDef>;
  updateAsset(plant: string, id: string, patch: AssetPatch): Promise<AssetDef>;
  deleteAsset(plant: string, id: string): Promise<{ affectedRules: number }>;

  listUsers(): Promise<ManagedUser[]>;
  createUser(input: UserInput): Promise<ManagedUser>;
  updateUser(id: string, patch: UserPatch): Promise<ManagedUser>;
  setUserPlants(id: string, plants: string[]): Promise<ManagedUser>;
  /** Devuelve el usuario (la API responde 200 con el ManagedUser). */
  revokeUserSessions(id: string): Promise<ManagedUser>;

  listRules(): Promise<AlarmRule[]>;
  createRule(input: AlarmRuleInput): Promise<AlarmRule>;
  updateRule(id: string, patch: AlarmRulePatch): Promise<AlarmRule>;
  deleteRule(id: string): Promise<void>;

  listAudit(query?: AuditQuery): Promise<AuditEntry[]>;
}
