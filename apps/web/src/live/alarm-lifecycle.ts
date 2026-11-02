import { DEFAULT_ALARM_POLICY, METRICS, type AlarmEvent, type AlarmKind, type AlarmKpis, type AlarmPolicy, type AlarmRationale, type Limit, type Severity } from '@campo/shared';
import { DEMO_ASSETS, DEMO_LIMITS } from '@/lib/demo-seed';
import type { AlarmJournalEntry, JournalEvent } from '@/lib/admin/alarms-api';

/**
 * Motor de alarmas del modo demo (docs/architecture.md §12.2): implementa el ciclo de vida ISA-18.2 sobre la telemetría
 * simulada. Activar (tras un retardo) → sin reconocer → reconocida → normalizar (banda muerta + retardo) → cerrada;
 * normalizar sin reconocer → «normalizada sin reconocer» hasta reconocer. Postergar con vencimiento, supresión por
 * estado, DEV (desviación del setpoint) y ROC (tasa de cambio). Sin reloj propio: todo recibe `now`.
 */

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WINDOW_MS = { '24h': DAY, '7d': 7 * DAY, '30d': 30 * DAY } as const;

export type SuppressOp = 'eq' | 'neq' | 'gt' | 'lt';
export interface Suppression {
  asset: string;
  metric: string;
  operator: SuppressOp;
  value: number;
}

export interface DemoRule {
  id: string;
  asset: string;
  metric: string;
  kind: AlarmKind;
  severity: Severity;
  /** HH/HI/DEV/ROC se activan por arriba del umbral, LO/LL por debajo */
  operator: 'gt' | 'lt';
  threshold: number;
  /** banda muerta: cuánto hay que volver antes de normalizar */
  deadband: number;
  onDelayS: number;
  offDelayS: number;
  setpoint?: number;
  rocWindowS?: number;
  rocDirection?: 'any' | 'rise' | 'fall';
  suppressWhen?: Suppression;
  rationale: AlarmRationale;
}

export function suppressionMet(s: Suppression, v: number | undefined): boolean {
  if (v === undefined) return false;
  return s.operator === 'eq' ? v === s.value : s.operator === 'neq' ? v !== s.value : s.operator === 'gt' ? v > s.value : v < s.value;
}

// ── Reglas de la demo ──

const DEADBAND: Record<string, number> = { level: 2, temp: 1, humidity: 2, kw: 3, pressure: 0.2 };
const DEMO_DELAY_S = 2;

export const kindOfLimit = (operator: Limit['operator'], severity: Severity): AlarmKind =>
  operator === 'gt' || operator === 'gte' ? (severity === 'critical' ? 'HH' : 'HI') : severity === 'critical' ? 'LL' : 'LO';

const assetName = (plant: string, id: string) => DEMO_ASSETS[plant]?.find((a) => a.id === id)?.name ?? id;

const RATIONALE: Record<string, { text: string; consequence: string; response: string }> = {
  'level:high': { text: 'Nivel alto', consequence: 'Riesgo de rebalse del tanque y pérdida de producto.', response: 'Cerrá la válvula de entrada, detené la bomba de carga y verificá el nivel en campo.' },
  'level:low': { text: 'Nivel bajo', consequence: 'La bomba de salida puede cavitar y se interrumpe el abastecimiento.', response: 'Revisá la entrada al tanque y, si sigue bajando, detené la bomba de descarga.' },
  'temp:high': { text: 'Temperatura alta', consequence: 'El producto o los insumos pueden degradarse fuera de rango.', response: 'Verificá la climatización o el aislamiento y avisá a mantenimiento si no baja.' },
  'humidity:high': { text: 'Humedad alta', consequence: 'Riesgo de condensación y deterioro de insumos almacenados.', response: 'Revisá el deshumidificador y las puertas de la cámara.' },
  'kw:high': { text: 'Potencia alta', consequence: 'Se acerca a la potencia contratada: riesgo de penalidad o disparo de protecciones.', response: 'Desconectá cargas no críticas o escalonar el arranque de equipos.' },
  'pressure:high': { text: 'Presión alta', consequence: 'Riesgo de sobrepresión en la línea y apertura de válvulas de seguridad.', response: 'Reducí la generación y verificá la válvula de alivio.' },
  'pressure:low': { text: 'Presión baja', consequence: 'Los equipos neumáticos pueden dejar de funcionar correctamente.', response: 'Revisá fugas y el estado de los compresores.' },
};

function rationaleFor(plant: string, rule: Pick<DemoRule, 'asset' | 'metric' | 'kind' | 'threshold' | 'setpoint'>): AlarmRationale {
  const name = assetName(plant, rule.asset);
  if (rule.kind === 'DEV') {
    return {
      description: `${METRICS[rule.metric]?.label ?? rule.metric} de ${name} desviada del setpoint (${rule.setpoint}).`,
      consequence: 'El lazo no logra mantener el valor deseado: puede afectar la calidad del proceso.',
      response: 'Comprobá el lazo de control y el elemento final; pasá a manual si no recupera.',
    };
  }
  if (rule.kind === 'ROC') {
    return {
      description: `${METRICS[rule.metric]?.label ?? rule.metric} de ${name} cambia demasiado rápido.`,
      consequence: 'Un cambio brusco suele indicar una falla de equipo, una fuga o un sensor defectuoso.',
      response: 'Inspeccioná el equipo en campo y confirmá la lectura con otro instrumento.',
    };
  }
  const high = rule.kind === 'HH' || rule.kind === 'HI';
  const key = `${rule.metric}:${high ? 'high' : 'low'}`;
  const r = RATIONALE[key];
  if (!r) {
    return { description: `${METRICS[rule.metric]?.label ?? rule.metric} ${high ? 'alto' : 'bajo'} en ${name}.`, consequence: 'Valor fuera del rango de operación.', response: 'Verificá el equipo en campo.' };
  }
  const level = rule.kind === 'HH' || rule.kind === 'LL' ? 'muy ' : '';
  return { description: `${r.text.replace(/ (alto|alta|bajo|baja)$/, ` ${level}$1`)} en ${name}.`, consequence: r.consequence, response: r.response };
}

function demoRule(plant: string, p: Omit<DemoRule, 'id' | 'rationale' | 'onDelayS' | 'offDelayS'> & Partial<Pick<DemoRule, 'onDelayS' | 'offDelayS'>>): DemoRule {
  const base = { onDelayS: DEMO_DELAY_S, offDelayS: DEMO_DELAY_S, ...p };
  return { ...base, id: `${p.asset}:${p.metric}:${p.kind}`, rationale: rationaleFor(plant, p) };
}

/** Reglas de la demo: las de `DEMO_LIMITS` (HH/HI/LO/LL) más desviación, tasa de cambio y una supresión de ejemplo. */
export function buildDemoRules(plant: string): DemoRule[] {
  const rules: DemoRule[] = [];
  for (const l of DEMO_LIMITS[plant] ?? []) {
    const kind = kindOfLimit(l.operator, l.severity);
    rules.push(
      demoRule(plant, {
        asset: l.asset, metric: l.metric, kind, severity: l.severity,
        operator: l.operator === 'gt' || l.operator === 'gte' ? 'gt' : 'lt',
        threshold: l.threshold,
        deadband: DEADBAND[l.metric] ?? Math.max(Math.abs(l.threshold) * 0.02, 0.3),
        // la advertencia de nivel bajo de los tanques de origen se suprime con la bomba detenida (ejemplo de §12.1)
        suppressWhen: plant === 'demo' && l.metric === 'level' && kind === 'LO' && (l.asset === 'tk-01' || l.asset === 'tk-02')
          ? { asset: l.asset === 'tk-01' ? 'pump-01' : 'pump-02', metric: 'rpm', operator: 'lt', value: 1 }
          : undefined,
      }),
    );
  }
  if (plant === 'demo') {
    for (const id of ['clima-01', 'clima-02']) rules.push(demoRule(plant, { asset: id, metric: 'temp', kind: 'DEV', severity: 'warning', operator: 'gt', threshold: 6, deadband: 1, setpoint: 20 }));
    rules.push(demoRule(plant, { asset: 'pres-01', metric: 'pressure', kind: 'DEV', severity: 'warning', operator: 'gt', threshold: 1.5, deadband: 0.2, setpoint: 6 }));
    rules.push(demoRule(plant, { asset: 'pres-01', metric: 'pressure', kind: 'ROC', severity: 'warning', operator: 'gt', threshold: 2, deadband: 0, rocWindowS: 30, rocDirection: 'rise' }));
    for (const id of ['tk-01', 'tk-02', 'tk-03', 'tk-04']) rules.push(demoRule(plant, { asset: id, metric: 'level', kind: 'ROC', severity: 'warning', operator: 'gt', threshold: 15, deadband: 0, rocWindowS: 60, rocDirection: 'any' }));
  }
  return rules;
}

// ── KPIs (pura, también la usa el cliente mock) ──

export interface ActivationRecord {
  ts: number;
  key: string;
  asset: string;
  metric: string;
  kind: AlarmKind;
  severity: Severity;
}

export interface KpiInput {
  activations: readonly ActivationRecord[];
  /** alarmas activas ahora (para «estancadas») */
  active: readonly { id: string; asset: string; metric: string; since: number }[];
  shelved: number;
  suppressed: number;
  outOfService: number;
  policy: AlarmPolicy;
  window: AlarmKpis['window'];
  now: number;
}

/** Mayor número de elementos de `ts` (ordenados) dentro de una ventana deslizante de `spanMs`; `at` = inicio de esa ventana. */
export function peakInWindow(ts: readonly number[], spanMs: number): { count: number; at: number | null } {
  let best = 0;
  let at: number | null = null;
  let j = 0;
  for (let i = 0; i < ts.length; i++) {
    while (ts[i]! - ts[j]! >= spanMs) j++;
    if (i - j + 1 > best) {
      best = i - j + 1;
      at = ts[j]!;
    }
  }
  return { count: best, at };
}

export function computeKpis(i: KpiInput): AlarmKpis {
  const span = WINDOW_MS[i.window];
  const from = i.now - span;
  const inWin = i.activations.filter((a) => a.ts >= from && a.ts <= i.now).sort((a, b) => a.ts - b.ts);
  const total = inWin.length;
  const perHour = total / (span / HOUR);
  const perDay = total / (span / DAY);
  const peak10min = peakInWindow(inWin.map((a) => a.ts), 10 * MIN);

  const groups = new Map<string, ActivationRecord[]>();
  for (const a of inWin) groups.set(a.key, [...(groups.get(a.key) ?? []), a]);
  const top = [...groups.values()]
    .map((g) => ({ ruleId: g[0]!.key, asset: g[0]!.asset, metric: g[0]!.metric, kind: g[0]!.kind, count: g.length }))
    .sort((a, b) => b.count - a.count || a.ruleId.localeCompare(b.ruleId))
    .slice(0, 10);
  const chattering = [...groups.values()]
    .map((g) => ({ g, p: peakInWindow(g.map((a) => a.ts), 10 * MIN) }))
    .filter((x) => x.p.count >= 3)
    .map((x) => ({ ruleId: x.g[0]!.key, asset: x.g[0]!.asset, metric: x.g[0]!.metric, activations10min: x.p.count }))
    .sort((a, b) => b.activations10min - a.activations10min);
  const stale = i.active
    .filter((a) => i.now - a.since > i.policy.staleHours * HOUR)
    .map((a) => ({ id: a.id, asset: a.asset, metric: a.metric, since: a.since }))
    .sort((a, b) => a.since - b.since);

  const ratio = Math.max(perDay / i.policy.ratePerDay, peak10min.count / i.policy.peak10min);
  return {
    window: i.window,
    from,
    to: i.now,
    policy: i.policy,
    total,
    perDay: Math.round(perDay * 10) / 10,
    perHour: Math.round(perHour * 100) / 100,
    peak10min,
    byPriority: { critical: inWin.filter((a) => a.severity === 'critical').length, warning: inWin.filter((a) => a.severity === 'warning').length },
    top,
    chattering,
    stale,
    shelved: i.shelved,
    suppressed: i.suppressed,
    outOfService: i.outOfService,
    status: ratio <= 1 ? 'ok' : ratio <= 1.5 ? 'warning' : 'critical',
  };
}

// ── Motor ──

interface Rec {
  ev: AlarmEvent;
  rule: DemoRule;
  activatedAt: number;
  /** la condición sigue cumpliéndose (solo importa mientras está postergada) */
  condMet: boolean;
}

interface RuleState {
  condSince: number | null;
  clearSince: number | null;
  rec: Rec | null;
  suppressedNow: boolean;
  samples: { ts: number; v: number }[];
}

export class AlarmError extends Error {
  constructor(
    readonly status: 404 | 409,
    message: string,
  ) {
    super(message);
  }
}

export interface EngineOptions {
  plant: string;
  rules?: DemoRule[];
  emit?: (ev: AlarmEvent) => void;
  /** correo de quien actúa cuando no se indica (para el diario) */
  actor?: string;
}

const LISTED = new Set(['unacked', 'acked', 'rtn_unacked']);

export class AlarmEngine {
  readonly plant: string;
  readonly rules: DemoRule[];
  private states = new Map<string, RuleState>();
  private recs = new Map<string, Rec>();
  private journals = new Map<string, AlarmJournalEntry[]>();
  private activations: ActivationRecord[] = [];
  private suppressions: number[] = [];
  private last = new Map<string, Record<string, number>>();
  private overrides = new Map<string, number>();
  private seq = 0;
  private skew = 0;
  private policy: AlarmPolicy = { ...DEFAULT_ALARM_POLICY };
  emit: (ev: AlarmEvent) => void;

  constructor(opts: EngineOptions) {
    this.plant = opts.plant;
    this.rules = opts.rules ?? buildDemoRules(opts.plant);
    this.emit = opts.emit ?? (() => {});
    for (const r of this.rules) this.states.set(r.id, { condSince: null, clearSince: null, rec: null, suppressedNow: false, samples: [] });
  }

  // ── reloj y entradas ──

  /** Adelanta el reloj interno (solo para pruebas y demos: envejece alarmas para ver las «estancadas»). */
  advance(ms: number) {
    this.skew += ms;
  }
  private t(now: number) {
    return now + this.skew;
  }

  override(asset: string, metric: string, value: number | null) {
    const k = `${asset}:${metric}`;
    if (value === null) this.overrides.delete(k);
    else this.overrides.set(k, value);
  }

  private value(asset: string, metric: string): number | undefined {
    return this.overrides.get(`${asset}:${metric}`) ?? this.last.get(asset)?.[metric];
  }

  /** Alimenta con telemetría de un activo y evalúa sus reglas (y las que dependen de él por supresión). */
  ingest(asset: string, values: Record<string, number>) {
    this.last.set(asset, { ...this.last.get(asset), ...values });
  }

  /** Evalúa todas las reglas y vence las postergaciones. Se llama una vez por tick. */
  step(now: number) {
    const t = this.t(now);
    for (const rec of [...this.recs.values()]) {
      if (rec.ev.lifecycle === 'shelved' && rec.ev.shelvedUntil !== undefined && t >= rec.ev.shelvedUntil) this.expireShelve(rec, t);
    }
    for (const rule of this.rules) this.evaluate(rule, t);
  }

  // ── evaluación ──

  private rate(rule: DemoRule, st: RuleState, v: number, t: number): number | null {
    const win = (rule.rocWindowS ?? 60) * 1000;
    st.samples.push({ ts: t, v });
    while (st.samples.length > 1 && t - st.samples[0]!.ts > win) st.samples.shift();
    const first = st.samples[0]!;
    const span = t - first.ts;
    if (span < win * 0.5) return null; // todavía no hay ventana suficiente
    return ((v - first.v) / span) * MIN;
  }

  private evaluate(rule: DemoRule, t: number) {
    const v = this.value(rule.asset, rule.metric);
    if (v === undefined) return;
    const st = this.states.get(rule.id)!;
    let cond: boolean;
    let clear: boolean;
    if (rule.kind === 'ROC') {
      const r = this.rate(rule, st, v, t);
      const mag = r === null ? 0 : rule.rocDirection === 'rise' ? r : rule.rocDirection === 'fall' ? -r : Math.abs(r);
      cond = r !== null && mag > rule.threshold;
      clear = !cond;
    } else if (rule.kind === 'DEV') {
      const dev = Math.abs(v - (rule.setpoint ?? 0));
      cond = dev > rule.threshold;
      clear = dev <= rule.threshold - rule.deadband;
    } else if (rule.operator === 'gt') {
      cond = v > rule.threshold;
      clear = v <= rule.threshold - rule.deadband;
    } else {
      cond = v < rule.threshold;
      clear = v >= rule.threshold + rule.deadband;
    }

    const rec = st.rec;
    if (!rec) {
      if (!cond) {
        st.condSince = null;
        st.suppressedNow = false;
        return;
      }
      if (rule.suppressWhen && suppressionMet(rule.suppressWhen, this.value(rule.suppressWhen.asset, rule.suppressWhen.metric))) {
        if (!st.suppressedNow) this.suppressions.push(t);
        st.suppressedNow = true;
        st.condSince = null;
        return;
      }
      st.suppressedNow = false;
      st.condSince ??= t;
      if (t - st.condSince >= rule.onDelayS * 1000) this.activate(rule, st, v, t);
      return;
    }

    rec.condMet = cond || !clear;
    const life = rec.ev.lifecycle;
    if (life === 'shelved') return; // se resuelve al vencer
    if (life === 'rtn_unacked') {
      // volvió a cumplirse antes de reconocerla: se anuncia otra vez
      if (cond) {
        st.condSince ??= t;
        if (t - st.condSince >= rule.onDelayS * 1000) this.reannounce(rec, st, v, t);
      } else st.condSince = null;
      return;
    }
    // activa (sin reconocer o reconocida)
    if (clear) {
      st.clearSince ??= t;
      if (t - st.clearSince >= rule.offDelayS * 1000) this.normalize(rec, st, v, t);
    } else st.clearSince = null;
  }

  private text(rule: DemoRule, v: number): string {
    const m = METRICS[rule.metric];
    const unit = m?.unit ? ` ${m.unit}` : '';
    const d = m?.decimals ?? 1;
    const name = assetName(this.plant, rule.asset);
    const base = rule.rationale.description?.replace(/\.$/, '') ?? `${m?.label ?? rule.metric} fuera de límite en ${name}`;
    const lim = rule.kind === 'DEV' ? `desvío máx. ${rule.threshold}${unit}` : rule.kind === 'ROC' ? `máx. ${rule.threshold}${unit}/min` : `límite ${rule.threshold}${unit}`;
    return `${base}: ${v.toFixed(d)}${unit} (${lim})`;
  }

  private log(id: string, event: JournalEvent, t: number, actor: string | null, detail?: string, value?: number) {
    const list = this.journals.get(id) ?? [];
    list.push({ ts: t, event, actor, ...(detail ? { detail } : {}), ...(value !== undefined ? { value } : {}) });
    this.journals.set(id, list);
  }

  private publish(rec: Rec) {
    this.emit({ ...rec.ev, ...(rec.ev.rationale ? { rationale: { ...rec.ev.rationale } } : {}) });
  }

  private activate(rule: DemoRule, st: RuleState, v: number, t: number) {
    const id = `alm-${this.plant}-${++this.seq}`;
    const ev: AlarmEvent = {
      type: 'alarm', id, ruleId: rule.id, plant: this.plant, asset: rule.asset, metric: rule.metric, severity: rule.severity,
      state: 'active', value: round(v), threshold: rule.threshold, ts: t, message: this.text(rule, v),
      acknowledged: false, kind: rule.kind, lifecycle: 'unacked', rationale: { ...rule.rationale },
    };
    const rec: Rec = { ev, rule, activatedAt: t, condMet: true };
    st.rec = rec;
    st.condSince = null;
    st.clearSince = null;
    this.recs.set(id, rec);
    this.activations.push({ ts: t, key: rule.id, asset: rule.asset, metric: rule.metric, kind: rule.kind, severity: rule.severity });
    this.log(id, 'activated', t, null, undefined, round(v));
    this.publish(rec);
  }

  private reannounce(rec: Rec, st: RuleState, v: number, t: number) {
    rec.ev = { ...rec.ev, state: 'active', lifecycle: 'unacked', acknowledged: false, value: round(v), ts: t, message: this.text(rec.rule, v) };
    rec.activatedAt = t;
    st.condSince = null;
    st.clearSince = null;
    this.activations.push({ ts: t, key: rec.rule.id, asset: rec.rule.asset, metric: rec.rule.metric, kind: rec.rule.kind, severity: rec.rule.severity });
    this.log(rec.ev.id, 'reannounced', t, null, 'La condición volvió a cumplirse antes de reconocer', round(v));
    this.publish(rec);
  }

  private normalize(rec: Rec, st: RuleState, v: number, t: number) {
    st.clearSince = null;
    const acked = rec.ev.lifecycle === 'acked';
    rec.ev = { ...rec.ev, state: 'cleared', lifecycle: acked ? 'closed' : 'rtn_unacked', value: round(v), ts: t, clearedAt: t } as AlarmEvent;
    this.log(rec.ev.id, 'cleared', t, null, undefined, round(v));
    if (acked) this.finish(rec, st, t, null);
    this.publish(rec);
  }

  private finish(rec: Rec, st: RuleState | undefined, t: number, actor: string | null) {
    if (actor !== null) this.log(rec.ev.id, 'closed', t, actor);
    if (st && st.rec === rec) st.rec = null;
  }

  private expireShelve(rec: Rec, t: number) {
    const st = this.states.get(rec.rule.id)!;
    this.log(rec.ev.id, 'unshelved', t, null, 'Venció la postergación');
    this.resume(rec, st, t);
  }

  /** Fin de la postergación: si la condición sigue, se reanuncia; si no, se cierra. */
  private resume(rec: Rec, st: RuleState, t: number) {
    const v = this.value(rec.rule.asset, rec.rule.metric) ?? rec.ev.value;
    const { shelvedUntil: _u, shelvedReason: _r, ...rest } = rec.ev;
    void _u;
    void _r;
    if (rec.condMet) {
      rec.ev = { ...rest, state: 'active', lifecycle: 'unacked', acknowledged: false, value: round(v), ts: t, message: this.text(rec.rule, v) };
      rec.activatedAt = t;
      st.clearSince = null;
    } else {
      rec.ev = { ...rest, state: 'cleared', lifecycle: 'closed', value: round(v), ts: t };
      this.log(rec.ev.id, 'cleared', t, null, 'Normalizó mientras estaba postergada', round(v));
      this.finish(rec, st, t, null);
    }
    this.publish(rec);
  }

  // ── acciones del usuario ──

  private rec(id: string): Rec {
    const r = this.recs.get(id);
    if (!r) throw new AlarmError(404, 'Alarma no encontrada');
    return r;
  }

  has(id: string): boolean {
    return this.recs.has(id);
  }

  ack(id: string, now: number, actor = 'operador'): AlarmEvent {
    const t = this.t(now);
    const rec = this.rec(id);
    const st = this.states.get(rec.rule.id);
    const life = rec.ev.lifecycle;
    if (life === 'unacked') {
      rec.ev = { ...rec.ev, lifecycle: 'acked', acknowledged: true };
      this.log(id, 'acknowledged', t, actor);
    } else if (life === 'rtn_unacked') {
      rec.ev = { ...rec.ev, lifecycle: 'closed', acknowledged: true };
      this.log(id, 'acknowledged', t, actor);
      this.finish(rec, st, t, actor);
    } else if (life === 'acked') {
      return { ...rec.ev };
    } else {
      throw new AlarmError(409, 'La alarma no se puede reconocer en su estado actual');
    }
    this.publish(rec);
    return { ...rec.ev };
  }

  shelve(id: string, minutes: number, reason: string, now: number, actor = 'ingeniería'): AlarmEvent {
    const t = this.t(now);
    const rec = this.rec(id);
    const life = rec.ev.lifecycle;
    if (life !== 'unacked' && life !== 'acked') throw new AlarmError(409, 'Sólo se puede postergar una alarma activa');
    rec.ev = { ...rec.ev, lifecycle: 'shelved', state: 'active', shelvedUntil: t + minutes * MIN, shelvedReason: reason };
    const st = this.states.get(rec.rule.id);
    if (st) st.clearSince = null;
    this.log(id, 'shelved', t, actor, `${minutes} min · ${reason}`);
    this.publish(rec);
    return { ...rec.ev };
  }

  unshelve(id: string, now: number, actor = 'ingeniería'): AlarmEvent {
    const t = this.t(now);
    const rec = this.rec(id);
    if (rec.ev.lifecycle !== 'shelved') throw new AlarmError(409, 'La alarma no está postergada');
    this.log(id, 'unshelved', t, actor);
    this.resume(rec, this.states.get(rec.rule.id)!, t);
    return { ...rec.ev };
  }

  // ── consultas ──

  list(state: 'active' | 'cleared' | 'shelved'): AlarmEvent[] {
    const all = [...this.recs.values()].map((r) => ({ ...r.ev }));
    if (state === 'shelved') return all.filter((a) => a.lifecycle === 'shelved');
    if (state === 'cleared') return all.filter((a) => a.lifecycle === 'closed').sort((a, b) => b.ts - a.ts);
    return all.filter((a) => a.lifecycle && LISTED.has(a.lifecycle));
  }

  get(id: string): AlarmEvent | null {
    const r = this.recs.get(id);
    return r ? { ...r.ev } : null;
  }

  journal(id: string): AlarmJournalEntry[] {
    this.rec(id);
    return (this.journals.get(id) ?? []).map((e) => ({ ...e }));
  }

  getPolicy(): AlarmPolicy {
    return { ...this.policy };
  }
  setPolicy(p: AlarmPolicy): AlarmPolicy {
    this.policy = { ...p };
    return this.getPolicy();
  }

  kpis(window: AlarmKpis['window'], now: number, outOfService = 0): AlarmKpis {
    const t = this.t(now);
    const active = [...this.recs.values()]
      .filter((r) => r.ev.state === 'active')
      .map((r) => ({ id: r.ev.id, asset: r.ev.asset, metric: r.ev.metric, since: r.activatedAt }));
    const suppressedNow = [...this.states.values()].filter((s) => s.suppressedNow).length;
    return computeKpis({
      activations: this.activations,
      active,
      shelved: this.list('shelved').length,
      suppressed: suppressedNow,
      outOfService,
      policy: this.policy,
      window,
      now: t,
    });
  }

  // ── historia sembrada ──

  /**
   * Siembra 30 días de historia verosímil (determinista): unas decenas de alarmas por día, una perturbación con
   * pico de actividad y una regla intermitente, para que el historial y la salud de alarmas tengan qué mostrar.
   */
  seedHistory(now: number, seed = 11) {
    const rnd = prng(seed);
    const rules = this.rules.filter((r) => r.kind !== 'ROC');
    if (rules.length === 0) return;
    const weights = rules.map((r) => (r.asset === 'tk-04' || r.asset === 'tk-02' ? 3 : r.kind === 'DEV' ? 1.5 : 1));
    const wsum = weights.reduce((a, b) => a + b, 0);
    const pick = () => {
      let x = rnd() * wsum;
      for (let i = 0; i < rules.length; i++) if ((x -= weights[i]!) <= 0) return rules[i]!;
      return rules[0]!;
    };
    const add = (rule: DemoRule, ts: number) => {
      const id = `alm-${this.plant}-h${++this.seq}`;
      const dur = (3 + rnd() * 40) * MIN;
      const high = rule.operator === 'gt';
      const v = rule.kind === 'DEV' ? (rule.setpoint ?? 0) + rule.threshold + rnd() : high ? rule.threshold + rnd() * Math.abs(rule.threshold) * 0.04 : rule.threshold - rnd() * Math.abs(rule.threshold) * 0.2;
      const ackAt = ts + (1 + rnd() * 9) * MIN;
      const clearAt = ts + dur;
      const closedAt = Math.max(ackAt, clearAt);
      const ev: AlarmEvent = {
        type: 'alarm', id, ruleId: rule.id, plant: this.plant, asset: rule.asset, metric: rule.metric, severity: rule.severity,
        state: 'cleared', value: round(v), threshold: rule.threshold, ts: closedAt, message: this.text(rule, v),
        acknowledged: true, kind: rule.kind, lifecycle: 'closed', rationale: { ...rule.rationale },
      };
      this.recs.set(id, { ev, rule, activatedAt: ts, condMet: false });
      this.activations.push({ ts, key: rule.id, asset: rule.asset, metric: rule.metric, kind: rule.kind, severity: rule.severity });
      const j: AlarmJournalEntry[] = [
        { ts, event: 'activated', actor: null, value: round(v) },
        { ts: ackAt, event: 'acknowledged', actor: rnd() < 0.7 ? 'operador@campo.demo' : 'ingeniera@campo.demo' },
        { ts: clearAt, event: 'cleared', actor: null },
      ];
      if (ackAt > clearAt) j.sort((a, b) => a.ts - b.ts);
      j.push({ ts: closedAt, event: 'closed', actor: j.find((e) => e.event === 'acknowledged')!.actor });
      this.journals.set(id, j.sort((a, b) => a.ts - b.ts));
    };
    const start = now - 30 * DAY;
    for (let day = 0; day < 30; day++) {
      const n = 14 + Math.floor(rnd() * 14); // 14–27 por día: dentro de la política
      for (let k = 0; k < n; k++) add(pick(), Math.min(start + day * DAY + rnd() * DAY, now - 50 * MIN)); // nada "cerrado en el futuro"
    }
    // perturbación hace ~7 h: una ráfaga de 11 alarmas en 10 minutos
    const burst = now - 7 * HOUR;
    for (let k = 0; k < 11; k++) add(pick(), burst + k * 50_000);
    // regla intermitente hace ~3 h: nivel bajo de tk-02 que sube y baja alrededor del límite
    const chat = rules.find((r) => r.asset === 'tk-02' && r.kind === 'LO') ?? rules[0]!;
    for (let k = 0; k < 4; k++) add(chat, now - 3 * HOUR + k * 2 * MIN);
    this.activations.sort((a, b) => a.ts - b.ts);
  }
}

const round = (v: number) => Math.round(v * 100) / 100;

function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Registro de motores activos (uno por planta demo en marcha) ──

const registry = new Map<string, AlarmEngine>();
export const registerDemoEngine = (e: AlarmEngine) => void registry.set(e.plant, e);
export const unregisterDemoEngine = (e: AlarmEngine) => {
  if (registry.get(e.plant) === e) registry.delete(e.plant);
};
export const getDemoEngine = (plant: string): AlarmEngine | undefined => registry.get(plant);
/** Motor dueño de una alarma (los ids llevan la planta). */
export const findDemoEngine = (id: string): AlarmEngine | undefined => [...registry.values()].find((e) => e.has(id));
export const anyDemoEngine = (): AlarmEngine | undefined => [...registry.values()][0];
