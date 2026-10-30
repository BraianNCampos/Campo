/**
 * Contratos compartidos de Campo 2.0.
 * Fuente de verdad documentada en docs/architecture.md. Sin dependencias.
 */

export const TOPIC_PREFIX = 'campo/v1';
export const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export type Quality = 'good' | 'uncertain' | 'bad';
export type Role = 'platform_admin' | 'admin' | 'engineer' | 'operator' | 'viewer';
export type Severity = 'warning' | 'critical';

/** Payload MQTT en campo/v1/{plant}/{asset}/telemetry */
export interface TelemetryPayload {
  ts?: number; // epoch ms
  values: Record<string, number>;
  quality?: Quality;
}

/** Último dato conocido de un activo (valor en el hash campo:state:{plant}) */
export interface AssetState {
  ts: number;
  values: Record<string, number>;
  quality: Quality;
}

/** Publicado por ingest en campo:events:{plant} */
export interface TelemetryEvent extends AssetState {
  type: 'telemetry';
  plant: string;
  asset: string;
}

/** Publicado por api en campo:alarms:{plant} */
export interface AlarmEvent {
  type: 'alarm';
  id: string;
  ruleId: string;
  plant: string;
  asset: string;
  metric: string;
  severity: Severity;
  state: 'active' | 'cleared';
  value: number;
  threshold: number;
  ts: number;
  message: string;
  acknowledged?: boolean;
}

export interface SnapshotMessage {
  type: 'snapshot';
  plant: string;
  assets: Record<string, AssetState>;
}

/** Mensajes servidor → cliente por WebSocket */
export type ServerMessage = SnapshotMessage | TelemetryEvent | AlarmEvent | CatalogMessage;

export const redisKeys = {
  state: (plant: string) => `campo:state:${plant}`,
  events: (plant: string) => `campo:events:${plant}`,
  alarms: (plant: string) => `campo:alarms:${plant}`,
  activeAlarms: (plant: string) => `campo:alarms:active:${plant}`,
  eventsPattern: 'campo:events:*',
} as const;

export const telemetryTopic = (plant: string, asset: string) =>
  `${TOPIC_PREFIX}/${plant}/${asset}/telemetry`;

export interface OrgSummary {
  id: string;
  name: string;
  modules: ModuleId[];
}

/** Usuario autenticado tal como lo expone la API (`GET /api/me`, `login.user`). `plants` = ["*"] para admin. */
export interface Me {
  id: string;
  email: string;
  role: Role;
  plants: string[];
  /** Cliente al que pertenece el usuario; `null` para el personal de Campos Ingeniería (`platform_admin`). */
  org: OrgSummary | null;
}

/** Respuesta de `POST /api/auth/login`. */
export interface LoginResponse {
  accessToken: string;
  user: Me;
}

/** Usuario en la administración (`/api/users`): `plants` son las asignaciones guardadas. */
export interface ManagedUser extends Me {
  active: boolean;
}

// ---- Administración (docs/architecture.md §9) ----
export type AssetType = 'tank' | 'pump' | 'valve' | 'sensor' | 'climate' | 'energy' | 'gas' | 'machine' | 'pressure' | 'flow';

export interface Plant {
  id: string;
  name: string;
  assets: number;
  orgId: string;
}

/** Definición de un activo del catálogo (administración). */
export interface AssetDef {
  plant: string;
  id: string;
  name: string;
  type: AssetType;
  model3dRef: string | null;
  metadata: Record<string, unknown>;
}

export interface AuditEntry {
  id: string; // ordenable (bigint como string)
  ts: number; // epoch ms
  actorId: string | null;
  actorEmail: string | null;
  action: string; // p.ej. "user.create", "asset.delete", "rule.update"
  target: string; // p.ej. "user:<id>", "asset:demo/tk-01"
  /** Cliente del recurso afectado (`null` = sin cliente, p. ej. acciones de plataforma). */
  orgId: string | null;
  detail: Record<string, unknown>; // sin secretos
}

// ---- Catálogo vivo y modelos 3D (docs/architecture.md §10) ----
export interface ModelInfo {
  id: string;
  plant: string;
  name: string;
  size: number; // bytes
  sha256: string;
  createdAt: number; // epoch ms
}

export interface AssetLayout {
  x: number;
  z: number;
  y?: number;
  rotY?: number; // grados
  scale?: number;
}

/** Mensaje servidor → cliente: el catálogo de la planta cambió; vuelve a pedirlo. */
export interface CatalogMessage {
  type: 'catalog';
  plant: string;
}

export const MODEL_REF_PATTERN = /^model:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// ---- Clientes y módulos (docs/architecture.md §11) ----
export type ModuleId = 'tanks' | 'climate' | 'energy' | 'gas' | 'machines' | 'flow' | 'view3d';

export interface ModuleDef {
  id: ModuleId;
  label: string;
  description: string;
  assetTypes: AssetType[];
}

/** Módulos que un cliente puede contratar, en el orden en que se muestran. */
export const MODULES: readonly ModuleDef[] = [
  { id: 'tanks', label: 'Tanques y llenado', description: 'Nivel de tanques, bombas y válvulas.', assetTypes: ['tank', 'pump', 'valve'] },
  { id: 'climate', label: 'Temperatura y humedad', description: 'Sensores ambientales de cámaras, depósitos y salas.', assetTypes: ['climate'] },
  { id: 'energy', label: 'Energía', description: 'Potencia, consumo y factor de potencia por línea.', assetTypes: ['energy'] },
  { id: 'gas', label: 'Consumo de gases', description: 'Caudal y consumo acumulado de gases.', assetTypes: ['gas'] },
  { id: 'machines', label: 'Estado de máquinas', description: 'Máquinas en marcha o detenidas.', assetTypes: ['machine'] },
  { id: 'flow', label: 'Presión y caudal', description: 'Presión de líneas y caudal de proceso.', assetTypes: ['pressure', 'flow'] },
  { id: 'view3d', label: 'Vista 3D', description: 'Gemelo digital de la planta con modelos propios.', assetTypes: [] },
] as const;

export const MODULE_IDS: readonly ModuleId[] = MODULES.map((m) => m.id);

/** Módulo al que pertenece un tipo de activo (`null` = genérico, siempre permitido). */
export function moduleForAssetType(type: AssetType): ModuleId | null {
  return MODULES.find((m) => m.assetTypes.includes(type))?.id ?? null;
}

export interface MetricDef {
  label: string;
  unit: string;
  decimals: number;
  /** Escala por defecto de la barra de rango. */
  scale: { min: number; max: number };
}

export const METRICS: Record<string, MetricDef> = {
  level: { label: 'Nivel', unit: '%', decimals: 1, scale: { min: 0, max: 100 } },
  temp: { label: 'Temperatura', unit: '°C', decimals: 1, scale: { min: -10, max: 50 } },
  humidity: { label: 'Humedad', unit: '%', decimals: 0, scale: { min: 0, max: 100 } },
  rpm: { label: 'Velocidad', unit: 'rpm', decimals: 0, scale: { min: 0, max: 3000 } },
  current: { label: 'Corriente', unit: 'A', decimals: 1, scale: { min: 0, max: 30 } },
  position: { label: 'Apertura', unit: '%', decimals: 0, scale: { min: 0, max: 100 } },
  kw: { label: 'Potencia', unit: 'kW', decimals: 0, scale: { min: 0, max: 200 } },
  kwh: { label: 'Energía acumulada', unit: 'kWh', decimals: 0, scale: { min: 0, max: 1_000_000 } },
  pf: { label: 'Factor de potencia', unit: '', decimals: 2, scale: { min: 0, max: 1 } },
  flow: { label: 'Caudal', unit: 'm³/h', decimals: 1, scale: { min: 0, max: 100 } },
  total: { label: 'Acumulado', unit: 'm³', decimals: 0, scale: { min: 0, max: 1_000_000 } },
  pressure: { label: 'Presión', unit: 'bar', decimals: 1, scale: { min: 0, max: 10 } },
  state: { label: 'Estado', unit: '', decimals: 0, scale: { min: 0, max: 1 } },
};

export interface AssetKindDef {
  type: AssetType;
  label: string;
  module: ModuleId | null;
  /** Métrica que se muestra en grande en la tarjeta. */
  primaryMetric: string;
  metrics: string[];
}

export const ASSET_KINDS: Record<AssetType, AssetKindDef> = {
  tank: { type: 'tank', label: 'Tanque', module: 'tanks', primaryMetric: 'level', metrics: ['level', 'temp'] },
  pump: { type: 'pump', label: 'Bomba', module: 'tanks', primaryMetric: 'rpm', metrics: ['rpm', 'current'] },
  valve: { type: 'valve', label: 'Válvula', module: 'tanks', primaryMetric: 'position', metrics: ['position'] },
  sensor: { type: 'sensor', label: 'Sensor', module: null, primaryMetric: 'value', metrics: [] },
  climate: { type: 'climate', label: 'Sensor de temperatura y humedad', module: 'climate', primaryMetric: 'temp', metrics: ['temp', 'humidity'] },
  energy: { type: 'energy', label: 'Medidor de energía', module: 'energy', primaryMetric: 'kw', metrics: ['kw', 'kwh', 'pf'] },
  gas: { type: 'gas', label: 'Medidor de gas', module: 'gas', primaryMetric: 'flow', metrics: ['flow', 'total'] },
  machine: { type: 'machine', label: 'Máquina', module: 'machines', primaryMetric: 'state', metrics: ['state'] },
  pressure: { type: 'pressure', label: 'Sensor de presión', module: 'flow', primaryMetric: 'pressure', metrics: ['pressure'] },
  flow: { type: 'flow', label: 'Caudalímetro', module: 'flow', primaryMetric: 'flow', metrics: ['flow'] },
};

/** Organización (cliente) tal como la ve el personal de plataforma. */
export interface Org {
  id: string;
  name: string;
  modules: ModuleId[];
  active: boolean;
  createdAt: number; // epoch ms
  plants: number;
  users: number;
}

/** Límite de alarma resuelto para un activo concreto (`GET /api/plants/:plant/limits`). */
export interface Limit {
  asset: string;
  metric: string;
  operator: 'gt' | 'lt' | 'gte' | 'lte';
  threshold: number;
  severity: Severity;
}
