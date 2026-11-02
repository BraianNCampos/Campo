import type { AssetState, ControlConfig, InterlockItem, Limit, OrderCommand } from '@campo/shared';
import type { Asset } from '../plants/assets.repository';
import { COMMANDS_BY_TYPE, CONTROL_LIMITS, LEVEL_COMMANDS } from './control.types';
import type { OrderRecord } from './orders.repository';

/** Lectura de `metadata.control` con los valores por defecto del contrato (§14.3). */
export function controlConfigOf(asset: Pick<Asset, 'metadata'>): Required<ControlConfig> {
  const c = asset.metadata['control'];
  const o = typeof c === 'object' && c !== null ? (c as Partial<ControlConfig>) : {};
  return {
    enabled: o.enabled === true,
    minTarget: typeof o.minTarget === 'number' ? o.minTarget : CONTROL_LIMITS.defaultMinTarget,
    maxTarget: typeof o.maxTarget === 'number' ? o.maxTarget : CONTROL_LIMITS.defaultMaxTarget,
    maxDurationMinutes:
      typeof o.maxDurationMinutes === 'number'
        ? o.maxDurationMinutes
        : CONTROL_LIMITS.defaultMaxDurationMinutes,
  };
}

/**
 * Límite alto del nivel: el menor umbral entre las reglas HI y HH (límites fijos con gt|gte) del activo. Si sólo hay
 * HH se usa ése (nunca se ordena llenar hasta el punto de alarma crítica). `null` si no hay ninguno.
 */
export function highLevelLimit(limits: readonly Limit[], assetId: string): number | null {
  const highs = limits.filter(
    (l) =>
      l.asset === assetId &&
      l.metric === 'level' &&
      (l.operator === 'gt' || l.operator === 'gte') &&
      (l.kind === 'HI' || l.kind === 'HH' || l.kind === undefined),
  );
  return highs.length === 0 ? null : Math.min(...highs.map((l) => l.threshold));
}

export interface InterlockInput {
  /** El cliente propietario de la planta tiene contratado `control`. */
  moduleActive: boolean;
  asset: Pick<Asset, 'id' | 'type' | 'metadata'>;
  /** Último estado conocido (hash `campo:state:{planta}`), si hay. */
  state: AssetState | null;
  now: number;
  /** Órdenes en curso del activo. */
  open: readonly Pick<OrderRecord, 'id' | 'command' | 'status'>[];
  /** Límite alto del nivel (ver `highLevelLimit`). */
  highLimit: number | null;
  /** Hay una alarma HH activa sobre el nivel del activo. */
  hhActive: boolean;
  command?: OrderCommand;
  target?: number;
}

const item = (id: string, label: string, ok: boolean, reason?: string): InterlockItem => ({
  id,
  label,
  ok,
  ...(!ok && reason ? { reason } : {}),
});

/**
 * Enclavamientos (§14.3 punto 2). Orden = prioridad del error: module, enabled, online, idle y luego los del
 * comando. La UI sólo los muestra; la decisión es siempre del servidor.
 */
export function evaluateInterlocks(i: InterlockInput): InterlockItem[] {
  const cfg = controlConfigOf(i.asset);
  const items: InterlockItem[] = [
    item(
      'module',
      'Módulo de control contratado',
      i.moduleActive,
      'El cliente no tiene contratado el módulo de control',
    ),
    item(
      'enabled',
      'Control habilitado en el equipo',
      cfg.enabled,
      'El control no está habilitado para este equipo',
    ),
  ];
  const age = i.state ? i.now - i.state.ts : Infinity;
  items.push(
    item(
      'online',
      `Equipo con telemetría reciente (< ${CONTROL_LIMITS.telemetryMaxAgeMs / 1000} s)`,
      age < CONTROL_LIMITS.telemetryMaxAgeMs,
      i.state
        ? `El equipo no informa datos hace ${Math.round(age / 1000)} s`
        : 'El equipo no informa datos',
    ),
  );
  const busy = i.open[0];
  items.push(
    item(
      'idle',
      'Sin otra orden en curso',
      i.open.length === 0,
      busy ? `Hay una orden en curso (${busy.command}, ${busy.status})` : undefined,
    ),
  );

  const level = i.state?.values['level'];
  const tankLike = COMMANDS_BY_TYPE[i.asset.type]?.some((c) => LEVEL_COMMANDS.includes(c)) ?? false;
  // La alarma HH sólo impide llenar: vaciar y detener siguen permitidos.
  if (tankLike && (i.command === undefined || i.command === 'fill')) {
    items.push(
      item('no_hh', 'Sin alarma HH activa', !i.hhActive, 'Hay una alarma HH activa sobre el nivel'),
    );
  }
  if (i.command && LEVEL_COMMANDS.includes(i.command) && i.target !== undefined) {
    const { minTarget, maxTarget } = cfg;
    items.push(
      item(
        'target_range',
        `Objetivo entre ${minTarget} % y ${maxTarget} %`,
        i.target >= minTarget && i.target <= maxTarget,
        `El objetivo ${i.target} % queda fuera del rango permitido (${minTarget} % a ${maxTarget} %)`,
      ),
    );
    if (i.highLimit !== null) {
      const max = i.highLimit - CONTROL_LIMITS.hiMargin;
      items.push(
        item(
          'target_hi',
          `Objetivo por debajo del límite alto (${i.highLimit} %) menos ${CONTROL_LIMITS.hiMargin} %`,
          i.target <= max,
          `El objetivo ${i.target} % supera el máximo permitido por el límite alto (${max} %)`,
        ),
      );
    }
    if (i.command === 'fill') {
      items.push(
        item(
          'level_direction',
          'Nivel actual por debajo del objetivo',
          level !== undefined && level < i.target,
          level === undefined
            ? 'Sin lectura de nivel'
            : `El nivel actual (${level} %) ya alcanzó el objetivo`,
        ),
      );
    } else {
      items.push(
        item(
          'level_direction',
          'Nivel actual por encima del objetivo',
          level !== undefined && level > i.target,
          level === undefined
            ? 'Sin lectura de nivel'
            : `El nivel actual (${level} %) ya está en o bajo el objetivo`,
        ),
      );
    }
  }
  return items;
}

/**
 * Primer enclavamiento que bloquea el comando. `stop` se permite SIEMPRE (el paro nunca se bloquea por un
 * enclavamiento).
 */
export function firstBlock(
  items: readonly InterlockItem[],
  command?: OrderCommand,
): InterlockItem | null {
  if (command === 'stop') return null;
  return items.find((x) => !x.ok) ?? null;
}

/** Código de error HTTP (409) según el enclavamiento que bloquea. */
export function blockCode(
  id: string,
): 'device_offline' | 'order_in_progress' | 'interlock_blocked' {
  if (id === 'online') return 'device_offline';
  if (id === 'idle') return 'order_in_progress';
  return 'interlock_blocked';
}

/** Valida el comando contra el tipo de activo y su `target` (400 en español, o null). */
export function commandError(
  type: Asset['type'],
  command: OrderCommand,
  target?: number,
): string | null {
  const allowed = COMMANDS_BY_TYPE[type];
  if (!allowed) return `Un activo de tipo "${type}" no admite órdenes`;
  if (!allowed.includes(command)) {
    return `El comando "${command}" no es válido para un activo de tipo "${type}" (admitidos: ${allowed.join(', ')})`;
  }
  if (LEVEL_COMMANDS.includes(command)) {
    if (target === undefined) return `${command} requiere target (nivel objetivo en %)`;
    if (
      !Number.isFinite(target) ||
      target < CONTROL_LIMITS.targetMin ||
      target > CONTROL_LIMITS.targetMax
    ) {
      return `target debe estar entre ${CONTROL_LIMITS.targetMin} y ${CONTROL_LIMITS.targetMax} %`;
    }
  } else if (command === 'set_position') {
    if (target === undefined) return 'set_position requiere target (apertura 0-100 %)';
    if (!Number.isFinite(target) || target < 0 || target > 100)
      return 'target debe estar entre 0 y 100 %';
  } else if (target !== undefined) {
    return `El comando "${command}" no admite target`;
  }
  return null;
}
