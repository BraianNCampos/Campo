import { randomUUID } from 'node:crypto';
import type { AlarmEvent, TelemetryEvent } from '@campo/shared';
import {
  AlarmRule,
  Operator,
  ResolvedRule,
  SuppressWhen,
  clearedLifecycle,
  rationaleOf,
  resolveRule,
} from './alarm.types';
import { RocBuffer } from './roc-buffer';

const SYMBOL: Record<Operator, string> = { gt: '>', lt: '<', gte: '>=', lte: '<=' };

/** Topes de memoria: una planta no puede hacer crecer sin límite el estado del motor inventando activos. */
export const EVALUATOR_LIMITS = { maxTracks: 50_000, maxWatched: 5_000, maxMatchCache: 10_000 };

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

/** Compara el último valor de un activo con la condición de supresión. */
export function suppressHolds(s: Pick<SuppressWhen, 'operator' | 'value'>, v: unknown): boolean {
  if (typeof v !== 'number' || !Number.isFinite(v)) return false; // sin dato: no se suprime
  switch (s.operator) {
    case 'eq':
      return v === s.value;
    case 'neq':
      return v !== s.value;
    case 'gt':
      return v > s.value;
    case 'lt':
      return v < s.value;
  }
}

/** Una alarma que no se generó porque su condición de supresión se cumplía. */
export interface Suppression {
  plant: string;
  ruleId: string;
  asset: string;
  metric: string;
  value: number;
  ts: number;
}

interface Track {
  /** Instante en que la condición empezó a cumplirse (retardo de activación en curso). */
  pendingSince?: number;
  /** Instante en que la condición dejó de cumplirse (retardo de retorno en curso). */
  clearSince?: number;
  active?: AlarmEvent;
  /** El episodio de supresión en curso ya quedó registrado. */
  suppressed?: boolean;
  /** Último setpoint recibido por telemetría (`<métrica>_sp`). */
  sp?: number;
  roc?: RocBuffer;
}

interface CompiledRule {
  rule: ResolvedRule;
  assetRe: RegExp;
  suppressRe: RegExp | null;
  /** asset -> estado de la pareja (regla, activo). */
  tracks: Map<string, Track>;
}

interface PlantRules {
  rules: CompiledRule[];
  /** activo -> reglas que le aplican (memoiza la coincidencia de patrones). */
  matches: Map<string, CompiledRule[]>;
  /** Activos cuyo último dato interesa a alguna condición de supresión. */
  watchExact: Set<string>;
  watchPatterns: RegExp[];
}

const fmt = (n: number): number => Number(n.toFixed(3));

/**
 * Lógica pura del ciclo de vida de alarmas (sin E/S): HH/HI/LO/LL, DEV y ROC; retardo de activación
 * (`forSeconds`) y de retorno (`offDelaySeconds`), banda muerta, supresión por estado y transiciones
 * active -> cleared. El tiempo se inyecta (`now`, epoch ms) para poder testearla.
 *
 * Todo se reduce a una *magnitud* por muestra (valor, |valor - SP| o tasa de cambio) comparada con
 * `trips`/`clears`; el resto de la mecánica es común a los seis tipos.
 */
export class AlarmEvaluator {
  private byPlant = new Map<string, PlantRules>();
  private rulesById = new Map<string, ResolvedRule>();
  /** regla -> (activo -> estado). Sobrevive a `setRules` mientras la regla exista. */
  private trackMap = new Map<string, Map<string, Track>>();
  private trackCount = 0;
  /** id de alarma -> estado que la contiene. */
  private activeIndex = new Map<string, Track>();
  /** planta -> activo -> setpoints de `metadata.setpoints`. */
  private setpoints = new Map<string, Map<string, Record<string, number>>>();
  /** planta -> activo -> último dato (sólo activos observados por alguna supresión). */
  private lastValues = new Map<string, Map<string, Record<string, number>>>();
  private suppressions: Suppression[] = [];

  /** Sustituye las reglas. Devuelve eventos `cleared` de alarmas cuya regla ya no está activa. */
  setRules(rules: AlarmRule[], now: number): AlarmEvent[] {
    this.byPlant = new Map();
    this.rulesById = new Map();
    for (const raw of rules) {
      if (!raw.enabled) continue;
      const rule = resolveRule(raw);
      this.rulesById.set(rule.id, rule);
      let tracks = this.trackMap.get(rule.id);
      if (!tracks) this.trackMap.set(rule.id, (tracks = new Map<string, Track>()));
      const s = rule.suppressWhen;
      const compiled: CompiledRule = {
        rule,
        assetRe: compileAssetPattern(rule.asset),
        suppressRe: s && s.asset.includes('*') ? compileAssetPattern(s.asset) : null,
        tracks,
      };
      let pr = this.byPlant.get(rule.plant);
      if (!pr) {
        this.byPlant.set(
          rule.plant,
          (pr = { rules: [], matches: new Map(), watchExact: new Set(), watchPatterns: [] }),
        );
      }
      pr.rules.push(compiled);
      if (s) {
        if (compiled.suppressRe) pr.watchPatterns.push(compiled.suppressRe);
        else pr.watchExact.add(s.asset);
      }
    }
    return this.collectOrphans(now);
  }

  /** Carga alarmas activas persistidas (tras un reinicio). Devuelve las huérfanas a cerrar. */
  restore(alarms: AlarmEvent[], now: number): AlarmEvent[] {
    for (const a of alarms) {
      if (a.state !== 'active') continue;
      let tracks = this.trackMap.get(a.ruleId);
      if (!tracks) this.trackMap.set(a.ruleId, (tracks = new Map<string, Track>()));
      let t = tracks.get(a.asset);
      if (!t) {
        tracks.set(a.asset, (t = {}));
        this.trackCount++;
      }
      t.active = a;
      this.activeIndex.set(a.id, t);
    }
    return this.collectOrphans(now);
  }

  activeAlarms(): AlarmEvent[] {
    return [...this.activeIndex.values()].map((t) => t.active as AlarmEvent);
  }

  /** La alarma activa (en memoria) con ese id. */
  getActive(id: string): AlarmEvent | undefined {
    return this.activeIndex.get(id)?.active;
  }

  /** Sustituye campos de una alarma activa en memoria (reconocimiento, postergación...). */
  patchActive(id: string, patch: Partial<AlarmEvent>): void {
    const t = this.activeIndex.get(id);
    if (!t?.active) return;
    const next = { ...t.active, ...patch };
    for (const k of Object.keys(next) as (keyof AlarmEvent)[]) {
      if (next[k] === undefined) delete next[k];
    }
    t.active = next;
  }

  /** Marca localmente que una alarma fue reconocida (para que el evento de cierre lo refleje). */
  markAcknowledged(id: string): void {
    const cur = this.getActive(id);
    if (!cur) return;
    this.patchActive(id, {
      acknowledged: true,
      ...(cur.lifecycle === 'shelved' ? {} : { lifecycle: 'acked' as const }),
    });
  }

  /** Setpoints de `metadata.setpoints` de los activos de una planta (sustituye lo anterior). */
  setSetpoints(plant: string, byAsset: Map<string, Record<string, number>>): void {
    if (byAsset.size === 0) this.setpoints.delete(plant);
    else this.setpoints.set(plant, byAsset);
  }

  /** Setpoint recibido por telemetría (`<métrica>_sp`) para la pareja (regla, activo), si lo hay. */
  liveSetpoint(ruleId: string, asset: string): number | undefined {
    return this.trackMap.get(ruleId)?.get(asset)?.sp;
  }

  /** Setpoint con el que se evaluaría `metric` en `asset`: telemetría (prioridad) o metadata. */
  setpointFor(ruleId: string, plant: string, asset: string, metric: string): number | undefined {
    const live = this.trackMap.get(ruleId)?.get(asset)?.sp;
    return live ?? this.setpoints.get(plant)?.get(asset)?.[metric];
  }

  /** Siembra el último dato de un activo si aún no se conoce (arranque: se lee de Redis). */
  seedState(plant: string, asset: string, values: Record<string, number>): void {
    const m = this.lastFor(plant);
    if (!m.has(asset) && m.size < EVALUATOR_LIMITS.maxWatched) m.set(asset, values);
  }

  /** Supresiones ocurridas desde la última llamada (el motor las anota en el diario). */
  takeSuppressions(): Suppression[] {
    if (this.suppressions.length === 0) return this.suppressions;
    const out = this.suppressions;
    this.suppressions = [];
    return out;
  }

  evaluate(ev: TelemetryEvent, now: number): AlarmEvent[] {
    if (ev.quality === 'bad') return []; // un dato malo no debe disparar ni limpiar alarmas
    const pr = this.byPlant.get(ev.plant);
    if (!pr) return [];
    if (
      pr.watchExact.has(ev.asset) ||
      (pr.watchPatterns.length > 0 && this.watches(pr, ev.asset))
    ) {
      this.seedOrReplace(ev);
    }

    let rules = pr.matches.get(ev.asset);
    if (!rules) {
      rules = pr.rules.filter((c) => c.assetRe.test(ev.asset));
      if (pr.matches.size >= EVALUATOR_LIMITS.maxMatchCache) pr.matches.clear();
      pr.matches.set(ev.asset, rules);
    }
    if (rules.length === 0) return [];

    const out: AlarmEvent[] = [];
    for (const c of rules) {
      const alarm = this.step(c, ev, now);
      if (alarm) out.push(alarm);
    }
    return out;
  }

  /** Una muestra para una regla. Devuelve la transición que provoca, si hay. */
  private step(c: CompiledRule, ev: TelemetryEvent, now: number): AlarmEvent | null {
    const { rule } = c;
    const value = ev.values[rule.metric];
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;

    let track = c.tracks.get(ev.asset);
    const needsState = rule.kind === 'ROC' || rule.kind === 'DEV';
    if (!track && needsState) track = this.newTrack(c, ev.asset);

    // Magnitud comparada con el umbral y datos para el mensaje
    let measure = value;
    let sp: number | undefined;
    if (rule.kind === 'DEV') {
      const tel = ev.values[`${rule.metric}_sp`];
      if (typeof tel === 'number' && Number.isFinite(tel) && track) track.sp = tel;
      sp = track?.sp ?? this.setpoints.get(ev.plant)?.get(ev.asset)?.[rule.metric];
      if (sp === undefined) return null; // sin SP la regla no se evalúa
      measure = Math.abs(value - sp);
    } else if (rule.kind === 'ROC') {
      if (!track) return null; // tope de memoria alcanzado
      const buf = (track.roc ??= new RocBuffer());
      const rate = buf.push(now, value, rule.rocWindowSeconds * 1000);
      if (rate === undefined) return null; // ventana aún sin cobertura suficiente
      measure =
        rule.rocDirection === 'rise' ? rate : rule.rocDirection === 'fall' ? -rate : Math.abs(rate);
    }

    const current = track?.active;
    if (current && track) {
      if (!clears(rule, measure)) {
        track.clearSince = undefined;
        return null;
      }
      const since = track.clearSince ?? now;
      track.clearSince = since;
      if (now - since < rule.offDelaySeconds * 1000) return null;
      this.endTrack(c, ev.asset, track, current.id);
      return {
        ...stripShelf(current),
        state: 'cleared',
        value: measure,
        ts: now,
        message: this.message(rule, ev.asset, measure, value, sp, 'cleared'),
        lifecycle: clearedLifecycle(current),
      };
    }

    if (!trips(rule, measure)) {
      if (track) {
        track.pendingSince = undefined;
        track.suppressed = false;
        if (!needsState && !track.active) this.dropTrack(c, ev.asset);
      }
      return null;
    }

    track ??= this.newTrack(c, ev.asset);
    if (!track) return null;

    if (rule.suppressWhen && this.isSuppressed(rule.suppressWhen, c.suppressRe, ev.plant)) {
      track.pendingSince = undefined;
      if (!track.suppressed) {
        track.suppressed = true;
        this.suppressions.push({
          plant: rule.plant,
          ruleId: rule.id,
          asset: ev.asset,
          metric: rule.metric,
          value: measure,
          ts: now,
        });
      }
      return null;
    }
    track.suppressed = false;

    const since = track.pendingSince ?? now;
    track.pendingSince = since;
    if (now - since < rule.forSeconds * 1000) return null;
    track.pendingSince = undefined;

    const rationale = rationaleOf(rule);
    const alarm: AlarmEvent = {
      type: 'alarm',
      id: randomUUID(),
      ruleId: rule.id,
      plant: rule.plant,
      asset: ev.asset,
      metric: rule.metric,
      severity: rule.severity,
      state: 'active',
      value: measure,
      threshold: rule.threshold,
      ts: now,
      message: this.message(rule, ev.asset, measure, value, sp, 'active'),
      acknowledged: false,
      kind: rule.kind,
      lifecycle: 'unacked',
      ...(rationale ? { rationale } : {}),
    };
    track.active = alarm;
    track.clearSince = undefined;
    this.activeIndex.set(alarm.id, track);
    return alarm;
  }

  private newTrack(c: CompiledRule, asset: string): Track | undefined {
    if (this.trackCount >= EVALUATOR_LIMITS.maxTracks) return undefined;
    const t: Track = {};
    c.tracks.set(asset, t);
    this.trackCount++;
    return t;
  }

  private dropTrack(c: CompiledRule, asset: string): void {
    if (c.tracks.delete(asset)) this.trackCount--;
  }

  /** La alarma terminó: se libera su estado (salvo el que necesitan DEV/ROC). */
  private endTrack(c: CompiledRule, asset: string, track: Track, alarmId: string): void {
    this.activeIndex.delete(alarmId);
    track.active = undefined;
    track.clearSince = undefined;
    track.pendingSince = undefined;
    track.suppressed = false;
    if (!track.roc && track.sp === undefined) this.dropTrack(c, asset);
  }

  private watches(pr: PlantRules, asset: string): boolean {
    return pr.watchPatterns.some((re) => re.test(asset));
  }

  private lastFor(plant: string): Map<string, Record<string, number>> {
    let m = this.lastValues.get(plant);
    if (!m) this.lastValues.set(plant, (m = new Map<string, Record<string, number>>()));
    return m;
  }

  private seedOrReplace(ev: TelemetryEvent): void {
    const m = this.lastFor(ev.plant);
    if (m.has(ev.asset) || m.size < EVALUATOR_LIMITS.maxWatched) m.set(ev.asset, ev.values);
  }

  /** Condición de supresión sobre el último dato conocido (sin dato = no suprime). */
  private isSuppressed(s: SuppressWhen, re: RegExp | null, plant: string): boolean {
    const known = this.lastValues.get(plant);
    if (!known) return false;
    if (!re) return suppressHolds(s, known.get(s.asset)?.[s.metric]);
    for (const [asset, values] of known) {
      if (re.test(asset) && suppressHolds(s, values[s.metric])) return true;
    }
    return false;
  }

  private collectOrphans(now: number): AlarmEvent[] {
    const out: AlarmEvent[] = [];
    for (const [ruleId, tracks] of this.trackMap) {
      if (this.rulesById.has(ruleId)) continue;
      for (const t of tracks.values()) {
        const a = t.active;
        if (!a) continue;
        this.activeIndex.delete(a.id);
        out.push({
          ...stripShelf(a),
          state: 'cleared',
          ts: now,
          message: `${a.asset}: ${a.metric} — regla eliminada o deshabilitada`,
          lifecycle: 'closed',
        });
      }
      this.trackCount -= tracks.size;
      this.trackMap.delete(ruleId);
    }
    return out;
  }

  private message(
    rule: ResolvedRule,
    asset: string,
    measure: number,
    value: number,
    sp: number | undefined,
    state: 'active' | 'cleared',
  ): string {
    const op = SYMBOL[rule.operator];
    if (rule.kind === 'DEV') {
      const cond = `|${rule.metric} - SP ${sp}| ${op} ${rule.threshold}`;
      return state === 'active'
        ? `${asset}: ${rule.metric} se desvía ${fmt(measure)} del SP ${sp} (valor ${value}, límite ${rule.threshold})`
        : `${asset}: ${rule.metric} vuelve al SP ${sp} (valor ${value}, umbral ${cond})`;
    }
    if (rule.kind === 'ROC') {
      return state === 'active'
        ? `${asset}: ${rule.metric} cambia ${fmt(measure)}/min (límite ${rule.threshold}/min)`
        : `${asset}: ${rule.metric} estable (${fmt(measure)}/min, umbral ${rule.threshold}/min)`;
    }
    const cond = `${rule.metric} ${op} ${rule.threshold}`;
    return state === 'active'
      ? `${asset}: ${cond} (valor ${value})`
      : `${asset}: ${rule.metric} normalizado (valor ${value}, umbral ${cond})`;
  }
}

/** Una alarma que se normaliza deja de estar postergada. */
function stripShelf(a: AlarmEvent): AlarmEvent {
  const { shelvedUntil, shelvedReason, ...rest } = a;
  void shelvedUntil;
  void shelvedReason;
  return rest;
}
