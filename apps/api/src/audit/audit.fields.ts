/**
 * Auditoría: lista EXPLÍCITA de campos de `detail` permitidos por acción. Todo lo demás se descarta,
 * así que añadir un campo sensible por descuido en un servicio no llega nunca a la tabla.
 * Regla: sólo ids, nombres de campos modificados y valores de configuración no secretos. Nunca
 * contraseñas, hashes, tokens ni el contenido de `metadata` de un activo (sólo que cambió).
 * El cliente (`org_id`) NO va en `detail`: se pasa aparte a `AuditService.record`.
 */
export const AUDIT_FIELDS = {
  'org.create': ['name', 'modules', 'active'],
  'org.update': ['changed', 'name', 'modules', 'active'],
  'org.delete': ['name'],
  'org.admin.create': ['email'],
  'user.create': ['email', 'role', 'plants', 'orgId'],
  'user.update': ['changed', 'role', 'active'],
  'user.plants': ['plants'],
  'user.revoke': [],
  'me.password': [],
  'plant.create': ['name'],
  'plant.update': ['name'],
  'plant.delete': ['name', 'unassignedUsers'],
  'asset.create': ['name', 'type', 'model3dRef', 'tag'],
  // controlEnabled: si el cambio de metadata trae `control`, si queda habilitado (el resto de metadata no se audita).
  'asset.update': ['changed', 'name', 'type', 'model3dRef', 'tag', 'controlEnabled'],
  'asset.delete': ['affectedRules'],
  // Modelos 3D: nunca el contenido del archivo, sólo su identidad (nombre, tamaño, hash).
  'model.upload': ['name', 'size', 'sha256', 'dedup'],
  'model.delete': ['name', 'id'],
  'rule.create': [
    'plant',
    'asset',
    'metric',
    'operator',
    'threshold',
    'severity',
    'forSeconds',
    'hysteresis',
    'enabled',
    'kind',
    'offDelaySeconds',
    'rocWindowSeconds',
    'rocDirection',
  ],
  'rule.update': ['changed', 'plant'],
  'rule.delete': ['plant', 'asset', 'metric'],
  // Fuera de servicio: el motivo es texto operativo libre (≤300), no un dato sensible.
  'rule.out_of_service': ['plant', 'asset', 'metric', 'reason'],
  'alarm.ack': ['plant', 'asset', 'metric', 'severity'],
  'alarm.shelve': ['plant', 'asset', 'metric', 'severity', 'minutes'],
  'alarm.unshelve': ['plant', 'asset', 'metric', 'severity'],
  // Control de llenado (§14.3): quién ordenó qué y cómo terminó. `by` vacío = el equipo/sistema (acks, plazos).
  'asset.setpoint': ['plant', 'metric', 'value', 'previous'],
  'order.create': ['plant', 'asset', 'command', 'target', 'cancelOf'],
  'order.status': ['plant', 'asset', 'command', 'status', 'previous', 'reason'],
  'plant.alarm_policy': ['ratePerDay', 'peak10min', 'staleHours'],
} as const satisfies Record<string, readonly string[]>;

export type AuditAction = keyof typeof AUDIT_FIELDS;

export const AUDIT_ACTIONS = Object.keys(AUDIT_FIELDS) as AuditAction[];

type Scalar = string | number | boolean | null;

const MAX_STRING = 200;
const MAX_ITEMS = 200;
/** Defensa en profundidad: aunque llegara por un campo permitido, esto nunca se guarda. */
const SECRET_LIKE = /^\$2[aby]\$|^eyJ[\w-]+\.[\w-]+\.[\w-]*$/;

function scalar(v: unknown): Scalar | undefined {
  if (v === null || typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string' && !SECRET_LIKE.test(v)) return v.slice(0, MAX_STRING);
  return undefined;
}

/**
 * Proyecta `raw` a los campos permitidos de `action`: sólo escalares o listas de escalares
 * (nada de objetos anidados), con longitudes acotadas.
 */
export function sanitizeDetail(
  action: AuditAction,
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of AUDIT_FIELDS[action] as readonly string[]) {
    const v = raw[key];
    if (v === undefined) continue;
    if (Array.isArray(v)) {
      const items = v.slice(0, MAX_ITEMS).map(scalar);
      out[key] = items.filter((i): i is Scalar => i !== undefined);
    } else {
      const s = scalar(v);
      if (s !== undefined) out[key] = s;
    }
  }
  return out;
}
