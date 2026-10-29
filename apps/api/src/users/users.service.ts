import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { ManagedUser } from '@campo/shared';
import { AccessService } from '../auth/access.service';
import { AuthService } from '../auth/auth.service';
import type { AuthUser } from '../auth/auth.types';
import { User, UsersRepository } from '../auth/users.repository';
import { CreateUserDto, UpdateUserDto } from './dto';

/** Vista pública de un usuario: nunca incluye el hash. `plants` son las asignaciones guardadas. */
export const toManagedUser = (u: User): ManagedUser => ({
  id: u.id,
  email: u.email,
  role: u.role,
  active: u.active,
  plants: u.plants,
});

@Injectable()
export class UsersService {
  private readonly log = new Logger(UsersService.name);

  constructor(
    private readonly users: UsersRepository,
    private readonly auth: AuthService,
    private readonly access: AccessService,
  ) {}

  async list(): Promise<ManagedUser[]> {
    return (await this.users.list()).map(toManagedUser);
  }

  async create(dto: CreateUserDto, actor: AuthUser): Promise<ManagedUser> {
    const created = await this.users.create({
      email: dto.email,
      passwordHash: await this.auth.hashPassword(dto.password),
      role: dto.role,
    });
    if (!created) throw new ConflictException('El email ya está registrado');
    const withPlants =
      dto.plants && dto.plants.length > 0
        ? ((await this.users.setPlants(created.id, dto.plants)) ?? created)
        : created;
    this.log.log({ msg: 'usuario creado', actorId: actor.id, userId: created.id, role: dto.role });
    return toManagedUser(withPlants);
  }

  async update(id: string, dto: UpdateUserDto, actor: AuthUser): Promise<ManagedUser> {
    if (dto.role === undefined && dto.active === undefined && dto.password === undefined) {
      throw new BadRequestException('Nada que modificar (role, active o password)');
    }
    const res = await this.users.update(id, {
      role: dto.role,
      active: dto.active,
      passwordHash: dto.password ? await this.auth.hashPassword(dto.password) : undefined,
    });
    if (res.status === 'not_found') throw new NotFoundException('Usuario no encontrado');
    if (res.status === 'last_admin') {
      throw new ConflictException('No se puede desactivar ni degradar al último admin activo');
    }
    await this.access.invalidate(id);
    this.log.log({
      msg: 'usuario modificado',
      actorId: actor.id,
      userId: id,
      changed: Object.keys(dto),
    });
    return toManagedUser(res.user);
  }

  async setPlants(id: string, plants: string[], actor: AuthUser): Promise<ManagedUser> {
    const user = await this.users.setPlants(id, [...new Set(plants)]);
    if (!user) throw new NotFoundException('Usuario no encontrado');
    await this.access.invalidate(id);
    this.log.log({ msg: 'plantas de usuario actualizadas', actorId: actor.id, userId: id, plants });
    return toManagedUser(user);
  }
}
