import type { AssetDef, AssetType, AuditEntry, ManagedUser, Me, ModelInfo, Plant, Role, Severity } from '@campo/shared';

export type { AssetDef, AssetType, AuditEntry, ManagedUser, Me, ModelInfo, Plant, Role, Severity };

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
/** Respuesta de alta/edición: la API puede añadir avisos no bloqueantes (p. ej. `connectsTo` hacia un activo inexistente). */
export type AssetResult = AssetDef & { warnings?: string[] };

export interface ModelUploadOptions {
  /** Bytes enviados / totales (sólo si el navegador conoce el total) */
  onProgress?: (loaded: number, total: number) => void;
  signal?: AbortSignal;
}
/** `created` = false si la API devolvió el modelo ya existente (mismo contenido, 200). */
export interface ModelUploadResult {
  model: ModelInfo;
  created: boolean;
}

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
  createAsset(plant: string, input: AssetInput): Promise<AssetResult>;
  updateAsset(plant: string, id: string, patch: AssetPatch): Promise<AssetResult>;
  deleteAsset(plant: string, id: string): Promise<{ affectedRules: number }>;

  // Modelos 3D (docs/architecture.md §10.2)
  listModels(plant: string): Promise<ModelInfo[]>;
  /** Sube un GLB crudo (`model/gltf-binary`). */
  uploadModel(plant: string, file: Blob, name: string, opts?: ModelUploadOptions): Promise<ModelUploadResult>;
  /** 409 (`ModelInUseError`) con la lista de activos si está referenciado. */
  deleteModel(plant: string, id: string): Promise<void>;
  /** Descarga el binario del modelo (`GET /api/models/:id`, con Bearer). */
  downloadModel(id: string): Promise<ArrayBuffer>;
  /** Avisa cuando cambian activos o modelos de una planta (sólo el mock: la API real lo hace por WebSocket). */
  onCatalogChange?(listener: (plant: string) => void): () => void;

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
