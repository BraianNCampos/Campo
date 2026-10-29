import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import type Redis from 'ioredis';
import {
  MemoryAlarmRulesRepository,
  MemoryAssetsRepository,
  MemoryAuditRepository,
  MemoryPlantCatalog,
  MemoryPlantsRepository,
  MemoryUsersRepository,
} from '../../test/support/memory-repos';
import { createRedisMocks } from '../../test/support/redis-mock';
import type { AlarmRuleInput } from '../alarms/alarm.types';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/auth.types';
import { AssetsService, CATALOG_CHANGED_CHANNEL } from './assets.service';
import { CreateAssetDto, UpdateAssetDto } from './dto';

const eng: AuthUser = { id: 'eng', email: 'eng@campo.test', role: 'engineer', plants: ['demo'] };
const dto = <T extends object>(o: Partial<T>) => o as T;
const rule = (plant: string, asset: string): AlarmRuleInput => ({
  plant,
  asset,
  metric: 'level',
  operator: 'gt',
  threshold: 90,
  severity: 'critical',
  forSeconds: 0,
  hysteresis: 0,
  enabled: true,
});

describe('AssetsService', () => {
  let redis: Redis;
  let assets: MemoryAssetsRepository;
  let rules: MemoryAlarmRulesRepository;
  let audit: MemoryAuditRepository;
  let svc: AssetsService;
  let published: string[];
  let realPublish: Redis['publish'];

  beforeAll(() => {
    ({ redis } = createRedisMocks());
    realPublish = redis.publish.bind(redis);
  });

  beforeEach(async () => {
    await redis.flushall();
    assets = new MemoryAssetsRepository([
      { plant: 'demo', id: 'tk-01', name: 'T1', type: 'tank', model3dRef: 'tank', metadata: {} },
    ]);
    rules = new MemoryAlarmRulesRepository();
    audit = new MemoryAuditRepository();
    const plants = new MemoryPlantsRepository(assets, new MemoryUsersRepository());
    svc = new AssetsService(
      assets,
      rules,
      new MemoryPlantCatalog(plants, redis),
      new AuditService(audit),
      redis,
    );
    // ioredis-mock comparte los listeners de los suscriptores entre tests: se espía el PUBLISH en su lugar.
    published = [];
    redis.publish = (channel: string, message: string) => {
      if (channel === CATALOG_CHANGED_CHANNEL) published.push(message);
      return realPublish(channel, message);
    };
  });

  const flush = () => Promise.resolve();

  describe('create', () => {
    it('crea, completa los valores por defecto, publica catalog:changed y audita', async () => {
      const a = await svc.create(
        'demo',
        dto<CreateAssetDto>({ id: 'pump-01', name: 'B1', type: 'pump' }),
        eng,
      );
      expect(a).toEqual({
        plant: 'demo',
        id: 'pump-01',
        name: 'B1',
        type: 'pump',
        model3dRef: null,
        metadata: {},
      });
      await flush();
      expect(published).toEqual([JSON.stringify({ plant: 'demo' })]);
      expect(audit.entries[0]).toMatchObject({
        actorId: 'eng',
        action: 'asset.create',
        target: 'asset:demo/pump-01',
        detail: { name: 'B1', type: 'pump', model3dRef: null },
      });
    });

    it('409 si el activo ya existe (no publica ni audita); 404 si la planta no existe', async () => {
      await expect(
        svc.create('demo', dto<CreateAssetDto>({ id: 'tk-01', name: 'x', type: 'tank' }), eng),
      ).rejects.toBeInstanceOf(ConflictException);
      await expect(
        svc.create('nada', dto<CreateAssetDto>({ id: 'x1', name: 'x', type: 'tank' }), eng),
      ).rejects.toBeInstanceOf(NotFoundException);
      await flush();
      expect(published).toEqual([]);
      expect(audit.entries).toEqual([]);
    });

    it('un fallo de Redis al publicar no impide el alta', async () => {
      redis.publish = () => Promise.reject(new Error('redis caído'));
      await expect(
        svc.create('demo', dto<CreateAssetDto>({ id: 'x1', name: 'x', type: 'sensor' }), eng),
      ).resolves.toMatchObject({ id: 'x1' });
      expect(assets.assets).toHaveLength(2);
    });
  });

  describe('update', () => {
    it('modifica sólo lo enviado (null borra el modelo) y audita nombres de campo, no metadata', async () => {
      const a = await svc.update(
        'demo',
        'tk-01',
        dto<UpdateAssetDto>({ name: 'Nuevo', model3dRef: null, metadata: { secreto: 'x' } }),
        eng,
      );
      expect(a).toMatchObject({
        id: 'tk-01',
        name: 'Nuevo',
        type: 'tank',
        model3dRef: null,
        metadata: { secreto: 'x' },
      });
      await flush();
      expect(published).toHaveLength(1);
      const detail = audit.entries[0].detail;
      expect(detail).toEqual({
        changed: ['name', 'model3dRef', 'metadata'],
        name: 'Nuevo',
        model3dRef: null,
      });
      expect(JSON.stringify(audit.entries)).not.toContain('secreto');
    });

    it('400 si no hay nada que modificar o name/type son null; 404 si no existe', async () => {
      await expect(
        svc.update('demo', 'tk-01', dto<UpdateAssetDto>({}), eng),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        svc.update('demo', 'tk-01', dto<UpdateAssetDto>({ name: null as never }), eng),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        svc.update('demo', 'tk-01', dto<UpdateAssetDto>({ type: null as never }), eng),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        svc.update('demo', 'nada', dto<UpdateAssetDto>({ name: 'x' }), eng),
      ).rejects.toBeInstanceOf(NotFoundException);
      await flush();
      expect(published).toEqual([]);
    });

    it('no mueve el activo de planta ni cambia su id', async () => {
      const a = await svc.update(
        'demo',
        'tk-01',
        dto<UpdateAssetDto>({ id: 'otro', plant: 'x', name: 'N' } as never),
        eng,
      );
      expect(a).toMatchObject({ plant: 'demo', id: 'tk-01', name: 'N' });
    });
  });

  describe('remove', () => {
    it('affectedRules cuenta las reglas de ESA planta que nombran el activo (exacto, patrón o *) y no las borra', async () => {
      await rules.create(rule('demo', 'tk-01')); // exacto
      await rules.create(rule('demo', 'tk-*')); // patrón
      await rules.create(rule('demo', '*')); // todos
      await rules.create(rule('demo', '*-01')); // patrón con * al principio
      await rules.create(rule('demo', 'tk-02')); // otro activo
      await rules.create(rule('demo', 'pump-*')); // otro patrón
      await rules.create(rule('demo', 'tk-0')); // prefijo exacto, no coincide
      await rules.create(rule('otra', 'tk-01')); // otra planta

      const res = await svc.remove('demo', 'tk-01', eng);
      expect(res).toEqual({ deleted: true, affectedRules: 4 });
      expect(rules.rules.size).toBe(8);
      expect(assets.assets).toHaveLength(0);
      await flush();
      expect(published).toHaveLength(1);
      expect(audit.entries[0]).toMatchObject({
        action: 'asset.delete',
        target: 'asset:demo/tk-01',
        detail: { affectedRules: 4 },
      });
    });

    it('sin reglas -> 0; el patrón se trata como texto, no como regex', async () => {
      await rules.create(rule('demo', 'tk-01'));
      assets.assets.push({
        plant: 'demo',
        id: 'tk-x1',
        name: 'x',
        type: 'tank',
        model3dRef: null,
        metadata: {},
      });
      expect((await svc.remove('demo', 'tk-x1', eng)).affectedRules).toBe(0);
      expect((await svc.remove('demo', 'tk-01', eng)).affectedRules).toBe(1);
    });

    it('404 si no existe', async () => {
      await expect(svc.remove('demo', 'nada', eng)).rejects.toBeInstanceOf(NotFoundException);
      await flush();
      expect(published).toEqual([]);
      expect(audit.entries).toEqual([]);
    });
  });
});
