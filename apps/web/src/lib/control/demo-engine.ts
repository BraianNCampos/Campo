import type { AlarmEvent, AssetDef, AssetState, InterlockItem, Limit, Order, OrderCommand, OrderPreview, Role } from '@campo/shared';
import { ControlApiError, controlErrorFromResponse } from './errors';
import { COMMAND_LABEL, orderText } from './flow';
import { controlConfigOf, evaluateInterlocks, canOrder, isControlEnabled, isControllableType, maxAllowedTarget, targetRange } from './interlocks';
import { CONFIRM_TTL_MS, CONTROL_DEFAULTS, isActiveOrder, type OrderQuery, type PreviewRequest } from './types';

/**
 * Servidor de control simulado para el modo demo (sin backend): replica en el cliente lo que hace la API (§14.3) —
 * confirmación en dos pasos con `confirmId` de un solo uso, enclavamientos, límite de 10 órdenes por minuto, ciclo de
 * vida `pending → accepted → running → done` — y mueve el nivel del tanque hacia el objetivo en la telemetría simulada.
 * Sin dependencias de React ni del store: el contexto (catálogo, datos, alarmas, reloj) se inyecta.
 */

export interface DemoUser {
  id: string;
  email: string;
  role: Role;
}

export interface EngineContext {
  now(): number;
  catalog(): Record<string, AssetDef>;
  state(asset: string): AssetState | undefined;
  limits(asset: string): readonly Limit[];
  alarms(): readonly AlarmEvent[];
  moduleActive(): boolean;
}

export interface EngineOptions {
  plant: string;
  ctx: EngineContext;
  /** se llama con cada cambio de una orden (el equivalente del evento WS `order`) */
  emit?: (o: Order) => void;
  /** velocidad del nivel en % por segundo (la demo va acelerada para que se vea) */
  rate?: number;
  /** demoras de las respuestas del «equipo» */
  acceptMs?: number;
  runMs?: number;
  /** tiempo en que una compensación (la diferencia con la simulación natural) se diluye, en segundos */
  decaySec?: number;
}

interface PendingConfirm {
  id: string;
  userId: string;
  asset: string;
  command: OrderCommand;
  target?: number;
  expiresAt: number;
  used: boolean;
}

interface Active {
  orderId: string;
  command: 'fill' | 'drain';
  target: number;
  shown: number;
}

const MAX_PER_MINUTE = 10;
const pct = (n: number) => `${String(Math.round(n * 10) / 10).replace('.', ',')} %`;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round2 = (v: number) => Math.round(v * 100) / 100;

export class DemoControlEngine {
  private orders: Order[] = [];
  private confirms = new Map<string, PendingConfirm>();
  private active = new Map<string, Active>();
  /** diferencia (mostrado − natural) que se va diluyendo tras terminar una orden */
  private offset = new Map<string, number>();
  /** último nivel «natural» (de la simulación) visto por activo */
  private natural = new Map<string, number>();
  private stamps = new Map<string, number[]>();
  private seq = 0;
  private readonly rate: number;
  private readonly acceptMs: number;
  private readonly runMs: number;
  private readonly decaySec: number;

  constructor(private readonly o: EngineOptions) {
    this.rate = o.rate ?? 1.2;
    this.acceptMs = o.acceptMs ?? 700;
    this.runMs = o.runMs ?? 1500;
    this.decaySec = o.decaySec ?? 45;
  }

  private get ctx() {
    return this.o.ctx;
  }

  private def(asset: string): AssetDef | undefined {
    return this.ctx.catalog()[asset];
  }

  private tagOf(asset: string): string {
    return this.def(asset)?.tag ?? asset;
  }

  private activeOrderOf(asset: string): Order | undefined {
    return this.orders.find((o) => o.asset === asset && isActiveOrder(o) && o.command !== 'stop');
  }

  private interlocks(user: DemoUser, asset: string, command: OrderCommand, target?: number) {
    return evaluateInterlocks({
      command,
      target,
      role: user.role,
      moduleActive: this.ctx.moduleActive(),
      def: this.def(asset),
      state: this.ctx.state(asset),
      now: this.ctx.now(),
      limits: this.ctx.limits(asset),
      alarms: this.ctx.alarms(),
      assetId: asset,
      activeOrder: this.activeOrderOf(asset) ?? null,
    });
  }

  /** Permisos de enclavamiento del equipo (`GET .../interlocks`): se evalúan para llenar con el objetivo medio del rango. */
  interlocksOf(user: DemoUser, asset: string): InterlockItem[] {
    const def = this.def(asset);
    if (!def) throw controlErrorFromResponse(404, {});
    if (!isControllableType(def.type)) return []; // sin control de llenado no hay permisos que mostrar
    const range = targetRange(def);
    const level = this.ctx.state(asset)?.values.level ?? (range.min + range.max) / 2;
    // permisos para una orden típica: llenar 5 puntos, o vaciar 5 si ya no hay margen hacia arriba
    const up = Math.round(level) + 5;
    const fill = up <= Math.min(range.max, maxAllowedTarget(def, this.ctx.limits(asset)));
    return this.interlocks(user, asset, fill ? 'fill' : 'drain', fill ? up : Math.max(range.min, Math.round(level) - 5)).items;
  }

  private fail(status: number, body: unknown): never {
    throw controlErrorFromResponse(status, body);
  }

  preview(user: DemoUser, asset: string, req: PreviewRequest): OrderPreview {
    const now = this.ctx.now();
    const def = this.def(asset);
    if (!def) this.fail(404, {});
    if (!canOrder(user.role)) this.fail(403, {});
    if (!['fill', 'drain', 'stop'].includes(req.command)) this.fail(400, { message: ['command must be one of the following values: fill, drain, stop'] });
    if (req.command !== 'stop' && !(typeof req.target === 'number' && req.target >= 1 && req.target <= 99)) {
      this.fail(400, { message: ['target: tiene que ser un número entre 1 y 99'] });
    }
    const target = req.command === 'stop' ? undefined : req.target;
    const il = this.interlocks(user, asset, req.command, target);
    const level = this.ctx.state(asset)?.values.level;
    const tag = this.tagOf(asset);
    const warnings: string[] = [];
    let summary: string;
    if (req.command === 'stop') {
      summary = `Detener la operación de ${tag} (${def.name})${level !== undefined ? `. Nivel actual: ${pct(level)}` : ''}.`;
      const cur = this.activeOrderOf(asset);
      if (cur) warnings.push(`Hay una orden en curso (${orderText(cur)}): se va a cancelar.`);
    } else {
      const cap = (def.metadata as { capacityM3?: unknown }).capacityM3;
      const delta = level !== undefined && target !== undefined ? Math.abs(target - level) : undefined;
      const vol = typeof cap === 'number' && delta !== undefined ? ` (unos ${String(Math.round((delta / 100) * cap * 10) / 10).replace('.', ',')} m³)` : '';
      summary = `${COMMAND_LABEL[req.command]} ${tag} (${def.name})${level !== undefined ? ` de ${pct(level)}` : ''} a ${pct(target!)}${vol}.`;
      const maxMin = controlConfigOf(def)?.maxDurationMinutes ?? CONTROL_DEFAULTS.maxDurationMinutes;
      warnings.push(`Si la orden no termina en ${maxMin} minutos, se corta sola.`);
      const hi = this.ctx.limits(asset).filter((l) => l.metric === 'level' && (l.operator === 'gt' || l.operator === 'gte')).sort((a, b) => a.threshold - b.threshold)[0];
      const lo = this.ctx.limits(asset).filter((l) => l.metric === 'level' && (l.operator === 'lt' || l.operator === 'lte')).sort((a, b) => b.threshold - a.threshold)[0];
      if (hi && target !== undefined && target >= hi.threshold - 5 && target < hi.threshold) warnings.push(`El objetivo queda cerca del límite alto (${pct(hi.threshold)}).`);
      if (lo && target !== undefined && target <= lo.threshold + 5 && req.command === 'drain') warnings.push(`El objetivo queda cerca del límite bajo (${pct(lo.threshold)}): puede generar una alarma de nivel bajo.`);
      warnings.push('Podés detener la orden en cualquier momento con «Detener».');
    }
    const confirmId = `cf-${++this.seq}-${Math.floor(now % 1e6).toString(36)}`;
    this.confirms.set(confirmId, { id: confirmId, userId: user.id, asset, command: req.command, target, expiresAt: now + CONFIRM_TTL_MS, used: false });
    return { confirmId, expiresAt: now + CONFIRM_TTL_MS, summary, warnings, blocked: il.blocked };
  }

  execute(user: DemoUser, asset: string, confirmId: string): Order {
    const now = this.ctx.now();
    if (!canOrder(user.role)) this.fail(403, {});
    const c = this.confirms.get(confirmId);
    if (!c || c.used || c.userId !== user.id || c.asset !== asset) this.fail(409, { error: 'confirm_invalid' });
    if (now > c.expiresAt) {
      this.confirms.delete(confirmId);
      this.fail(409, { error: 'confirm_expired' });
    }
    const recent = (this.stamps.get(user.id) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= MAX_PER_MINUTE) this.fail(429, {});
    const il = this.interlocks(user, asset, c.command, c.target);
    if (il.blocked) {
      const busy = il.items.find((i) => i.id === 'single' && !i.ok);
      if (busy) this.fail(409, { error: 'order_in_progress' });
      const off = il.items.find((i) => i.id === 'telemetry' && !i.ok);
      if (off) this.fail(409, { error: 'device_offline' });
      throw new ControlApiError(il.blocked, 409, 'conflict', 'interlock');
    }
    c.used = true;
    this.stamps.set(user.id, [...recent, now]);
    const order: Order = {
      id: `ord-${this.o.plant}-${++this.seq}`,
      plant: this.o.plant,
      asset,
      tag: this.def(asset)?.tag ?? null,
      command: c.command,
      ...(c.target !== undefined && { target: c.target }),
      status: 'pending',
      requestedBy: { id: user.id, email: user.email },
      requestedAt: now,
      updatedAt: now,
    };
    this.orders.unshift(order);
    this.orders.length = Math.min(this.orders.length, 200);
    this.o.emit?.({ ...order });
    return { ...order };
  }

  /** Cancelar = enviar un `stop` sobre el mismo equipo (§14.3). */
  cancel(user: DemoUser, orderId: string): Order {
    const ord = this.orders.find((x) => x.id === orderId);
    if (!ord) this.fail(404, {});
    if (!canOrder(user.role)) this.fail(403, {});
    if (!isActiveOrder(ord)) this.fail(409, { message: 'Esa orden ya terminó, no se puede cancelar.' });
    const now = this.ctx.now();
    const stop: Order = {
      id: `ord-${this.o.plant}-${++this.seq}`,
      plant: this.o.plant,
      asset: ord.asset,
      tag: ord.tag ?? null,
      command: 'stop',
      status: 'pending',
      requestedBy: { id: user.id, email: user.email },
      requestedAt: now,
      updatedAt: now,
      reason: `Cancelación de la orden ${orderText(ord)}`,
    };
    this.orders.unshift(stop);
    this.o.emit?.({ ...stop });
    return { ...ord };
  }

  list(q: OrderQuery = {}): Order[] {
    let out = this.orders.filter((o) => (!q.asset || o.asset === q.asset) && (!q.status || o.status === q.status));
    out = [...out].sort((a, b) => b.requestedAt - a.requestedAt);
    return out.slice(0, q.limit ?? 100).map((o) => ({ ...o }));
  }

  /** Nivel que se muestra: durante una orden, el que va siguiendo el objetivo; después, la simulación con una diferencia que se diluye. */
  transform(asset: string, values: Record<string, number>): Record<string, number> {
    const def = this.def(asset);
    if (!def || !isControllableType(def.type) || !isControlEnabled(def)) return values;
    const out = { ...values };
    const a = this.active.get(asset);
    const natural = values.level;
    if (natural !== undefined) {
      this.natural.set(asset, natural);
      if (a) {
        this.offset.set(asset, a.shown - natural);
        out.level = round2(clamp(a.shown, 0, 100));
      } else {
        const off = this.offset.get(asset) ?? 0;
        if (off !== 0) out.level = round2(clamp(natural + off, 0, 100));
      }
    }
    out.sts = a ? (a.command === 'fill' ? 1 : 2) : 0;
    out.mode = a ? 1 : 0;
    return out;
  }

  /** Avanza `dtSec` segundos: respuestas del equipo, nivel hacia el objetivo, vencimientos. */
  step(dtSec: number): void {
    const now = this.ctx.now();
    const dt = clamp(dtSec, 0, 2);
    for (const o of [...this.orders].reverse()) {
      if (!isActiveOrder(o)) continue;
      const age = now - o.requestedAt;
      if (o.status === 'pending' && age >= this.acceptMs) this.set(o, 'accepted', now);
      if (o.status === 'accepted' && age >= this.runMs) this.start(o, now);
      if (o.status === 'running') this.run(o, now);
    }
    for (const [asset, a] of this.active) {
      const dir = a.command === 'fill' ? 1 : -1;
      a.shown = clamp(a.shown + dir * this.rate * dt, 0, 100);
      const reached = dir > 0 ? a.shown >= a.target : a.shown <= a.target;
      if (reached) {
        a.shown = a.target;
        const ord = this.orders.find((x) => x.id === a.orderId);
        if (ord && isActiveOrder(ord)) this.finish(ord, 'done', now, `Nivel objetivo alcanzado (${pct(a.target)}).`);
        this.release(asset);
      }
    }
    // la diferencia con la simulación natural se diluye cuando no hay orden
    const k = Math.exp(-dt / this.decaySec);
    for (const [asset, off] of this.offset) {
      if (this.active.has(asset)) continue;
      const next = off * k;
      if (Math.abs(next) < 0.02) this.offset.delete(asset);
      else this.offset.set(asset, next);
    }
  }

  /** Termina el seguimiento del objetivo: lo que se ve queda como diferencia que se irá diluyendo. */
  private release(asset: string) {
    const a = this.active.get(asset);
    if (!a) return;
    this.offset.set(asset, a.shown - (this.natural.get(asset) ?? a.shown));
    this.active.delete(asset);
  }

  private set(o: Order, status: Order['status'], now: number, extra: Partial<Order> = {}) {
    Object.assign(o, { status, updatedAt: now, ...extra });
    this.o.emit?.({ ...o });
  }

  private finish(o: Order, status: Order['status'], now: number, reason?: string) {
    this.set(o, status, now, { completedAt: now, ...(reason ? { reason } : {}) });
  }

  private start(o: Order, now: number) {
    this.set(o, 'running', now);
    if (o.command === 'stop') return;
    if (o.command !== 'fill' && o.command !== 'drain') return;
    const level = this.ctx.state(o.asset)?.values.level ?? 0;
    this.active.set(o.asset, { orderId: o.id, command: o.command, target: o.target ?? level, shown: level });
  }

  private run(o: Order, now: number) {
    if (o.command === 'stop') {
      if (now - o.requestedAt < this.runMs + 500) return;
      // el equipo se detiene: la orden en curso del mismo equipo queda cancelada
      const cur = this.orders.find((x) => x.asset === o.asset && x.id !== o.id && isActiveOrder(x) && x.command !== 'stop');
      if (cur) {
        this.release(o.asset);
        this.finish(cur, 'cancelled', now, `Detenida por ${o.requestedBy.email || 'un usuario'}.`);
      }
      this.finish(o, 'done', now, o.reason ?? 'El equipo se detuvo.');
      return;
    }
    const max = (controlConfigOf(this.def(o.asset))?.maxDurationMinutes ?? CONTROL_DEFAULTS.maxDurationMinutes) * 60_000;
    if (now - o.requestedAt > max) {
      this.release(o.asset);
      this.finish(o, 'timeout', now, 'Superó la duración máxima y se cortó sola.');
    }
  }
}

