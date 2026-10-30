import { ASSET_KINDS } from '@campo/shared';
import type { AssetDef, AssetType, AuditEntry, Limit, ManagedUser, Me, ModelInfo, ModuleId, Org, OrgSummary, Plant, Role, Severity } from '@campo/shared';

export type { AssetDef, AssetType, AuditEntry, Limit, ManagedUser, Me, ModelInfo, ModuleId, Org, OrgSummary, Plant, Role, Severity };

export type Operator = 'gt' | 'lt' | 'gte' | 'lte';
export const OPERATORS: readonly Operator[] = ['gt', 'lt', 'gte', 'lte'];
/** Todos los tipos de activo, en el orden del registro compartido. */
export const ASSET_TYPES = Object.keys(ASSET_KINDS) as readonly AssetType[];
/** Todos los roles; `platform_admin` sólo lo puede otorgar otro `platform_admin` (docs §11.1). */
export const ROLES: readonly Role[] = ['platform_admin', 'admin', 'engineer', 'operator', 'viewer'];
/** Roles que un administrador de cliente puede otorgar. */
export const CLIENT_ROLES: readonly Role[] = ['admin', 'engineer', 'operator', 'viewer'];
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
  /** Cliente del usuario. Obligatorio para un `platform_admin` que crea usuarios de cliente; el resto no lo envía (docs §11.1). */
  orgId?: string;
}
export interface UserPatch {
  role?: Role;
  active?: boolean;
  password?: string;
}

/** Entrada de auditoría con el cliente al que pertenece (`audit_log.org_id`, docs §11.1); `null` = acción de plataforma. */
export type AdminAuditEntry = AuditEntry & { orgId?: string | null };

export interface AuditQuery {
  /** nº de entradas por página (def. 50) */
  limit?: number;
  /** devuelve entradas con id menor que éste (paginación hacia atrás) */
  before?: string;
  actor?: string;
  action?: string;
  /** Sólo `platform_admin`: filtra por cliente. */
  orgId?: string;
}

/** Alta de cliente (`POST /api/orgs`). */
export interface OrgInput {
  id: string;
  name: string;
  modules: ModuleId[];
}
/** `PATCH /api/orgs/:id`: el id no se cambia. */
export type OrgPatch = Partial<{ name: string; modules: ModuleId[]; active: boolean }>;

/** Cliente tipado de la API de administración (docs/architecture.md §4, §8.1, §9). */
export interface AdminApi {
  me(): Promise<Me>;
  changePassword(input: { currentPassword: string; newPassword: string }): Promise<{ accessToken: string }>;

  // Clientes y módulos (docs/architecture.md §11), sólo `platform_admin`
  listOrgs(): Promise<Org[]>;
  getOrg(id: string): Promise<Org>;
  createOrg(input: OrgInput): Promise<Org>;
  updateOrg(id: string, patch: OrgPatch): Promise<Org>;
  /** 409 (`OrgNotEmptyError`) si tiene plantas o usuarios. */
  deleteOrg(id: string): Promise<void>;
  /** Crea el primer administrador del cliente. */
  createOrgAdmin(orgId: string, input: { email: string; password: string }): Promise<ManagedUser>;

  /** Límites de alarma resueltos de una planta (visibles para todos los roles con acceso). */
  listLimits(plant: string): Promise<Limit[]>;

  /** `orgId`: sólo `platform_admin` (filtra por cliente). */
  listPlants(q?: { orgId?: string }): Promise<Plant[]>;
  /** `orgId`: obligatorio para `platform_admin`, no se envía desde un administrador de cliente. */
  createPlant(input: { id: string; name: string; orgId?: string }): Promise<Plant>;
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

  listUsers(q?: { orgId?: string }): Promise<ManagedUser[]>;
  createUser(input: UserInput): Promise<ManagedUser>;
  updateUser(id: string, patch: UserPatch): Promise<ManagedUser>;
  setUserPlants(id: string, plants: string[]): Promise<ManagedUser>;
  /** Devuelve el usuario (la API responde 200 con el ManagedUser). */
  revokeUserSessions(id: string): Promise<ManagedUser>;

  listRules(): Promise<AlarmRule[]>;
  createRule(input: AlarmRuleInput): Promise<AlarmRule>;
  updateRule(id: string, patch: AlarmRulePatch): Promise<AlarmRule>;
  deleteRule(id: string): Promise<void>;

  listAudit(query?: AuditQuery): Promise<AdminAuditEntry[]>;
}
