/**
 * Contratos compartidos de Campo 2.0.
 * Fuente de verdad documentada en docs/architecture.md. Sin dependencias.
 */

export const TOPIC_PREFIX = 'campo/v1';
export const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export type Quality = 'good' | 'uncertain' | 'bad';
export type Role = 'admin' | 'engineer' | 'operator' | 'viewer';
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

/** Usuario autenticado tal como lo expone la API (`GET /api/me`, `login.user`). `plants` = ["*"] para admin. */
export interface Me {
  id: string;
  email: string;
  role: Role;
  plants: string[];
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
export type AssetType = 'tank' | 'pump' | 'valve' | 'sensor';

export interface Plant {
  id: string;
  name: string;
  assets: number;
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
