import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  MemoryAssetsRepository,
  MemoryAuditRepository,
  MemoryOrgsRepository,
  MemoryPlantCatalog,
  MemoryPlantsRepository,
  MemoryUsersRepository,
} from '../../test/support/memory-repos';
import { createRedisMocks } from '../../test/support/redis-mock';
import { AuditService } from '../audit/audit.service';
import { AccessService } from '../auth/access.service';
import { InMemoryInvalidationBus } from '../auth/auth-invalidation';
import { AuthService } from '../auth/auth.service';
import type { AuthUser } from '../auth/auth.types';
import { TenantScope } from '../auth/tenant-scope';
import { User } from '../auth/users.repository';
import { parseEnv } from '../config/app-config';
import { UsersService } from './users.service';

const cfg = parseEnv({ JWT_SECRET: 's'.repeat(40), NODE_ENV: 'test', BCRYPT_ROUNDS: '4' });
const org = (id: string) => ({ id, name: id, modules: [] });
const admin: AuthUser = {
  id: 'adm',
  email: 'admin@campo.test',
  role: 'admin',
  plants: ['*'],
  org: org('A'),
};
const platform: AuthUser = { ...admin, id: 'plat', role: 'platform_admin', org: null };

describe('UsersService', () => {
  let users: MemoryUsersRepository;
  let orgs: MemoryOrgsRepository;
  let plants: MemoryPlantsRepository;
  let audit: MemoryAuditRepository;
  let access: AccessService;
  let svc: UsersService;

  beforeEach(async () => {
    users = new MemoryUsersRepository();
    plants = new MemoryPlantsRepository(new MemoryAssetsRepository(), users);
    plants.register('demo', 'A');
    plants.register('norte', 'A');
    plants.register('b-1', 'B');
    orgs = new MemoryOrgsRepository(() => plants, users);
    await orgs.create({ id: 'A', name: 'A', modules: ['tanks'], active: true });
    await orgs.create({ id: 'B', name: 'B', modules: [], active: true });
    audit = new MemoryAuditRepository();
    const auth = new AuthService(
      users,
      new JwtService({ secret: cfg.jwtSecret }),
      new AccessService(users, orgs, new InMemoryInvalidationBus(), cfg),
      cfg,
    );
    access = new AccessService(users, orgs, new InMemoryInvalidationBus(), cfg);
    const { redis } = createRedisMocks();
    svc = new UsersService(
      users,
      orgs,
      auth,
      access,
      new AuditService(audit),
      new TenantScope(new MemoryPlantCatalog(plants, redis)),
    );
  });

  const mk = async (email: string, role: User['role'], orgId: string | null): Promise<User> =>
    (await users.create({ email, passwordHash: 'x', role, orgId }))!;
  const version = (id: string) => users.users.find((u) => u.id === id)!.tokenVersion;
  const create = () =>
    svc.create(
      { email: 'ana@campo.test', password: 'clave-larga-123', role: 'viewer', plants: ['demo'] },
      admin,
    );

  describe('revocación y auditoría', () => {
    it('sólo cambiar la contraseña o desactivar sube token_version; cambiar rol o reactivar no', async () => {
      const { id } = await create();
      expect(version(id)).toBe(0);

      await svc.update(id, { role: 'operator' }, admin);
      expect(version(id)).toBe(0);
      await svc.update(id, { password: 'otra-clave-larga-1' }, admin);
      expect(version(id)).toBe(1);
      await svc.update(id, { active: false }, admin);
      expect(version(id)).toBe(2);
      await svc.update(id, { active: true }, admin);
      expect(version(id)).toBe(2);
      await svc.update(id, { password: 'otra-clave-larga-2', active: true, role: 'viewer' }, admin);
      expect(version(id)).toBe(3);
    });

    it('revoke sube la versión, invalida la caché/WS y audita con el cliente; 404 si no existe', async () => {
      const { id } = await create();
      const seen: string[] = [];
      access.invalidations$.subscribe((x) => seen.push(x));
      const res = await svc.revoke(id, admin);
      expect(res).toEqual({
        id,
        email: 'ana@campo.test',
        role: 'viewer',
        active: true,
        plants: ['demo'],
        org: { id: 'A', name: 'A', modules: ['tanks'] },
      });
      expect(version(id)).toBe(1);
      expect(seen).toEqual([id]);
      expect(audit.entries.at(-1)).toMatchObject({
        action: 'user.revoke',
        target: `user:${id}`,
        detail: {},
      });
      expect(audit.orgOfEntry.get(audit.entries.at(-1)!.id)).toBe('A');
      await expect(
        svc.revoke('00000000-0000-4000-8000-000000000000', admin),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('audita alta, edición y plantas sin contraseñas ni hashes', async () => {
      const { id } = await create();
      await svc.update(id, { password: 'otra-clave-larga-1', role: 'engineer' }, admin);
      await svc.setPlants(id, ['demo', 'norte'], admin);
      expect(audit.entries.map((e) => [e.action, e.detail])).toEqual([
        ['user.create', { email: 'ana@campo.test', role: 'viewer', plants: ['demo'], orgId: 'A' }],
        ['user.update', { changed: ['password', 'role'], role: 'engineer' }],
        ['user.plants', { plants: ['demo', 'norte'] }],
      ]);
      expect(JSON.stringify(audit.entries)).not.toMatch(/clave-larga|\$2[aby]\$/);
      expect(audit.entries.every((e) => e.actorId === 'adm' && e.actorEmail === admin.email)).toBe(
        true,
      );
      expect([...audit.orgOfEntry.values()]).toEqual(['A', 'A', 'A']);
    });

    it('un cambio rechazado (último admin del cliente) ni sube la versión ni se audita', async () => {
      const root = await mk('root@campo.test', 'admin', 'A');
      await expect(svc.update(root.id, { active: false }, admin)).rejects.toThrow('último admin');
      expect(root.tokenVersion).toBe(0);
      expect(audit.entries).toEqual([]);
    });
  });

  describe('aislamiento por cliente', () => {
    let a1: User;
    let b1: User;
    let plat: User;

    beforeEach(async () => {
      a1 = await mk('a1@campo.test', 'engineer', 'A');
      b1 = await mk('b1@campo.test', 'engineer', 'B');
      plat = await mk('plat@campo.test', 'platform_admin', null);
    });

    it('list: un admin sólo ve a los de su cliente (nunca a B ni al personal de plataforma)', async () => {
      expect((await svc.list(admin)).map((u) => u.email)).toEqual(['a1@campo.test']);
      expect((await svc.list(admin, 'B')).map((u) => u.email)).toEqual(['a1@campo.test']); // lo ignora
      expect((await svc.list({ ...admin, org: org('B') })).map((u) => u.email)).toEqual([
        'b1@campo.test',
      ]);
    });

    it('list: platform_admin ve todos y puede filtrar; cada usuario lleva su org', async () => {
      const all = await svc.list(platform);
      expect(all.map((u) => [u.email, u.org?.id ?? null])).toEqual([
        ['a1@campo.test', 'A'],
        ['b1@campo.test', 'B'],
        ['plat@campo.test', null],
      ]);
      expect((await svc.list(platform, 'B')).map((u) => u.email)).toEqual(['b1@campo.test']);
    });

    it('un admin no puede ver, editar, revocar ni asignar plantas a un usuario de otro cliente o de plataforma (403)', async () => {
      for (const target of [b1, plat]) {
        await expect(svc.update(target.id, { active: false }, admin)).rejects.toBeInstanceOf(
          ForbiddenException,
        );
        await expect(
          svc.update(target.id, { password: 'clave-larga-123' }, admin),
        ).rejects.toBeInstanceOf(ForbiddenException);
        await expect(svc.revoke(target.id, admin)).rejects.toBeInstanceOf(ForbiddenException);
        await expect(svc.setPlants(target.id, [], admin)).rejects.toBeInstanceOf(
          ForbiddenException,
        );
      }
      expect(b1).toMatchObject({ active: true, tokenVersion: 0, plants: [] });
      expect(audit.entries).toEqual([]);
    });

    it('un admin no crea platform_admin (403) ni usuarios en otro cliente (403); sí en el suyo, aunque indique su orgId', async () => {
      const body = { email: 'x@campo.test', password: 'clave-larga-123' };
      await expect(svc.create({ ...body, role: 'platform_admin' }, admin)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      await expect(
        svc.create({ ...body, role: 'viewer', orgId: 'B' }, admin),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(await svc.create({ ...body, role: 'viewer', orgId: 'A' }, admin)).toMatchObject({
        org: { id: 'A' },
      });
      expect(users.users.some((u) => u.email === 'x@campo.test' && u.orgId === 'A')).toBe(true);
    });

    it('un admin no puede otorgar platform_admin con PATCH (403) ni asignar plantas de otro cliente o inexistentes (403 genérico)', async () => {
      await expect(svc.update(a1.id, { role: 'platform_admin' }, admin)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(a1.role).toBe('engineer');
      for (const p of ['b-1', 'no-existe']) {
        await expect(svc.setPlants(a1.id, [p], admin)).rejects.toThrow(
          'No tiene acceso a esta planta',
        );
        await expect(
          svc.create(
            { email: 'y@campo.test', password: 'clave-larga-123', role: 'viewer', plants: [p] },
            admin,
          ),
        ).rejects.toBeInstanceOf(ForbiddenException);
      }
      expect(a1.plants).toEqual([]);
      expect(users.users.some((u) => u.email === 'y@campo.test')).toBe(false);
    });

    it('platform_admin: orgId obligatorio para roles de cliente (400), cliente inexistente (404), plantas de otro cliente (400)', async () => {
      const body = { email: 'x@campo.test', password: 'clave-larga-123', role: 'viewer' as const };
      await expect(svc.create(body, platform)).rejects.toBeInstanceOf(BadRequestException);
      await expect(svc.create({ ...body, orgId: 'nadie' }, platform)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      await expect(
        svc.create({ ...body, orgId: 'A', plants: ['b-1'] }, platform),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(await svc.create({ ...body, orgId: 'B', plants: ['b-1'] }, platform)).toMatchObject({
        org: { id: 'B' },
        plants: ['b-1'],
      });
      expect(audit.orgOfEntry.get(audit.entries.at(-1)!.id)).toBe('B'); // cliente del recurso, no del actor
    });

    it('platform_admin crea otro platform_admin sin cliente (con orgId o plantas: 400) y no se le puede cambiar el rol por PATCH', async () => {
      const body = {
        email: 'p2@campo.test',
        password: 'clave-larga-123',
        role: 'platform_admin' as const,
      };
      await expect(svc.create({ ...body, orgId: 'A' }, platform)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      await expect(svc.create({ ...body, plants: ['demo'] }, platform)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      const p2 = await svc.create(body, platform);
      expect(p2).toMatchObject({ role: 'platform_admin', org: null, plants: [] });
      await expect(svc.update(p2.id, { role: 'viewer' }, platform)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      await expect(svc.update(a1.id, { role: 'platform_admin' }, platform)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      await expect(svc.setPlants(p2.id, ['demo'], platform)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('platform_admin gestiona a cualquiera; no se puede desactivar al último platform_admin', async () => {
      await expect(svc.update(b1.id, { active: false }, platform)).resolves.toMatchObject({
        active: false,
      });
      await expect(svc.update(plat.id, { active: false }, platform)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('el último admin se cuenta por cliente: A tiene otro admin, B no', async () => {
      const a = await mk('adm-a@campo.test', 'admin', 'A');
      await mk('adm-a2@campo.test', 'admin', 'A');
      const b = await mk('adm-b@campo.test', 'admin', 'B');
      await expect(svc.update(a.id, { active: false }, platform)).resolves.toMatchObject({
        active: false,
      });
      await expect(svc.update(b.id, { active: false }, platform)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });
  });
});
