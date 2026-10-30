import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  MemoryAssetsRepository,
  MemoryAuditRepository,
  MemoryOrgsRepository,
  MemoryPlantsRepository,
  MemoryUsersRepository,
} from '../../test/support/memory-repos';
import { AuditService } from '../audit/audit.service';
import { AccessService } from '../auth/access.service';
import { InMemoryInvalidationBus } from '../auth/auth-invalidation';
import { AuthService } from '../auth/auth.service';
import type { AuthUser } from '../auth/auth.types';
import { parseEnv } from '../config/app-config';
import { OrgsService } from './orgs.service';

const cfg = parseEnv({ JWT_SECRET: 's'.repeat(40), NODE_ENV: 'test', BCRYPT_ROUNDS: '4' });
const platform: AuthUser = {
  id: 'plat',
  email: 'p@campo.test',
  role: 'platform_admin',
  plants: ['*'],
  org: null,
};

describe('OrgsService', () => {
  let users: MemoryUsersRepository;
  let plants: MemoryPlantsRepository;
  let orgs: MemoryOrgsRepository;
  let audit: MemoryAuditRepository;
  let access: AccessService;
  let svc: OrgsService;

  beforeEach(() => {
    users = new MemoryUsersRepository();
    plants = new MemoryPlantsRepository(new MemoryAssetsRepository(), users);
    orgs = new MemoryOrgsRepository(() => plants, users);
    audit = new MemoryAuditRepository();
    access = new AccessService(users, orgs, new InMemoryInvalidationBus(), cfg);
    const auth = new AuthService(users, new JwtService({ secret: cfg.jwtSecret }), access, cfg);
    svc = new OrgsService(orgs, users, auth, access, new AuditService(audit));
  });

  it('crea un cliente (activo por defecto), 409 si el id ya existe, y audita con el cliente', async () => {
    const o = await svc.create({ id: 'acme', name: 'Acme', modules: ['tanks', 'gas'] }, platform);
    expect(o).toMatchObject({
      id: 'acme',
      name: 'Acme',
      modules: ['tanks', 'gas'],
      active: true,
      plants: 0,
      users: 0,
    });
    expect(typeof o.createdAt).toBe('number');
    await expect(
      svc.create({ id: 'acme', name: 'Otro', modules: [] }, platform),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0]).toMatchObject({
      action: 'org.create',
      target: 'org:acme',
      detail: { name: 'Acme', modules: ['tanks', 'gas'], active: true },
    });
    expect(audit.orgOfEntry.get('1')).toBe('acme');
  });

  it('list devuelve Org[] con contadores de plantas y usuarios', async () => {
    await svc.create({ id: 'acme', name: 'Acme', modules: [] }, platform);
    await svc.create({ id: 'beta', name: 'Beta', modules: ['tanks'] }, platform);
    plants.register('p1', 'acme');
    plants.register('p2', 'acme');
    await users.create({ email: 'a@x.y', passwordHash: 'x', role: 'viewer', orgId: 'acme' });
    expect((await svc.list()).map((o) => [o.id, o.plants, o.users])).toEqual([
      ['acme', 2, 1],
      ['beta', 0, 0],
    ]);
    await expect(svc.get('nadie')).rejects.toBeInstanceOf(NotFoundException);
    expect(await svc.get('acme')).toMatchObject({ plants: 2, users: 1 });
  });

  describe('update', () => {
    beforeEach(async () => {
      await svc.create({ id: 'acme', name: 'Acme', modules: ['tanks'] }, platform);
    });

    it('cambia name, modules y active; 400 si no hay nada; 404 si no existe', async () => {
      await expect(svc.update('acme', {}, platform)).rejects.toBeInstanceOf(BadRequestException);
      await expect(svc.update('nadie', { name: 'x' }, platform)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(
        await svc.update('acme', { name: 'Acme SA', modules: ['tanks', 'energy'] }, platform),
      ).toMatchObject({
        name: 'Acme SA',
        modules: ['tanks', 'energy'],
        active: true,
      });
      expect(audit.entries.at(-1)).toMatchObject({
        action: 'org.update',
        detail: { changed: ['name', 'modules'], name: 'Acme SA', modules: ['tanks', 'energy'] },
      });
    });

    it('cualquier cambio invalida la caché de acceso de los usuarios del cliente', async () => {
      const seen: string[] = [];
      access.orgInvalidations$.subscribe((x) => seen.push(x));
      await svc.update('acme', { modules: ['gas'] }, platform);
      await svc.update('acme', { active: false }, platform);
      expect(seen).toEqual(['acme', 'acme']);
    });

    it('desactivar revoca las sesiones de TODOS sus usuarios (token_version + 1) y los usuarios ya no pasan; reactivar no las resucita', async () => {
      const mine = (await users.create({
        email: 'a@x.y',
        passwordHash: 'x',
        role: 'admin',
        orgId: 'acme',
      }))!;
      const other = (await users.create({
        email: 'b@x.y',
        passwordHash: 'x',
        role: 'admin',
        orgId: 'beta',
      }))!;
      await svc.update('acme', { active: false }, platform);
      expect([mine.tokenVersion, other.tokenVersion]).toEqual([1, 0]);
      await expect(access.getAccess(mine.id, { fresh: true })).resolves.toBeNull();
      await svc.update('acme', { active: true }, platform);
      await expect(access.getAccess(mine.id, { tv: 0 })).resolves.toBeNull(); // el token viejo no vuelve
      await expect(access.getAccess(mine.id, { tv: 1 })).resolves.toMatchObject({ id: mine.id });
      // desactivar un cliente que ya está inactivo no vuelve a subir la versión
      await svc.update('acme', { active: false }, platform);
      await svc.update('acme', { active: false }, platform);
      expect(mine.tokenVersion).toBe(2);
    });
  });

  it('delete: 409 si tiene plantas o usuarios; 404 si no existe; borra y audita si está vacío', async () => {
    await svc.create({ id: 'acme', name: 'Acme', modules: [] }, platform);
    plants.register('p1', 'acme');
    await expect(svc.remove('acme', platform)).rejects.toBeInstanceOf(ConflictException);
    plants.names.delete('p1');
    plants.orgs.delete('p1');
    const u = (await users.create({
      email: 'a@x.y',
      passwordHash: 'x',
      role: 'viewer',
      orgId: 'acme',
    }))!;
    await expect(svc.remove('acme', platform)).rejects.toBeInstanceOf(ConflictException);
    users.users.splice(users.users.indexOf(u), 1);
    await expect(svc.remove('nadie', platform)).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.remove('acme', platform)).resolves.toEqual({ deleted: true });
    expect(orgs.orgs.has('acme')).toBe(false);
    expect(audit.entries.at(-1)).toMatchObject({
      action: 'org.delete',
      target: 'org:acme',
      detail: { name: 'Acme' },
    });
    expect(audit.orgOfEntry.get(audit.entries.at(-1)!.id)).toBe('acme');
  });

  it('createAdmin: crea un admin del cliente, 409 si el email existe, 404 si el cliente no existe; nunca guarda la contraseña en la auditoría', async () => {
    await svc.create({ id: 'acme', name: 'Acme', modules: ['tanks'] }, platform);
    const admin = await svc.createAdmin(
      'acme',
      { email: 'jefe@acme.test', password: 'clave-larga-123' },
      platform,
    );
    expect(admin).toMatchObject({
      email: 'jefe@acme.test',
      role: 'admin',
      active: true,
      plants: [],
      org: { id: 'acme', name: 'Acme', modules: ['tanks'] },
    });
    expect(users.users[0]).toMatchObject({ orgId: 'acme', role: 'admin' });
    expect(users.users[0].passwordHash).not.toContain('clave-larga');
    await expect(
      svc.createAdmin('acme', { email: 'JEFE@acme.test', password: 'clave-larga-123' }, platform),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      svc.createAdmin('nadie', { email: 'x@acme.test', password: 'clave-larga-123' }, platform),
    ).rejects.toBeInstanceOf(NotFoundException);
    const last = audit.entries.at(-1)!;
    expect(last).toMatchObject({ action: 'org.admin.create', detail: { email: 'jefe@acme.test' } });
    expect(JSON.stringify(audit.entries)).not.toMatch(/clave-larga|\$2[aby]\$/);
    expect(audit.orgOfEntry.get(last.id)).toBe('acme');
  });
});
