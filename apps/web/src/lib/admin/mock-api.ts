import { ID_PATTERN, MODEL_REF_PATTERN } from '@campo/shared';
import type { AssetDef, AuditEntry, ManagedUser, Me, ModelInfo, Plant, Role } from '@campo/shared';
import { errorFromResponse, ModelInUseError } from './errors';
import { checkGlb } from './glb-check';
import { MODEL_MAX_BYTES } from './models';
import { ASSET_TYPES, OPERATORS, ROLES, SEVERITIES } from './types';
import { validateMetadataLayout } from './validation';
import type {
  AdminApi,
  AlarmRule,
  AlarmRuleInput,
  AlarmRulePatch,
  AssetInput,
  AssetPatch,
  AssetResult,
  AuditQuery,
  ModelUploadOptions,
  ModelUploadResult,
  UserInput,
  UserPatch,
} from './types';

/** Contraseña de todos los usuarios del modo demo. */
export const DEMO_PASSWORD = 'demo-password-123';

export interface MockOptions {
  /** Rol del usuario "conectado" (def. admin). Debe haber un usuario sembrado con ese rol. */
  role?: Role;
  /** Latencia simulada por llamada (def. 0). */
  latencyMs?: number;
  now?: () => number;
}

interface MockUser extends ManagedUser {
  password: string;
  tokenVersion: number;
}

const DAY = 86_400_000;
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const RULE_ASSET = /^[a-z0-9*][a-z0-9_*-]{0,63}$/;
const RULE_METRIC = /^[A-Za-z0-9_.-]{1,64}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const SEED_ASSETS: [string, string, AssetDef['type'], Record<string, unknown>][] = [
  ['tk-01', 'Tanque 01', 'tank', { capacityL: 10000, unit: '%' }],
  ['tk-02', 'Tanque 02', 'tank', { capacityL: 10000, unit: '%' }],
  ['tk-03', 'Tanque 03', 'tank', { capacityL: 5000, unit: '%' }],
  ['tk-04', 'Tanque 04', 'tank', { capacityL: 5000, unit: '%' }],
  ['pump-01', 'Bomba 01', 'pump', { ratedKw: 7.5 }],
  ['pump-02', 'Bomba 02', 'pump', { ratedKw: 7.5 }],
  ['valve-01', 'Válvula 01', 'valve', { dn: 80 }],
  ['valve-02', 'Válvula 02', 'valve', { dn: 80 }],
];

/**
 * API en memoria para el modo demo y las pruebas: mismas reglas, errores (400/403/404/409) y
 * efectos (auditoría, `affectedRules`, último admin…) que el contrato de docs/architecture.md.
 */
export class MockAdminApi implements AdminApi {
  private plants = new Map<string, string>();
  private assets: AssetDef[] = [];
  private users: MockUser[] = [];
  private rules: AlarmRule[] = [];
  private audit: AuditEntry[] = [];
  private models = new Map<string, { info: ModelInfo; bytes: ArrayBuffer }>();
  private listeners = new Set<(plant: string) => void>();
  private seq = 100;
  private auditSeq = 0;
  private meId: string;
  private readonly now: () => number;
  private readonly latency: number;

  constructor(opts: MockOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.latency = opts.latencyMs ?? 0;
    this.seed();
    const role = opts.role ?? 'admin';
    this.meId = (this.users.find((u) => u.role === role) ?? this.users[0]!).id;
  }

  // ───────── infraestructura ─────────

  private run<T>(fn: () => T | Promise<T>): Promise<T> {
    if (this.latency <= 0) return Promise.resolve().then(fn);
    return new Promise((resolve, reject) =>
      setTimeout(() => {
        try {
          resolve(fn());
        } catch (e) {
          reject(e);
        }
      }, this.latency),
    );
  }

  private fail(status: number, message?: string | string[]): never {
    throw errorFromResponse(status, message ? { message } : {});
  }

  private get meUser(): MockUser {
    return this.users.find((u) => u.id === this.meId)!;
  }

  private require(...roles: Role[]) {
    if (!roles.includes(this.meUser.role)) this.fail(403, 'Forbidden resource');
  }

  private plantAccess(plant: string) {
    const me = this.meUser;
    if (me.role === 'admin') {
      if (!this.plants.has(plant)) this.fail(404, 'La planta no existe');
      return;
    }
    if (!me.plants.includes(plant) || !this.plants.has(plant)) this.fail(403, 'No tiene acceso a esta planta');
  }

  private allowedPlants(): string[] {
    const me = this.meUser;
    return me.role === 'admin' ? [...this.plants.keys()] : me.plants.filter((p) => this.plants.has(p));
  }

  private record(action: string, target: string, detail: Record<string, unknown> = {}, ts = this.now(), actor: MockUser | null = this.meUser) {
    this.audit.push({
      id: String(++this.auditSeq),
      ts,
      actorId: actor?.id ?? null,
      actorEmail: actor?.email ?? null,
      action,
      target,
      detail,
    });
  }

  private nextId = () => uuid(++this.seq);

  /** Avisa a quien escuche (el stream simulado) de que cambió el catálogo o los modelos de una planta. */
  private changed(plant: string) {
    for (const l of this.listeners) l(plant);
  }

  onCatalogChange(listener: (plant: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Errores de `model3dRef` y de `metadata.layout/connectsTo` (400) y avisos no bloqueantes. */
  private checkAssetBody(plant: string, id: string, ref: unknown, metadata: unknown, current?: string | null): { errors: string[]; warnings: string[]; metadata: unknown } {
    const errors: string[] = [];
    const warnings: string[] = [];
    if (ref !== undefined && ref !== null && ref !== current) {
      if (typeof ref !== 'string' || !MODEL_REF_PATTERN.test(ref)) errors.push('model3dRef debe ser null o "model:<uuid>"');
      else if (this.models.get(ref.slice(6))?.info.plant !== plant) errors.push('model3dRef: el modelo no existe en esta planta');
    }
    if (metadata !== undefined) {
      errors.push(...validateMetadataLayout(metadata, id));
      const known = new Set(this.assets.filter((a) => a.plant === plant).map((a) => a.id));
      const links = (metadata as { connectsTo?: unknown } | null)?.connectsTo;
      if (Array.isArray(links)) {
        const missing = links.filter((l): l is string => typeof l === 'string' && l !== id && !known.has(l));
        for (const l of missing) warnings.push(`connectsTo: el activo «${l}» no existe en la planta y no se ha guardado.`);
        if (missing.length > 0 && errors.length === 0) metadata = { ...(metadata as object), connectsTo: links.filter((l) => !missing.includes(l as string)) }; // la API no guarda los inexistentes
      }
    }
    return { errors, warnings, metadata };
  }

  private seed() {
    const t = this.now();
    this.plants.set('demo', 'Planta demo');
    for (const [id, name, type, metadata] of SEED_ASSETS) {
      this.assets.push({ plant: 'demo', id, name, type, model3dRef: id === 'tk-01' ? 'tank' : null, metadata }); // tk-01 conserva el valor antiguo (texto libre), como la API real
    }
    const mk = (n: number, email: string, role: Role, plants: string[]): MockUser => ({
      id: uuid(n), email, role, plants, active: true, password: DEMO_PASSWORD, tokenVersion: 1,
    });
    this.users.push(
      mk(0xa1, 'admin@campo.demo', 'admin', []),
      mk(0xa2, 'ingeniera@campo.demo', 'engineer', ['demo']),
      mk(0xa3, 'operador@campo.demo', 'operator', ['demo']),
      mk(0xa4, 'consulta@campo.demo', 'viewer', []),
    );
    const sevRule = (n: number, asset: string, metric: string, operator: AlarmRule['operator'], threshold: number, severity: AlarmRule['severity'], forSeconds: number, hysteresis: number) =>
      this.rules.push({ id: uuid(n), plant: 'demo', asset, metric, operator, threshold, severity, forSeconds, hysteresis, enabled: true, createdAt: t - 5 * DAY, updatedAt: t - 5 * DAY });
    sevRule(1, 'tk-*', 'level', 'gt', 90, 'critical', 5, 2);
    sevRule(2, 'tk-*', 'level', 'lt', 10, 'warning', 5, 2);
    sevRule(3, 'tk-*', 'temp', 'gt', 35, 'warning', 10, 1);

    const [admin, eng, op] = [this.users[0]!, this.users[1]!, this.users[2]!];
    const h = 3_600_000;
    this.record('plant.create', 'plant:demo', { name: 'Planta demo' }, t - 5 * DAY, admin);
    this.record('rule.create', `rule:${uuid(1)}`, { plant: 'demo', asset: 'tk-*', metric: 'level', operator: 'gt', threshold: 90 }, t - 5 * DAY + h, admin);
    this.record('user.create', `user:${eng.id}`, { email: eng.email, role: 'engineer' }, t - 4 * DAY, admin);
    this.record('user.plants', `user:${eng.id}`, { plants: ['demo'] }, t - 4 * DAY + 60_000, admin);
    this.record('user.create', `user:${op.id}`, { email: op.email, role: 'operator' }, t - 4 * DAY + 5 * 60_000, admin);
    this.record('user.plants', `user:${op.id}`, { plants: ['demo'] }, t - 4 * DAY + 6 * 60_000, admin);
    this.record('rule.update', `rule:${uuid(3)}`, { changed: ['threshold', 'hysteresis'] }, t - 2 * DAY, eng);
    this.record('asset.update', 'asset:demo/tk-03', { changed: ['metadata'] }, t - 2 * DAY + 10 * 60_000, eng);
    this.record('alarm.ack', `alarm:${uuid(900)}`, { asset: 'tk-04', metric: 'level' }, t - 26 * h, op);
    this.record('alarm.ack', `alarm:${uuid(901)}`, { asset: 'tk-02', metric: 'level' }, t - 9 * h, op);
    this.record('user.revoke', `user:${op.id}`, {}, t - 3 * h, admin);
    this.record('me.password', `user:${admin.id}`, {}, t - 40 * 60_000, admin);
  }

  // ───────── cuenta ─────────

  me(): Promise<Me> {
    return this.run(() => this.toMe(this.meUser));
  }

  private toMe(u: MockUser): Me {
    return { id: u.id, email: u.email, role: u.role, plants: u.role === 'admin' ? ['*'] : [...u.plants] };
  }

  changePassword(input: { currentPassword: string; newPassword: string }) {
    return this.run(() => {
      const me = this.meUser;
      const errs: string[] = [];
      if (typeof input.currentPassword !== 'string' || !input.currentPassword) errs.push('currentPassword should not be empty');
      if (typeof input.newPassword !== 'string' || input.newPassword.length < 12) {
        errs.push('newPassword must be longer than or equal to 12 characters');
      }
      if (errs.length) this.fail(400, errs);
      if (input.currentPassword !== me.password) this.fail(400, 'La contraseña actual no es correcta');
      if (input.newPassword === input.currentPassword) this.fail(400, 'La nueva contraseña debe ser distinta de la actual');
      me.password = input.newPassword;
      me.tokenVersion++;
      this.record('me.password', `user:${me.id}`);
      return { accessToken: `mock-token-${me.id.slice(-2)}-v${me.tokenVersion}` };
    });
  }

  // ───────── plantas ─────────

  private plantOf(id: string): Plant {
    return { id, name: this.plants.get(id) ?? id, assets: this.assets.filter((a) => a.plant === id).length };
  }

  listPlants(): Promise<Plant[]> {
    return this.run(() => this.allowedPlants().sort().map((id) => this.plantOf(id)));
  }

  createPlant(input: { id: string; name: string }) {
    return this.run(() => {
      this.require('admin');
      const errs: string[] = [];
      if (typeof input.id !== 'string' || !ID_PATTERN.test(input.id)) errs.push(`id must match ${ID_PATTERN} regular expression`);
      if (typeof input.name !== 'string' || !input.name.trim()) errs.push('name should not be empty');
      if (errs.length) this.fail(400, errs);
      if (this.plants.has(input.id)) this.fail(409, 'La planta ya existe');
      this.plants.set(input.id, input.name.trim());
      this.record('plant.create', `plant:${input.id}`, { name: input.name.trim() });
      return this.plantOf(input.id);
    });
  }

  renamePlant(id: string, name: string) {
    return this.run(() => {
      this.require('admin');
      if (!this.plants.has(id)) this.fail(404, 'La planta no existe');
      if (typeof name !== 'string' || !name.trim()) this.fail(400, 'name should not be empty');
      this.plants.set(id, name.trim());
      this.record('plant.update', `plant:${id}`, { name: name.trim() });
      return this.plantOf(id);
    });
  }

  deletePlant(id: string) {
    return this.run(() => {
      this.require('admin');
      if (!this.plants.has(id)) this.fail(404, 'La planta no existe');
      const n = this.assets.filter((a) => a.plant === id).length;
      if (n > 0) this.fail(409, `La planta tiene ${n} activo${n === 1 ? '' : 's'}: elimínalos antes de borrarla`);
      this.plants.delete(id);
      for (const [mid, m] of this.models) if (m.info.plant === id) this.models.delete(mid);
      for (const u of this.users) u.plants = u.plants.filter((p) => p !== id);
      this.record('plant.delete', `plant:${id}`);
      this.changed(id);
    });
  }

  // ───────── activos ─────────

  listAssets(plant: string) {
    return this.run(() => {
      this.plantAccess(plant);
      return this.assets.filter((a) => a.plant === plant).sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true })).map((a) => ({ ...a }));
    });
  }

  createAsset(plant: string, input: AssetInput) {
    return this.run(() => {
      this.require('admin', 'engineer');
      this.plantAccess(plant);
      const errs: string[] = [];
      if (typeof input.id !== 'string' || !ID_PATTERN.test(input.id)) errs.push(`id must match ${ID_PATTERN} regular expression`);
      if (typeof input.name !== 'string' || !input.name.trim()) errs.push('name should not be empty');
      if (!ASSET_TYPES.includes(input.type)) errs.push(`type must be one of the following values: ${ASSET_TYPES.join(', ')}`);
      if (input.metadata !== undefined && (typeof input.metadata !== 'object' || input.metadata === null || Array.isArray(input.metadata))) {
        errs.push('metadata must be an object');
      }
      const body = this.checkAssetBody(plant, input.id, input.model3dRef, input.metadata);
      errs.push(...body.errors);
      if (errs.length) this.fail(400, errs);
      if (this.assets.some((a) => a.plant === plant && a.id === input.id)) this.fail(409, 'El activo ya existe en esta planta');
      const asset: AssetDef = {
        plant, id: input.id, name: input.name.trim(), type: input.type,
        model3dRef: input.model3dRef ?? null, metadata: (body.metadata as Record<string, unknown> | undefined) ?? {},
      };
      this.assets.push(asset);
      this.record('asset.create', `asset:${plant}/${asset.id}`, { name: asset.name, type: asset.type });
      this.changed(plant);
      return { ...asset, ...(body.warnings.length > 0 && { warnings: body.warnings }) } as AssetResult;
    });
  }

  updateAsset(plant: string, id: string, patch: AssetPatch) {
    return this.run(() => {
      this.require('admin', 'engineer');
      this.plantAccess(plant);
      const a = this.assets.find((x) => x.plant === plant && x.id === id);
      if (!a) this.fail(404, 'Activo no encontrado');
      const errs: string[] = [];
      if (patch.name !== undefined && (typeof patch.name !== 'string' || !patch.name.trim())) errs.push('name should not be empty');
      if (patch.type !== undefined && !ASSET_TYPES.includes(patch.type)) errs.push(`type must be one of the following values: ${ASSET_TYPES.join(', ')}`);
      const body = this.checkAssetBody(plant, id, patch.model3dRef, patch.metadata, a.model3dRef);
      errs.push(...body.errors);
      if (errs.length) this.fail(400, errs);
      const changed = Object.keys(patch).filter((k) => patch[k as keyof AssetPatch] !== undefined);
      Object.assign(a, {
        ...(patch.name !== undefined && { name: patch.name.trim() }),
        ...(patch.type !== undefined && { type: patch.type }),
        ...(patch.model3dRef !== undefined && { model3dRef: patch.model3dRef }),
        ...(patch.metadata !== undefined && { metadata: body.metadata as Record<string, unknown> }),
      });
      this.record('asset.update', `asset:${plant}/${id}`, { changed });
      this.changed(plant);
      return { ...a, ...(body.warnings.length > 0 && { warnings: body.warnings }) } as AssetResult;
    });
  }

  deleteAsset(plant: string, id: string) {
    return this.run(() => {
      this.require('admin', 'engineer');
      this.plantAccess(plant);
      const i = this.assets.findIndex((x) => x.plant === plant && x.id === id);
      if (i < 0) this.fail(404, 'Activo no encontrado');
      this.assets.splice(i, 1);
      // las reglas que lo nombran (id exacto) siguen existiendo: se informa de cuántas
      const affectedRules = this.rules.filter((r) => r.plant === plant && r.asset === id).length;
      this.record('asset.delete', `asset:${plant}/${id}`, { affectedRules });
      this.changed(plant);
      return { affectedRules };
    });
  }

  // ───────── modelos 3D ─────────

  listModels(plant: string) {
    return this.run(() => {
      this.plantAccess(plant);
      return [...this.models.values()]
        .filter((m) => m.info.plant === plant)
        .map((m) => ({ ...m.info }))
        .sort((a, b) => b.createdAt - a.createdAt || a.name.localeCompare(b.name));
    });
  }

  uploadModel(plant: string, file: Blob, name: string, opts: ModelUploadOptions = {}): Promise<ModelUploadResult> {
    return this.run(async () => {
      this.require('admin', 'engineer');
      this.plantAccess(plant);
      const clean = typeof name === 'string' ? name.trim() : '';
      if (!clean) this.fail(400, 'name should not be empty');
      if (clean.length > 100) this.fail(400, 'name must be shorter than or equal to 100 characters');
      if (file.size > MODEL_MAX_BYTES) this.fail(413, 'El modelo supera el límite de 10 MB');
      // progreso simulado para poder ver la barra en demo
      for (const f of [0.3, 0.65, 1]) {
        if (this.latency > 0) await new Promise((r) => setTimeout(r, this.latency * 4));
        if (opts.signal?.aborted) this.fail(400, 'Subida cancelada');
        opts.onProgress?.(Math.round(file.size * f), file.size);
      }
      const bytes = await readBytes(file);
      const problem = checkGlb(bytes);
      if (problem) this.fail(400, `GLB no válido: ${problem}`);
      const sha256 = await sha256Hex(bytes);
      const dup = [...this.models.values()].find((m) => m.info.plant === plant && m.info.sha256 === sha256);
      if (dup) return { model: { ...dup.info }, created: false };
      const info: ModelInfo = { id: this.nextId(), plant, name: clean, size: bytes.byteLength, sha256, createdAt: this.now() };
      this.models.set(info.id, { info, bytes });
      this.record('model.upload', `model:${info.id}`, { plant, name: clean, size: info.size });
      this.changed(plant);
      return { model: { ...info }, created: true };
    });
  }

  deleteModel(plant: string, id: string) {
    return this.run(() => {
      this.require('admin', 'engineer');
      this.plantAccess(plant);
      const m = this.models.get(id);
      if (!m || m.info.plant !== plant) this.fail(404, 'Modelo no encontrado');
      const users = this.assets.filter((a) => a.plant === plant && a.model3dRef === `model:${id}`).map((a) => a.id);
      if (users.length > 0) throw new ModelInUseError(users);
      this.models.delete(id);
      this.record('model.delete', `model:${id}`, { plant, name: m.info.name });
      this.changed(plant);
    });
  }

  downloadModel(id: string) {
    return this.run(() => {
      const m = this.models.get(id);
      if (!m) this.fail(404, 'Modelo no encontrado');
      this.plantAccess(m.info.plant);
      return m.bytes.slice(0);
    });
  }

  // ───────── usuarios ─────────

  private view = (u: MockUser): ManagedUser => ({ id: u.id, email: u.email, role: u.role, active: u.active, plants: [...u.plants] });

  listUsers() {
    return this.run(() => {
      this.require('admin');
      return this.users.map(this.view);
    });
  }

  private passwordErrors(pw: unknown, field: string): string[] {
    if (typeof pw !== 'string') return [`${field} must be a string`];
    if (pw.length < 12) return [`${field} debe tener al menos 12 caracteres`];
    if (new TextEncoder().encode(pw).length > 72) return [`${field} no puede superar 72 bytes`];
    return [];
  }

  createUser(input: UserInput) {
    return this.run(() => {
      this.require('admin');
      const errs: string[] = [];
      const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
      if (!EMAIL.test(email)) errs.push('email must be an email');
      errs.push(...this.passwordErrors(input.password, 'password'));
      if (!ROLES.includes(input.role)) errs.push(`role must be one of the following values: ${ROLES.join(', ')}`);
      if (input.plants?.some((p) => !ID_PATTERN.test(p))) errs.push('plants: ids de planta inválidos');
      if (errs.length) this.fail(400, errs);
      if (this.users.some((u) => u.email === email)) this.fail(409, 'El email ya está registrado');
      const u: MockUser = {
        id: this.nextId(), email, role: input.role, active: true,
        plants: [...new Set(input.plants ?? [])], password: input.password, tokenVersion: 1,
      };
      this.users.push(u);
      this.record('user.create', `user:${u.id}`, { email, role: u.role, plants: u.plants });
      return this.view(u);
    });
  }

  updateUser(id: string, patch: UserPatch) {
    return this.run(() => {
      this.require('admin');
      if (patch.role === undefined && patch.active === undefined && patch.password === undefined) {
        this.fail(400, 'Nada que modificar (role, active o password)');
      }
      const u = this.users.find((x) => x.id === id);
      if (!u) this.fail(404, 'Usuario no encontrado');
      const errs: string[] = [];
      if (patch.role !== undefined && !ROLES.includes(patch.role)) errs.push(`role must be one of the following values: ${ROLES.join(', ')}`);
      if (patch.password !== undefined) errs.push(...this.passwordErrors(patch.password, 'password'));
      if (errs.length) this.fail(400, errs);
      const demotes = patch.role !== undefined && patch.role !== 'admin';
      const losesAdmin = u.role === 'admin' && u.active && (demotes || patch.active === false);
      if (losesAdmin && this.users.filter((x) => x.role === 'admin' && x.active).length <= 1) {
        this.fail(409, 'No se puede desactivar ni degradar al último admin activo');
      }
      if (patch.role !== undefined) u.role = patch.role;
      if (patch.active !== undefined) u.active = patch.active;
      if (patch.password !== undefined) u.password = patch.password;
      if (patch.password !== undefined || patch.active === false) u.tokenVersion++;
      this.record('user.update', `user:${id}`, {
        ...(patch.role !== undefined && { role: patch.role }),
        ...(patch.active !== undefined && { active: patch.active }),
        ...(patch.password !== undefined && { passwordChanged: true }),
      });
      return this.view(u);
    });
  }

  setUserPlants(id: string, plants: string[]) {
    return this.run(() => {
      this.require('admin');
      if (!Array.isArray(plants) || plants.some((p) => !ID_PATTERN.test(p))) this.fail(400, 'plants: ids de planta inválidos');
      const u = this.users.find((x) => x.id === id);
      if (!u) this.fail(404, 'Usuario no encontrado');
      u.plants = [...new Set(plants)];
      this.record('user.plants', `user:${id}`, { plants: u.plants });
      return this.view(u);
    });
  }

  revokeUserSessions(id: string) {
    return this.run(() => {
      this.require('admin');
      const u = this.users.find((x) => x.id === id);
      if (!u) this.fail(404, 'Usuario no encontrado');
      u.tokenVersion++;
      this.record('user.revoke', `user:${id}`);
      return this.view(u);
    });
  }

  // ───────── reglas ─────────

  private ruleErrors(r: AlarmRulePatch, partial: boolean): string[] {
    const e: string[] = [];
    const has = (k: keyof AlarmRulePatch) => !partial || r[k] !== undefined;
    if (has('plant') && (typeof r.plant !== 'string' || !ID_PATTERN.test(r.plant))) e.push('plant inválida');
    if (has('asset') && (typeof r.asset !== 'string' || !RULE_ASSET.test(r.asset))) e.push('asset: id exacto o patrón con * (p. ej. tk-*)');
    if (has('metric') && (typeof r.metric !== 'string' || !RULE_METRIC.test(r.metric))) e.push('metric inválida');
    if (has('operator') && !OPERATORS.includes(r.operator as never)) e.push(`operator must be one of the following values: ${OPERATORS.join(', ')}`);
    if (has('threshold') && (typeof r.threshold !== 'number' || !Number.isFinite(r.threshold))) e.push('threshold must be a number conforming to the specified constraints');
    if (has('severity') && !SEVERITIES.includes(r.severity as never)) e.push(`severity must be one of the following values: ${SEVERITIES.join(', ')}`);
    if (r.forSeconds !== undefined) {
      if (!Number.isInteger(r.forSeconds)) e.push('forSeconds must be an integer number');
      else if (r.forSeconds < 0) e.push('forSeconds must not be less than 0');
      else if (r.forSeconds > 86_400) e.push('forSeconds must not be greater than 86400');
    }
    if (r.hysteresis !== undefined && (typeof r.hysteresis !== 'number' || !(r.hysteresis >= 0))) e.push('hysteresis must not be less than 0');
    return e;
  }

  listRules() {
    return this.run(() => {
      this.require('admin', 'engineer');
      const ok = new Set(this.allowedPlants());
      return this.rules.filter((r) => ok.has(r.plant)).map((r) => ({ ...r }));
    });
  }

  createRule(input: AlarmRuleInput) {
    return this.run(() => {
      this.require('admin', 'engineer');
      const errs = this.ruleErrors(input, false);
      if (errs.length) this.fail(400, errs);
      this.plantAccess(input.plant);
      const t = this.now();
      const rule: AlarmRule = { ...input, forSeconds: input.forSeconds ?? 0, hysteresis: input.hysteresis ?? 0, enabled: input.enabled ?? true, id: this.nextId(), createdAt: t, updatedAt: t };
      this.rules.push(rule);
      this.record('rule.create', `rule:${rule.id}`, { plant: rule.plant, asset: rule.asset, metric: rule.metric, operator: rule.operator, threshold: rule.threshold, severity: rule.severity });
      return { ...rule };
    });
  }

  updateRule(id: string, patch: AlarmRulePatch) {
    return this.run(() => {
      this.require('admin', 'engineer');
      const r = this.rules.find((x) => x.id === id);
      if (!r) this.fail(404, 'Regla no encontrada');
      this.plantAccess(r.plant);
      const errs = this.ruleErrors(patch, true);
      if (errs.length) this.fail(400, errs);
      if (patch.plant && patch.plant !== r.plant) this.plantAccess(patch.plant);
      const changed = Object.keys(patch).filter((k) => patch[k as keyof AlarmRulePatch] !== undefined);
      Object.assign(r, Object.fromEntries(changed.map((k) => [k, patch[k as keyof AlarmRulePatch]])), { updatedAt: this.now() });
      this.record('rule.update', `rule:${id}`, { changed });
      return { ...r };
    });
  }

  deleteRule(id: string) {
    return this.run(() => {
      this.require('admin', 'engineer');
      const i = this.rules.findIndex((x) => x.id === id);
      if (i < 0) this.fail(404, 'Regla no encontrada');
      this.plantAccess(this.rules[i]!.plant);
      const [r] = this.rules.splice(i, 1);
      this.record('rule.delete', `rule:${id}`, { plant: r!.plant, asset: r!.asset, metric: r!.metric });
    });
  }

  // ───────── auditoría ─────────

  listAudit(q: AuditQuery = {}) {
    return this.run(() => {
      this.require('admin');
      const limit = Math.min(Math.max(q.limit ?? 50, 1), 200);
      const actor = q.actor?.trim().toLowerCase();
      const action = q.action?.trim().toLowerCase();
      const before = q.before ? Number(q.before) : Infinity;
      return this.audit
        .filter((e) => Number(e.id) < before)
        .filter((e) => !actor || e.actorId?.toLowerCase() === actor || (e.actorEmail ?? '').toLowerCase().includes(actor))
        .filter((e) => !action || e.action.toLowerCase().startsWith(action))
        .sort((a, b) => Number(b.id) - Number(a.id))
        .slice(0, limit)
        .map((e) => ({ ...e, detail: { ...e.detail } }));
    });
  }
}

async function readBytes(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer();
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as ArrayBuffer);
    r.onerror = () => reject(r.error);
    r.readAsArrayBuffer(blob);
  });
}

/** SHA-256 en hex; sin `crypto.subtle` (contexto no seguro) cae a un resumen no criptográfico de 64 hex (sólo demo). */
async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  try {
    const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    return [...d].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    const u = new Uint8Array(bytes);
    let out = '';
    for (let k = 0; k < 8; k++) {
      let h = 0x811c9dc5 ^ (k * 0x9e3779b1);
      for (let i = 0; i < u.length; i++) h = Math.imul(h ^ (u[i] ?? 0), 0x01000193);
      out += (h >>> 0).toString(16).padStart(8, '0');
    }
    return out;
  }
}
