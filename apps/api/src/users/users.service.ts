import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { ManagedUser } from '@campo/shared';
import { AuditService } from '../audit/audit.service';
import { AccessService } from '../auth/access.service';
import { AuthService } from '../auth/auth.service';
import type { AuthUser } from '../auth/auth.types';
import { PlantAccessDenied, isPlatform, orgIdOf } from '../auth/plant-access';
import { TenantScope } from '../auth/tenant-scope';
import { User, UsersRepository } from '../auth/users.repository';
import { OrgRecord, OrgsRepository, toSummary } from '../orgs/orgs.repository';
import { CreateUserDto, UpdateUserDto } from './dto';

/** Vista pública de un usuario: nunca incluye el hash. `plants` son las asignaciones guardadas. */
export const toManagedUser = (u: User, org: OrgRecord | null): ManagedUser => ({
  id: u.id,
  email: u.email,
  role: u.role,
  active: u.active,
  plants: u.plants,
  org: org ? toSummary(org) : null,
});

/**
 * Administración de usuarios. Un `admin` sólo ve y toca usuarios de SU cliente; nunca crea ni edita un
 * `platform_admin`, ni mueve usuarios de cliente, ni les asigna plantas de otro cliente. Un usuario de otro
 * cliente (o de plataforma) responde 403 genérico. platform_admin opera sobre cualquier cliente.
 */
@Injectable()
export class UsersService {
  private readonly log = new Logger(UsersService.name);

  constructor(
    private readonly users: UsersRepository,
    private readonly orgs: OrgsRepository,
    private readonly auth: AuthService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly tenant: TenantScope,
  ) {}

  async list(actor: AuthUser, orgId?: string): Promise<ManagedUser[]> {
    const own = orgIdOf(actor);
    if (!isPlatform(actor) && own === null) return [];
    const found = await this.users.list({ orgId: isPlatform(actor) ? orgId : (own as string) });
    const cache = new Map<string, OrgRecord | null>();
    const out: ManagedUser[] = [];
    for (const u of found) out.push(toManagedUser(u, await this.orgOf(u.orgId, cache)));
    return out;
  }

  async create(dto: CreateUserDto, actor: AuthUser): Promise<ManagedUser> {
    const orgId = await this.resolveNewUserOrg(dto, actor);
    if (dto.plants && dto.plants.length > 0) await this.assertAssignable(actor, orgId, dto.plants);
    const created = await this.users.create({
      email: dto.email,
      passwordHash: await this.auth.hashPassword(dto.password),
      role: dto.role,
      orgId,
    });
    if (!created) throw new ConflictException('El email ya está registrado');
    const withPlants =
      dto.plants && dto.plants.length > 0
        ? ((await this.users.setPlants(created.id, dto.plants)) ?? created)
        : created;
    this.log.log({
      msg: 'usuario creado',
      actorId: actor.id,
      userId: created.id,
      role: dto.role,
      orgId,
    });
    await this.audit.record(actor, 'user.create', `user:${created.id}`, orgId, {
      email: created.email,
      role: created.role,
      plants: withPlants.plants,
      orgId,
    });
    return this.view(withPlants);
  }

  async update(id: string, dto: UpdateUserDto, actor: AuthUser): Promise<ManagedUser> {
    if (dto.role === undefined && dto.active === undefined && dto.password === undefined) {
      throw new BadRequestException('Nada que modificar (role, active o password)');
    }
    const target = await this.authorizeTarget(actor, id);
    if (dto.role !== undefined && dto.role !== target.role) {
      if (!isPlatform(actor) && dto.role === 'platform_admin') {
        throw new ForbiddenException('Sólo el personal de plataforma gestiona platform_admin');
      }
      if (dto.role === 'platform_admin' || target.role === 'platform_admin') {
        throw new BadRequestException(
          'El rol platform_admin no se puede asignar ni quitar con PATCH',
        );
      }
    }
    const changed = Object.keys(dto).filter(
      (k) => (dto as Record<string, unknown>)[k] !== undefined,
    );
    const res = await this.users.update(id, {
      role: dto.role,
      active: dto.active,
      passwordHash: dto.password ? await this.auth.hashPassword(dto.password) : undefined,
      // Cambiar la contraseña o desactivar cierra las sesiones existentes (token_version + 1).
      revokeTokens: dto.password !== undefined || dto.active === false,
    });
    if (res.status === 'not_found') throw new NotFoundException('Usuario no encontrado');
    if (res.status === 'last_admin') {
      throw new ConflictException('No se puede desactivar ni degradar al último admin activo');
    }
    await this.access.invalidate(id);
    this.log.log({ msg: 'usuario modificado', actorId: actor.id, userId: id, changed });
    await this.audit.record(actor, 'user.update', `user:${id}`, target.orgId, {
      changed, // nombres de campo; el valor de `password` nunca se registra
      role: dto.role,
      active: dto.active,
    });
    return this.view(res.user);
  }

  /** Cierra todas las sesiones del usuario (JWT y WebSockets abiertos) sin tocar su cuenta. */
  async revoke(id: string, actor: AuthUser): Promise<ManagedUser> {
    const target = await this.authorizeTarget(actor, id);
    const res = await this.users.update(id, { revokeTokens: true });
    if (res.status === 'not_found' || res.status === 'last_admin') {
      throw new NotFoundException('Usuario no encontrado');
    }
    await this.access.invalidate(id);
    this.log.log({ msg: 'sesiones de usuario revocadas', actorId: actor.id, userId: id });
    await this.audit.record(actor, 'user.revoke', `user:${id}`, target.orgId);
    return this.view(res.user);
  }

  async setPlants(id: string, plants: string[], actor: AuthUser): Promise<ManagedUser> {
    const target = await this.authorizeTarget(actor, id);
    const unique = [...new Set(plants)];
    if (unique.length > 0) {
      if (target.orgId === null) {
        throw new BadRequestException(
          'Un platform_admin ve todas las plantas: no lleva asignaciones',
        );
      }
      await this.assertAssignable(actor, target.orgId, unique);
    }
    const user = await this.users.setPlants(id, unique);
    if (!user) throw new NotFoundException('Usuario no encontrado');
    await this.access.invalidate(id);
    this.log.log({ msg: 'plantas de usuario actualizadas', actorId: actor.id, userId: id, plants });
    await this.audit.record(actor, 'user.plants', `user:${id}`, target.orgId, {
      plants: user.plants,
    });
    return this.view(user);
  }

  // ---- autorización ----

  /** Usuario objetivo: 404 si no existe; 403 genérico si es de otro cliente o de plataforma (y el actor no es platform_admin). */
  private async authorizeTarget(actor: AuthUser, id: string): Promise<User> {
    const target = await this.users.findById(id);
    if (!target) throw new NotFoundException('Usuario no encontrado');
    if (!isPlatform(actor) && (target.orgId === null || target.orgId !== orgIdOf(actor))) {
      throw new ForbiddenException('No tiene acceso a este usuario');
    }
    return target;
  }

  /** Cliente del usuario nuevo según quién lo crea (o error). */
  private async resolveNewUserOrg(dto: CreateUserDto, actor: AuthUser): Promise<string | null> {
    if (!isPlatform(actor)) {
      const own = orgIdOf(actor);
      if (dto.role === 'platform_admin') {
        throw new ForbiddenException('Sólo el personal de plataforma crea un platform_admin');
      }
      if (own === null || (dto.orgId !== undefined && dto.orgId !== own)) {
        throw new ForbiddenException('No puede crear usuarios en otro cliente');
      }
      return own;
    }
    if (dto.role === 'platform_admin') {
      if (dto.orgId !== undefined)
        throw new BadRequestException('Un platform_admin no pertenece a un cliente');
      if (dto.plants && dto.plants.length > 0) {
        throw new BadRequestException(
          'Un platform_admin ve todas las plantas: no lleva asignaciones',
        );
      }
      return null;
    }
    if (dto.orgId === undefined) throw new BadRequestException('orgId es obligatorio');
    if (!(await this.orgs.findById(dto.orgId)))
      throw new NotFoundException('Cliente no encontrado');
    return dto.orgId;
  }

  /** Todas las plantas deben pertenecer al cliente `orgId`. Un admin recibe 403 genérico; plataforma, 400 con detalle. */
  private async assertAssignable(
    actor: AuthUser,
    orgId: string | null,
    plants: string[],
  ): Promise<void> {
    for (const plant of plants) {
      if ((await this.tenant.orgOf(plant)) === orgId && orgId !== null) continue;
      if (isPlatform(actor)) {
        throw new BadRequestException(
          `La planta "${plant}" no existe o no pertenece al cliente del usuario`,
        );
      }
      throw new PlantAccessDenied(plant);
    }
  }

  private async view(u: User): Promise<ManagedUser> {
    return toManagedUser(u, await this.orgOf(u.orgId));
  }

  private async orgOf(
    orgId: string | null,
    cache?: Map<string, OrgRecord | null>,
  ): Promise<OrgRecord | null> {
    if (orgId === null) return null;
    if (cache?.has(orgId)) return cache.get(orgId) ?? null;
    const org = await this.orgs.findById(orgId);
    cache?.set(orgId, org);
    return org;
  }
}
