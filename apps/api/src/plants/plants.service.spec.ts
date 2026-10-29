import { ConflictException, NotFoundException } from '@nestjs/common';
import { redisKeys } from '@campo/shared';
import type Redis from 'ioredis';
import {
  MemoryAssetsRepository,
  MemoryAuditRepository,
  MemoryPlantCatalog,
  MemoryPlantsRepository,
  MemoryUsersRepository,
} from '../../test/support/memory-repos';
import { createRedisMocks } from '../../test/support/redis-mock';
import { AuditService } from '../audit/audit.service';
import { AccessService } from '../auth/access.service';
import { InMemoryInvalidationBus } from '../auth/auth-invalidation';
import type { AuthUser } from '../auth/auth.types';
import { parseEnv } from '../config/app-config';
import { PlantsService } from './plants.service';

const cfg = parseEnv({ JWT_SECRET: 's'.repeat(40), NODE_ENV: 'test' });
const admin: AuthUser = { id: 'adm', email: 'admin@campo.test', role: 'admin', plants: ['*'] };
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
  let audit: MemoryAuditRepository;
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
    audit = new MemoryAuditRepository();
    access = new AccessService(users, new InMemoryInvalidationBus(), cfg);
    svc = new PlantsService(
      plants,
      new MemoryPlantCatalog(plants, redis),
      access,
      new AuditService(audit),
      redis,
    );
  });

  describe('list', () => {
    it('admin: une plants, plantas con activos y plantas con estado en Redis (nombre = id si no hay otro)', async () => {
      await plants.create('norte', 'Planta Norte');
      await redis.hset(redisKeys.state('solo-redis'), 'x', '{}');
      await redis.hset(redisKeys.state('norte'), 'x', '{}'); // ya registrada: no se duplica
      await redis.set('campo:state:BAD_ID', '1'); // clave que no es una planta válida
      await redis.hset('campo:alarms:active:demo', 'x', '{}'); // otras claves campo:* no cuentan
      expect(await svc.list(admin)).toEqual([
        { id: 'demo', name: 'demo', assets: 2 },
        { id: 'norte', name: 'Planta Norte', assets: 0 },
        { id: 'solo-redis', name: 'solo-redis', assets: 0 },
      ]);
    });

    it('resto de roles: sólo las asignadas, aunque aún no estén registradas', async () => {
      await plants.create('norte', 'Planta Norte');
      const op: AuthUser = { id: 'u', email: 'u', role: 'operator', plants: ['norte', 'fantasma'] };
      expect(await svc.list(op)).toEqual([
        { id: 'fantasma', name: 'fantasma', assets: 0 },
        { id: 'norte', name: 'Planta Norte', assets: 0 },
      ]);
      expect(await svc.list({ ...op, plants: [] })).toEqual([]);
    });

    it('si Redis falla, el admin sigue viendo las plantas de la base', async () => {
      redis.scan = () => Promise.reject(new Error('redis caído'));
      expect(await svc.list(admin)).toEqual([{ id: 'demo', name: 'demo', assets: 2 }]);
    });
  });

  describe('create / rename', () => {
    it('crea una planta vacía y audita; 409 si ya existe (registrada o con activos)', async () => {
      expect(await svc.create('norte', 'Norte', admin)).toEqual({
        id: 'norte',
        name: 'Norte',
        assets: 0,
      });
      await expect(svc.create('norte', 'Otra', admin)).rejects.toBeInstanceOf(ConflictException);
      await expect(svc.create('demo', 'Demo', admin)).rejects.toBeInstanceOf(ConflictException);
      expect(audit.entries.map((e) => [e.action, e.target, e.detail])).toEqual([
        ['plant.create', 'plant:norte', { name: 'Norte' }],
      ]);
    });

    it('cambia el nombre; una planta conocida sólo por activos o Redis se registra; 404 si no existe', async () => {
      await plants.create('norte', 'Norte');
      expect(await svc.rename('norte', 'Norte 2', admin)).toEqual({
        id: 'norte',
        name: 'Norte 2',
        assets: 0,
      });
      expect((await svc.rename('demo', 'Demo', admin)).assets).toBe(2); // sólo por activos
      await redis.hset(redisKeys.state('viva'), 'x', '{}');
      expect(await svc.rename('viva', 'Viva', admin)).toEqual({
        id: 'viva',
        name: 'Viva',
        assets: 0,
      });
      await expect(svc.rename('nada', 'x', admin)).rejects.toBeInstanceOf(NotFoundException);
      expect(audit.entries.at(-1)).toMatchObject({ action: 'plant.update', target: 'plant:viva' });
    });
  });

  describe('remove', () => {
    it('409 si tiene activos y no toca nada', async () => {
      const u = (await users.create({ email: 'a@b.c', passwordHash: 'x', role: 'operator' }))!;
      await users.setPlants(u.id, ['demo']);
      await expect(svc.remove('demo', admin)).rejects.toBeInstanceOf(ConflictException);
      expect(users.users[0].plants).toEqual(['demo']);
      expect(audit.entries).toHaveLength(0);
    });

    it('borra la planta, limpia las asignaciones, invalida a los afectados y audita', async () => {
      await plants.create('norte', 'Norte');
      const a = (await users.create({ email: 'a@b.c', passwordHash: 'x', role: 'operator' }))!;
      const b = (await users.create({ email: 'b@b.c', passwordHash: 'x', role: 'viewer' }))!;
      const c = (await users.create({ email: 'c@b.c', passwordHash: 'x', role: 'viewer' }))!;
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
      await expect(svc.remove('norte', admin)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('una planta sólo asignada (sin fila en plants) también se limpia', async () => {
      const a = (await users.create({ email: 'a@b.c', passwordHash: 'x', role: 'operator' }))!;
      await users.setPlants(a.id, ['huerfana']);
      expect(await svc.remove('huerfana', admin)).toEqual({ deleted: true });
      expect(users.users[0].plants).toEqual([]);
    });
  });
});
