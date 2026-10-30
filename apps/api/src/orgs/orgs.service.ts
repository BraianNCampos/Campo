import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { ManagedUser, Org } from '@campo/shared';
import { AuditService } from '../audit/audit.service';
import { AccessService } from '../auth/access.service';
import { AuthService } from '../auth/auth.service';
import type { AuthUser } from '../auth/auth.types';
import { UsersRepository } from '../auth/users.repository';
import { toManagedUser } from '../users/users.service';
import { CreateOrgAdminDto, CreateOrgDto, UpdateOrgDto } from './dto';
import { OrgRecord, OrgsRepository } from './orgs.repository';

/** Gestión de clientes: sólo platform_admin (lo exige el controlador). */
@Injectable()
export class OrgsService {
  private readonly log = new Logger(OrgsService.name);

  constructor(
    private readonly repo: OrgsRepository,
    private readonly users: UsersRepository,
    private readonly auth: AuthService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
  ) {}

  list(): Promise<Org[]> {
    return this.repo.list();
  }

  async get(id: string): Promise<Org> {
    return (await this.repo.list()).find((o) => o.id === id) ?? this.notFound();
  }

  async create(dto: CreateOrgDto, actor: AuthUser): Promise<Org> {
    const created = await this.repo.create({
      id: dto.id,
      name: dto.name,
      modules: dto.modules,
      active: dto.active ?? true,
    });
    if (!created) throw new ConflictException('El cliente ya existe');
    this.log.log({ msg: 'cliente creado', actorId: actor.id, orgId: created.id });
    await this.audit.record(actor, 'org.create', `org:${created.id}`, created.id, {
      name: created.name,
      modules: created.modules,
      active: created.active,
    });
    return { ...created, plants: 0, users: 0 };
  }

  async update(id: string, dto: UpdateOrgDto, actor: AuthUser): Promise<Org> {
    const changed = Object.keys(dto).filter((k) => (dto as Record<string, unknown>)[k] !== undefined);
    if (changed.length === 0) throw new BadRequestException('Nada que modificar (name, modules o active)');
    const before = (await this.repo.findById(id)) ?? this.notFound();
    // Desactivar corta las sesiones de TODO el cliente y, a diferencia de un simple 401 mientras esté
    // inactivo, las deja revocadas: al reactivarlo hay que iniciar sesión de nuevo (como con un usuario).
    if (dto.active === false && before.active) await this.users.revokeByOrg(id);
    const updated = await this.repo.update(id, dto);
    if (!updated) this.notFound();
    // Siempre después de guardar: la caché se relee con el cliente ya cambiado (active/modules/name).
    await this.access.invalidateOrg(id);
    this.log.log({ msg: 'cliente modificado', actorId: actor.id, orgId: id, changed });
    await this.audit.record(actor, 'org.update', `org:${id}`, id, {
      changed,
      name: dto.name,
      modules: dto.modules,
      active: dto.active,
    });
    return this.get(id);
  }

  /** 409 si aún tiene plantas o usuarios. */
  async remove(id: string, actor: AuthUser): Promise<{ deleted: true }> {
    const before: OrgRecord = (await this.repo.findById(id)) ?? this.notFound();
    const res = await this.repo.delete(id);
    if (res === 'not_found') this.notFound();
    if (res === 'has_children') {
      throw new ConflictException('El cliente tiene plantas o usuarios: elimínelos antes de borrarlo');
    }
    await this.access.invalidateOrg(id);
    this.log.log({ msg: 'cliente eliminado', actorId: actor.id, orgId: id });
    await this.audit.record(actor, 'org.delete', `org:${id}`, id, { name: before.name });
    return { deleted: true };
  }

  /** Primer (o siguiente) administrador del cliente. */
  async createAdmin(orgId: string, dto: CreateOrgAdminDto, actor: AuthUser): Promise<ManagedUser> {
    const org = (await this.repo.findById(orgId)) ?? this.notFound();
    const created = await this.users.create({
      email: dto.email,
      passwordHash: await this.auth.hashPassword(dto.password),
      role: 'admin',
      orgId,
    });
    if (!created) throw new ConflictException('El email ya está registrado');
    this.log.log({ msg: 'administrador de cliente creado', actorId: actor.id, orgId, userId: created.id });
    await this.audit.record(actor, 'org.admin.create', `user:${created.id}`, orgId, {
      email: created.email,
    });
    return toManagedUser(created, org);
  }

  private notFound(): never {
    throw new NotFoundException('Cliente no encontrado');
  }
}
