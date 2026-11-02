import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/auth.types';
import { TenantScope } from '../auth/tenant-scope';
import { AssetsRepository } from '../plants/assets.repository';
import {
  AlarmRule,
  AlarmRuleInput,
  RULE_LIMITS,
  ResolvedRule,
  deriveKind,
  isLimitKind,
  kindOperatorError,
  resolveRule,
} from './alarm.types';
import { AlarmEngine } from './alarm-engine.service';
import { AlarmRulesRepository } from './alarm-rules.repository';
import { CreateRuleDto, UpdateRuleDto } from './dto';
import { RuleHealth, ruleHealth } from './rule-status';

/** Lo que devuelve la API: la regla con todos sus campos ISA-18.2 y si se está evaluando. */
export type RuleView = ResolvedRule & RuleHealth;

const OOS_ERROR = `enabled=false exige outOfServiceReason (al menos ${RULE_LIMITS.reasonMin} caracteres)`;

/** CRUD de reglas limitado a las plantas del usuario y de su cliente (admin: todas las de su cliente). */
@Injectable()
export class AlarmRulesService {
  constructor(
    private readonly repo: AlarmRulesRepository,
    private readonly engine: AlarmEngine,
    private readonly audit: AuditService,
    private readonly tenant: TenantScope,
    private readonly assets: AssetsRepository,
  ) {}

  async list(user: AuthUser, plant?: string): Promise<RuleView[]> {
    if (plant) await this.tenant.assertPlant(user, plant);
    return this.decorate(await this.repo.list(plant, this.tenant.scope(user)));
  }

  async get(id: string, user: AuthUser): Promise<RuleView> {
    return (await this.decorate([(await this.load(id, user)).rule]))[0];
  }

  /** Añade `evaluable`/`status` (una consulta de catálogo por planta con reglas DEV activas, nunca por regla). */
  private async decorate(rules: AlarmRule[]): Promise<RuleView[]> {
    const resolved = rules.map(resolveRule);
    const devPlants = new Set(
      resolved.filter((r) => r.enabled && r.kind === 'DEV').map((r) => r.plant),
    );
    const catalog = new Map<string, Awaited<ReturnType<AssetsRepository['listByPlant']>>>();
    await Promise.all(
      [...devPlants].map(async (p) => catalog.set(p, await this.assets.listByPlant(p))),
    );
    return resolved.map((r) => ({
      ...r,
      ...ruleHealth(r, catalog.get(r.plant) ?? [], (asset) =>
        this.engine.liveSetpoint(r.id, asset),
      ),
    }));
  }

  /** 404 si la regla no existe; 403 genérico si su planta es de otro cliente o no asignada. */
  private async load(
    id: string,
    user: AuthUser,
  ): Promise<{ rule: AlarmRule; orgId: string | null }> {
    const rule = await this.repo.get(id);
    if (!rule) throw new NotFoundException('Regla no encontrada');
    return { rule, orgId: await this.tenant.assertPlant(user, rule.plant) };
  }

  async create(dto: CreateRuleDto, user: AuthUser): Promise<RuleView> {
    const orgId = await this.tenant.assertPlant(user, dto.plant);
    const kind = dto.kind ?? deriveKind(dto.operator, dto.severity);
    const err = kindOperatorError(kind, dto.operator);
    if (err) throw new BadRequestException(err);
    const enabled = dto.enabled ?? true;
    if (!enabled && !dto.outOfServiceReason) throw new BadRequestException(OOS_ERROR);
    const input: AlarmRuleInput = {
      plant: dto.plant,
      asset: dto.asset,
      metric: dto.metric,
      operator: dto.operator,
      threshold: dto.threshold,
      severity: dto.severity,
      forSeconds: dto.forSeconds ?? 0,
      hysteresis: dto.hysteresis ?? 0,
      enabled,
      kind,
      rocWindowSeconds: dto.rocWindowSeconds ?? RULE_LIMITS.rocWindowDefault,
      rocDirection: dto.rocDirection ?? 'any',
      offDelaySeconds: dto.offDelaySeconds ?? 0,
      suppressWhen: dto.suppressWhen ? { ...dto.suppressWhen } : null,
      description: dto.description ?? null,
      consequence: dto.consequence ?? null,
      response: dto.response ?? null,
      outOfServiceReason: enabled ? null : (dto.outOfServiceReason ?? null),
    };
    const rule = await this.repo.create(input);
    await this.engine.refresh();
    await this.audit.record(user, 'rule.create', `rule:${rule.id}`, orgId, { ...rule });
    if (!enabled) await this.recordOutOfService(user, rule, orgId);
    return (await this.decorate([rule]))[0];
  }

  async update(id: string, dto: UpdateRuleDto, user: AuthUser): Promise<RuleView> {
    const { rule: current, orgId } = await this.load(id, user); // 404 si no existe; 403 si es de otra planta/cliente
    if (dto.plant) {
      // Tampoco se puede mover a una planta ajena, ni sacarla de su cliente (ni siquiera un platform_admin).
      const target = await this.tenant.assertPlant(user, dto.plant);
      if (target !== orgId) {
        throw new BadRequestException('Una regla no se puede mover a una planta de otro cliente');
      }
    }
    const cur = resolveRule(current);
    const operator = dto.operator ?? cur.operator;
    const severity = dto.severity ?? cur.severity;
    // El tipo sigue a operador+severidad (HH<->HI...) salvo que se pida otro o la regla sea DEV/ROC.
    const kind =
      dto.kind ??
      (isLimitKind(cur.kind) && (dto.operator || dto.severity)
        ? deriveKind(operator, severity)
        : cur.kind);
    const err = kindOperatorError(kind, operator);
    if (err) throw new BadRequestException(err);

    const patch: Partial<AlarmRuleInput> = {};
    for (const [k, v] of Object.entries(dto)) {
      if (v !== undefined) (patch as Record<string, unknown>)[k] = v;
    }
    if (dto.suppressWhen) patch.suppressWhen = { ...dto.suppressWhen };
    if (kind !== cur.kind) patch.kind = kind;
    const goingOut = dto.enabled === false;
    if (goingOut && !dto.outOfServiceReason) throw new BadRequestException(OOS_ERROR);
    const enabled = dto.enabled ?? cur.enabled;
    // El motivo sólo vive mientras la regla está fuera de servicio.
    if (enabled) {
      if (cur.outOfServiceReason !== null || dto.outOfServiceReason !== undefined) {
        patch.outOfServiceReason = null;
      }
    }

    const rule = await this.repo.update(id, patch);
    if (!rule) throw new NotFoundException('Regla no encontrada');
    await this.engine.refresh();
    const changed = Object.keys(patch).filter(
      (k) => (patch as Record<string, unknown>)[k] !== undefined,
    );
    await this.audit.record(user, 'rule.update', `rule:${id}`, orgId, {
      changed,
      plant: rule.plant,
    });
    if (goingOut && cur.enabled) await this.recordOutOfService(user, rule, orgId);
    return (await this.decorate([rule]))[0];
  }

  async remove(id: string, user: AuthUser): Promise<void> {
    const { rule, orgId } = await this.load(id, user);
    if (!(await this.repo.delete(id))) throw new NotFoundException('Regla no encontrada');
    await this.engine.refresh();
    await this.audit.record(user, 'rule.delete', `rule:${id}`, orgId, {
      plant: rule.plant,
      asset: rule.asset,
      metric: rule.metric,
    });
  }

  private recordOutOfService(user: AuthUser, rule: AlarmRule, orgId: string | null): Promise<void> {
    return this.audit.record(user, 'rule.out_of_service', `rule:${rule.id}`, orgId, {
      plant: rule.plant,
      asset: rule.asset,
      metric: rule.metric,
      reason: rule.outOfServiceReason,
    });
  }
}
