import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import type Redis from 'ioredis';
import {
  MemoryAssetsRepository,
  MemoryAuditRepository,
  MemoryModelsRepository,
  MemoryOrgsRepository,
  MemoryPlantCatalog,
  MemoryPlantsRepository,
  MemoryUsersRepository,
} from '../../test/support/memory-repos';
import { createRedisMocks } from '../../test/support/redis-mock';
import { AuditService } from '../audit/audit.service';
import { AccessService } from '../auth/access.service';
import { InMemoryInvalidationBus } from '../auth/auth-invalidation';
import type { AuthUser } from '../auth/auth.types';
import { TenantScope } from '../auth/tenant-scope';
import { parseEnv } from '../config/app-config';
import { CatalogNotifier } from '../redis/catalog-notifier';
import { PlantsService } from './plants.service';

const cfg = parseEnv({ JWT_SECRET: 's'.repeat(40), NODE_ENV: 'test' });
const org = (id: string) => ({ id, name: id, modules: [] });
const admin: AuthUser = {
  id: 'adm',
  email: 'admin@campo.test',
  role: 'admin',
  plants: ['*'],
  org: org('A'),
};
const adminB: AuthUser = { ...admin, id: 'admb', org: org('B') };
const platform: AuthUser = { ...admin, id: 'plat', role: 'platform_admin', org: null };
const asset = (plant: string, id: string) => ({
  plant,
  id,
  name: id,
  type: 'tank' as const,
  model3dRef: null,
  metadata: {},
});

describe('PlantsService', () => {
  let redis: Redis;
  let assets: MemoryAssetsRepository;
  let users: MemoryUsersRepository;
  let plants: MemoryPlantsRepository;
  let orgs: MemoryOrgsRepository;
  let audit: MemoryAuditRepository;
  let models: MemoryModelsRepository;
  let access: AccessService;
  let svc: PlantsService;

  beforeAll(() => {
    ({ redis } = createRedisMocks());
  });

  beforeEach(async () => {
    await redis.flushall();
    assets = new MemoryAssetsRepository([asset('demo', 'tk-01'), asset('demo', 'tk-02')]);
    users = new MemoryUsersRepository();
    plants = new MemoryPlantsRepository(assets, users);
    plants.register('demo', 'A');
    orgs = new MemoryOrgsRepository(() => plants, users);
    await orgs.create({ id: 'A', name: 'A', modules: [], active: true });
    await orgs.create({ id: 'B', name: 'B', modules: [], active: true });
    audit = new MemoryAuditRepository();
    models = new MemoryModelsRepository(assets);
    access = new AccessService(users, orgs, new InMemoryInvalidationBus(), cfg);
    const catalog = new MemoryPlantCatalog(plants, redis);
    svc = new PlantsService(
      plants,
      catalog,
      new TenantScope(catalog),
      orgs,
      access,
      new AuditService(audit),
      models,
      new CatalogNotifier(redis),
    );
  });

  describe('list', () => {
    it('admin: sólo las plantas registradas de SU cliente (con orgId); nunca las de otro ni las sólo con telemetría', async () => {
      await plants.create('norte', 'Planta Norte', 'A');
      await plants.create('b-1', 'De B', 'B');
      await redis.hset('campo:state:solo-redis', 'x', '{}'); // sin registrar: de nadie
      expect(await svc.list(admin)).toEqual([
        { id: 'demo', name: 'demo', assets: 2, orgId: 'A' },
        { id: 'norte', name: 'Planta Norte', assets: 0, orgId: 'A' },
      ]);
      expect((await svc.list(adminB)).map((p) => p.id)).toEqual(['b-1']);
    });

    it('?orgId= lo ignora un admin y lo aplica platform_admin; platform_admin sin filtro ve todo', async () => {
      await plants.create('b-1', 'De B', 'B');
      expect((await svc.list(admin, 'B')).map((p) => p.id)).toEqual(['demo']);
      expect((await svc.list(platform)).map((p) => p.id)).toEqual(['b-1', 'demo']);
      expect((await svc.list(platform, 'B')).map((p) => p.id)).toEqual(['b-1']);
      expect(await svc.list(platform, 'nadie')).toEqual([]);
    });

    it('resto de roles: sólo las asignadas que son de su cliente', async () => {
      await plants.create('norte', 'Planta Norte', 'A');
      await plants.create('b-1', 'De B', 'B');
      const op: AuthUser = {
        id: 'u',
        email: 'u',
        role: 'operator',
        plants: ['norte', 'fantasma', 'b-1'],
        org: org('A'),
      };
      expect(await svc.list(op)).toEqual([
        { id: 'norte', name: 'Planta Norte', assets: 0, orgId: 'A' },
      ]);
      expect(await svc.list({ ...op, plants: [] })).toEqual([]);
    });
  });

  describe('create / rename', () => {
    it('un admin crea en su cliente y audita con ese cliente; 409 si ya existe (registrada, con activos o de otro cliente)', async () => {
      expect(await svc.create('norte', 'Norte', undefined, admin)).toEqual({
        id: 'norte',
        name: 'Norte',
        assets: 0,
        orgId: 'A',
      });
      await expect(svc.create('norte', 'Otra', undefined, admin)).rejects.toBeInstanceOf(
        ConflictException,
      );
      await expect(svc.create('demo', 'Demo', undefined, adminB)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(audit.entries.map((e) => [e.action, e.target, e.detail])).toEqual([
        ['plant.create', 'plant:norte', { name: 'Norte' }],
      ]);
      expect(audit.orgOfEntry.get('1')).toBe('A');
    });

    it('un admin no puede crear en otro cliente (403); si indica el suyo, bien', async () => {
      await expect(svc.create('x1', 'X', 'B', admin)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(svc.create('x1', 'X', 'A', admin)).resolves.toMatchObject({ orgId: 'A' });
    });

    it('platform_admin: orgId obligatorio (400), el cliente debe existir (404) y la planta queda en él', async () => {
      await expect(svc.create('x1', 'X', undefined, platform)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      await expect(svc.create('x1', 'X', 'nadie', platform)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(await svc.create('x1', 'X', 'B', platform)).toMatchObject({ orgId: 'B' });
      expect(audit.orgOfEntry.get('1')).toBe('B'); // auditoría con el cliente del recurso, no el del actor
    });

    it('un admin no puede quedarse con una planta que ya emite telemetría sin estar registrada; plataforma sí', async () => {
      await redis.hset('campo:state:viva', 'x', '{}');
      await expect(svc.create('viva', 'Viva', undefined, admin)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(await svc.create('viva', 'Viva', 'B', platform)).toMatchObject({
        id: 'viva',
        orgId: 'B',
      });
    });

    it('cambia el nombre (no el cliente); sin acceso o inexistente -> 403 al admin, 404 a platform_admin', async () => {
      await plants.create('norte', 'Norte', 'A');
      expect(await svc.rename('norte', 'Norte 2', admin)).toEqual({
        id: 'norte',
        name: 'Norte 2',
        assets: 0,
        orgId: 'A',
      });
      await expect(svc.rename('norte', 'x', adminB)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(svc.rename('nada', 'x', admin)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(svc.rename('nada', 'x', platform)).rejects.toBeInstanceOf(NotFoundException);
      expect((await svc.rename('norte', 'N3', platform)).orgId).toBe('A');
      expect(audit.entries.at(-1)).toMatchObject({ action: 'plant.update', target: 'plant:norte' });
      expect(audit.orgOfEntry.get(audit.entries.at(-1)!.id)).toBe('A');
    });
  });

  describe('remove', () => {
    it('409 si tiene activos y no toca nada', async () => {
      const u = (await users.create({
        email: 'a@b.c',
        passwordHash: 'x',
        role: 'operator',
        orgId: 'A',
      }))!;
      await users.setPlants(u.id, ['demo']);
      await expect(svc.remove('demo', admin)).rejects.toBeInstanceOf(ConflictException);
      expect(users.users[0].plants).toEqual(['demo']);
      expect(audit.entries).toHaveLength(0);
    });

    it('un admin de otro cliente recibe 403 y no se borra nada', async () => {
      await plants.create('norte', 'Norte', 'A');
      await expect(svc.remove('norte', adminB)).rejects.toBeInstanceOf(ForbiddenException);
      expect(plants.orgOf('norte')).toBe('A');
    });

    it('borra la planta, limpia asignaciones, invalida a los afectados y audita con el cliente', async () => {
      await plants.create('norte', 'Norte', 'A');
      const mk = async (e: string, role: 'operator' | 'viewer') =>
        (await users.create({ email: e, passwordHash: 'x', role, orgId: 'A' }))!;
      const a = await mk('a@b.c', 'operator');
      const b = await mk('b@b.c', 'viewer');
      const c = await mk('c@b.c', 'viewer');
      await users.setPlants(a.id, ['norte', 'demo']);
      await users.setPlants(b.id, ['norte']);
      await users.setPlants(c.id, ['demo']);
      const invalidated: string[] = [];
      access.invalidations$.subscribe((id) => invalidated.push(id));

      expect(await svc.remove('norte', admin)).toEqual({ deleted: true });
      expect(users.users.map((u) => u.plants)).toEqual([['demo'], [], ['demo']]);
      expect(invalidated.sort()).toEqual([a.id, b.id].sort());
      expect(audit.entries[0]).toMatchObject({
        action: 'plant.delete',
        target: 'plant:norte',
        detail: { unassignedUsers: 2 },
      });
      expect(audit.orgOfEntry.get('1')).toBe('A');
      await expect(svc.remove('norte', admin)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(svc.remove('norte', platform)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('al borrar una planta se van también sus reglas y alarmas: quien reutilice el id no hereda nada', async () => {
      await plants.create('norte', 'Norte', 'A');
      const cleared: string[] = [];
      plants.onRemoved.push((id) => cleared.push(id));
      await svc.remove('norte', admin);
      expect(cleared).toEqual(['norte']);
      await expect(svc.create('norte', 'Mía', undefined, adminB)).resolves.toMatchObject({
        orgId: 'B',
      });
    });
  });

  describe('catálogo vivo y modelos (§10.1)', () => {
    let published: string[];
    beforeEach(() => {
      published = [];
      const real = redis.publish.bind(redis);
      redis.publish = (channel: string, message: string) => {
        if (channel === 'campo:catalog:changed') published.push(message);
        return real(channel, message);
      };
    });

    it('crear, renombrar y borrar una planta publican campo:catalog:changed {plant}', async () => {
      await svc.create('norte', 'Norte', undefined, admin);
      await svc.rename('norte', 'Norte 2', admin);
      await svc.remove('norte', admin);
      expect(published).toEqual(Array(3).fill(JSON.stringify({ plant: 'norte' })));
    });

    it('no publica si la operación falla (409/403)', async () => {
      await expect(svc.create('demo', 'x', undefined, admin)).rejects.toBeInstanceOf(
        ConflictException,
      );
      await expect(svc.rename('fantasma', 'x', admin)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(svc.remove('demo', admin)).rejects.toBeInstanceOf(ConflictException);
      expect(published).toEqual([]);
    });

    it('borrar una planta borra sus modelos 3D (y sólo los suyos)', async () => {
      await svc.create('norte', 'Norte', undefined, admin);
      const row = (plant: string, sha: string) => ({
        id: `${sha}0000000-0000-4000-8000-000000000000`,
        plant,
        name: 'm',
        size: 1,
        sha256: sha.repeat(64),
        createdAt: 1,
        data: Buffer.alloc(1),
        createdBy: null,
      });
      models.rows.push(row('norte', 'a'), row('norte', 'b'), row('demo', 'c'));
      await svc.remove('norte', admin);
      expect(models.rows.map((r) => r.plant)).toEqual(['demo']);
    });

    it('si falla el borrado de modelos la planta ya está borrada y no lanza', async () => {
      await svc.create('norte', 'Norte', undefined, admin);
      models.deleteByPlant = () => Promise.reject(new Error('db caída'));
      await expect(svc.remove('norte', admin)).resolves.toEqual({ deleted: true });
    });
  });
});
