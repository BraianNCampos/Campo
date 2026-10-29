import { randomUUID } from 'node:crypto';
import type { AlarmEvent, TelemetryEvent } from '@campo/shared';
import type { AlarmRule, Operator } from './alarm.types';

const SYMBOL: Record<Operator, string> = { gt: '>', lt: '<', gte: '>=', lte: '<=' };

interface CompiledRule {
  rule: AlarmRule;
  assetRe: RegExp;
}

/** Convierte un patrón con `*` en regex anclada (el resto de caracteres se escapa). */
export function compileAssetPattern(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

export function trips(rule: Pick<AlarmRule, 'operator' | 'threshold'>, v: number): boolean {
  switch (rule.operator) {
    case 'gt':
      return v > rule.threshold;
    case 'gte':
      return v >= rule.threshold;
    case 'lt':
      return v < rule.threshold;
    case 'lte':
      return v <= rule.threshold;
  }
}

/** Con histéresis 0 equivale a "la condición ya no se cumple". */
export function clears(
  rule: Pick<AlarmRule, 'operator' | 'threshold' | 'hysteresis'>,
  v: number,
): boolean {
  const { threshold: t, hysteresis: h } = rule;
  switch (rule.operator) {
    case 'gt':
      return v <= t - h;
    case 'gte':
      return v < t - h;
    case 'lt':
      return v >= t + h;
    case 'lte':
      return v > t + h;
  }
}

const key = (ruleId: string, asset: string) => `${ruleId}|${asset}`;

/**
 * Lógica pura del ciclo de vida de alarmas (sin E/S): debounce (`forSeconds`), histéresis y
 * transiciones active -> cleared. El tiempo se inyecta (`now`, epoch ms) para poder testearla.
 */
export class AlarmEvaluator {
  private byPlant = new Map<string, CompiledRule[]>();
  private rulesById = new Map<string, AlarmRule>();
  /** (regla, activo) -> instante en que la condición empezó a cumplirse (debounce en curso). */
  private pending = new Map<string, number>();
  /** (regla, activo) -> alarma activa. */
  private active = new Map<string, AlarmEvent>();

  /** Sustituye las reglas. Devuelve eventos `cleared` de alarmas cuya regla ya no está activa. */
  setRules(rules: AlarmRule[], now: number): AlarmEvent[] {
    this.byPlant = new Map();
    this.rulesById = new Map();
    for (const rule of rules) {
      if (!rule.enabled) continue;
      this.rulesById.set(rule.id, rule);
      const list = this.byPlant.get(rule.plant) ?? [];
      list.push({ rule, assetRe: compileAssetPattern(rule.asset) });
      this.byPlant.set(rule.plant, list);
    }
    for (const k of this.pending.keys()) {
      if (!this.rulesById.has(k.split('|')[0])) this.pending.delete(k);
    }
    return this.collectOrphans(now);
  }

  /** Carga alarmas activas persistidas (tras un reinicio). Devuelve las huérfanas a cerrar. */
  restore(alarms: AlarmEvent[], now: number): AlarmEvent[] {
    for (const a of alarms) {
      if (a.state === 'active') this.active.set(key(a.ruleId, a.asset), a);
    }
    return this.collectOrphans(now);
  }

  activeAlarms(): AlarmEvent[] {
    return [...this.active.values()];
  }

  /** Marca localmente que una alarma fue reconocida (para que el evento de cierre lo refleje). */
  markAcknowledged(id: string): void {
    for (const [k, a] of this.active) {
      if (a.id === id) this.active.set(k, { ...a, acknowledged: true });
    }
  }

  evaluate(ev: TelemetryEvent, now: number): AlarmEvent[] {
    if (ev.quality === 'bad') return []; // un dato malo no debe disparar ni limpiar alarmas
    const rules = this.byPlant.get(ev.plant);
    if (!rules) return [];

    const out: AlarmEvent[] = [];
    for (const { rule, assetRe } of rules) {
      if (!assetRe.test(ev.asset)) continue;
      const value = ev.values[rule.metric];
      if (typeof value !== 'number' || !Number.isFinite(value)) continue;

      const k = key(rule.id, ev.asset);
      const current = this.active.get(k);

      if (current) {
        if (clears(rule, value)) {
          this.active.delete(k);
          out.push({
            ...current,
            state: 'cleared',
            value,
            ts: now,
            message: this.message(rule, ev.asset, value, 'cleared'),
          });
        }
        continue;
      }

      if (!trips(rule, value)) {
        this.pending.delete(k);
        continue;
      }
      const since = this.pending.get(k) ?? now;
      this.pending.set(k, since);
      if (now - since < rule.forSeconds * 1000) continue;

      this.pending.delete(k);
      const alarm: AlarmEvent = {
        type: 'alarm',
        id: randomUUID(),
        ruleId: rule.id,
        plant: rule.plant,
        asset: ev.asset,
        metric: rule.metric,
        severity: rule.severity,
        state: 'active',
        value,
        threshold: rule.threshold,
        ts: now,
        message: this.message(rule, ev.asset, value, 'active'),
        acknowledged: false,
      };
      this.active.set(k, alarm);
      out.push(alarm);
    }
    return out;
  }

  private collectOrphans(now: number): AlarmEvent[] {
    const out: AlarmEvent[] = [];
    for (const [k, a] of this.active) {
      if (this.rulesById.has(a.ruleId)) continue;
      this.active.delete(k);
      out.push({
        ...a,
        state: 'cleared',
        ts: now,
        message: `${a.asset}: ${a.metric} — regla eliminada o deshabilitada`,
      });
    }
    return out;
  }

  private message(rule: AlarmRule, asset: string, value: number, state: 'active' | 'cleared') {
    const cond = `${rule.metric} ${SYMBOL[rule.operator]} ${rule.threshold}`;
    return state === 'active'
      ? `${asset}: ${cond} (valor ${value})`
      : `${asset}: ${rule.metric} normalizado (valor ${value}, umbral ${cond})`;
  }
}
