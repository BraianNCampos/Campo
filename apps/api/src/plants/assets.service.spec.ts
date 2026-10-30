import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { MODULE_IDS } from '@campo/shared';
import type Redis from 'ioredis';
import {
  MemoryAlarmRulesRepository,
  MemoryAssetsRepository,
  MemoryAuditRepository,
  MemoryModelsRepository,
  MemoryUsersRepository,
  memoryOrgs,
} from '../../test/support/memory-repos';
import { createRedisMocks } from '../../test/support/redis-mock';
import type { AlarmRuleInput } from '../alarms/alarm.types';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/auth.types';
import { CatalogNotifier } from '../redis/catalog-notifier';
import { AssetsService, CATALOG_CHANGED_CHANNEL } from './assets.service';
import { CreateAssetDto, UpdateAssetDto } from './dto';

const ORG_ID = 'campos-demo';
const eng: AuthUser = {
  id: 'eng',
  email: 'eng@campo.test',
  role: 'engineer',
  plants: ['demo'],
  org: { id: ORG_ID, name: 'Demo', modules: [] },
};
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
  let models: MemoryModelsRepository;
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
    const orgs = memoryOrgs(new MemoryUsersRepository());
    await orgs.create({ id: ORG_ID, name: 'Demo', modules: [...MODULE_IDS], active: true });
    await orgs.create({ id: 'solo-tanques', name: 'T', modules: ['tanks'], active: true });
    models = new MemoryModelsRepository(assets);
    svc = new AssetsService(
      assets,
      rules,
      orgs,
      new AuditService(audit),
      models,
      new CatalogNotifier(redis),
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
        ORG_ID,
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
      expect(audit.orgOfEntry.get(audit.entries[0].id)).toBe(ORG_ID); // auditoría con el cliente de la planta
    });

    it('409 si el activo ya existe (no publica ni audita); 404 si la planta no existe', async () => {
      await expect(
        svc.create(
          'demo',
          ORG_ID,
          dto<CreateAssetDto>({ id: 'tk-01', name: 'x', type: 'tank' }),
          eng,
        ),
      ).rejects.toBeInstanceOf(ConflictException);
      await expect(
        svc.create('nada', null, dto<CreateAssetDto>({ id: 'x1', name: 'x', type: 'tank' }), eng),
      ).rejects.toBeInstanceOf(NotFoundException);
      await flush();
      expect(published).toEqual([]);
      expect(audit.entries).toEqual([]);
    });

    it('un fallo de Redis al publicar no impide el alta', async () => {
      redis.publish = () => Promise.reject(new Error('redis caído'));
      await expect(
        svc.create(
          'demo',
          ORG_ID,
          dto<CreateAssetDto>({ id: 'x1', name: 'x', type: 'sensor' }),
          eng,
        ),
      ).resolves.toMatchObject({ id: 'x1' });
      expect(assets.assets).toHaveLength(2);
    });
  });

  describe('update', () => {
    it('modifica sólo lo enviado (null borra el modelo) y audita nombres de campo, no metadata', async () => {
      const a = await svc.update(
        'demo',
        ORG_ID,
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
        svc.update('demo', ORG_ID, 'tk-01', dto<UpdateAssetDto>({}), eng),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        svc.update('demo', ORG_ID, 'tk-01', dto<UpdateAssetDto>({ name: null as never }), eng),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        svc.update('demo', ORG_ID, 'tk-01', dto<UpdateAssetDto>({ type: null as never }), eng),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        svc.update('demo', ORG_ID, 'nada', dto<UpdateAssetDto>({ name: 'x' }), eng),
      ).rejects.toBeInstanceOf(NotFoundException);
      await flush();
      expect(published).toEqual([]);
    });

    it('no mueve el activo de planta ni cambia su id', async () => {
      const a = await svc.update(
        'demo',
        ORG_ID,
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

      const res = await svc.remove('demo', ORG_ID, 'tk-01', eng);
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
      expect((await svc.remove('demo', ORG_ID, 'tk-x1', eng)).affectedRules).toBe(0);
      expect((await svc.remove('demo', ORG_ID, 'tk-01', eng)).affectedRules).toBe(1);
    });

    it('404 si no existe', async () => {
      await expect(svc.remove('demo', ORG_ID, 'nada', eng)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      await flush();
      expect(published).toEqual([]);
      expect(audit.entries).toEqual([]);
    });
  });

  describe('model3dRef (docs/architecture.md §10.2)', () => {
    const MODEL = '11111111-1111-4111-8111-111111111111';
    const addModel = (plant: string, id = MODEL) =>
      models.rows.push({
        id,
        plant,
        name: 'm',
        size: 1,
        sha256: 'a'.repeat(64),
        createdAt: 1,
        data: Buffer.alloc(1),
        createdBy: null,
      });
    const create = (model3dRef: string | null | undefined, id = 'p-new') =>
      svc.create(
        'demo',
        ORG_ID,
        dto<CreateAssetDto>({ id, name: 'B', type: 'pump', model3dRef }),
        eng,
      );

    it('null/ausente, o model:<uuid> de un modelo de la MISMA planta', async () => {
      addModel('demo');
      expect((await create(undefined, 'a1')).model3dRef).toBeNull();
      expect((await create(null, 'a2')).model3dRef).toBeNull();
      expect((await create(`model:${MODEL}`, 'a3')).model3dRef).toBe(`model:${MODEL}`);
    });

    it.each([
      ['texto libre', 'tank'],
      ['sin prefijo', '11111111-1111-4111-8111-111111111111'],
      ['uuid en mayúsculas', 'model:11111111-1111-4111-8111-11111111111F'],
      ['uuid mal formado', 'model:1234'],
      ['prefijo distinto', 'glb:11111111-1111-4111-8111-111111111111'],
      ['con espacios', ' model:11111111-1111-4111-8111-111111111111'],
    ])('400 si el formato no es model:<uuid> (%s)', async (_n, ref) => {
      addModel('demo');
      await expect(create(ref)).rejects.toThrow(/model3dRef debe ser null o "model:<uuid>"/);
      expect(assets.assets.find((a) => a.id === 'p-new')).toBeUndefined();
    });

    it('400 si el modelo no existe', async () => {
      await expect(create(`model:${MODEL}`)).rejects.toThrow('el modelo no existe en esta planta');
    });

    it('400 si el modelo es de OTRA planta', async () => {
      addModel('norte');
      await expect(create(`model:${MODEL}`)).rejects.toBeInstanceOf(BadRequestException);
      await expect(create(`model:${MODEL}`)).rejects.toThrow('no existe en esta planta');
    });

    it('update: cambia a un modelo válido y vuelve a null; 400 si es de otra planta o inexistente', async () => {
      addModel('demo');
      addModel('norte', '22222222-2222-4222-8222-222222222222');
      const up = (d: Partial<UpdateAssetDto>) =>
        svc.update('demo', ORG_ID, 'tk-01', dto<UpdateAssetDto>(d), eng);
      expect((await up({ model3dRef: `model:${MODEL}` })).model3dRef).toBe(`model:${MODEL}`);
      await expect(
        up({ model3dRef: 'model:22222222-2222-4222-8222-222222222222' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        up({ model3dRef: 'model:33333333-3333-4333-8333-333333333333' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect((await up({ model3dRef: null })).model3dRef).toBeNull();
    });

    describe('datos anteriores a la Fase 5 (texto libre ya guardado)', () => {
      it('siguen listándose y no se tocan', async () => {
        expect((await assets.listByPlant('demo'))[0].model3dRef).toBe('tank');
      });

      it('un PATCH que no toca model3dRef no falla por el valor antiguo', async () => {
        const a = await svc.update(
          'demo',
          ORG_ID,
          'tk-01',
          dto<UpdateAssetDto>({ name: 'Nuevo' }),
          eng,
        );
        expect(a).toMatchObject({ name: 'Nuevo', model3dRef: 'tank' });
        const b = await svc.update(
          'demo',
          ORG_ID,
          'tk-01',
          dto<UpdateAssetDto>({ metadata: { a: 1 } }),
          eng,
        );
        expect(b.model3dRef).toBe('tank');
      });

      it('reenviar el mismo valor antiguo tampoco falla; cambiarlo a otro texto libre sí', async () => {
        const same = await svc.update(
          'demo',
          ORG_ID,
          'tk-01',
          dto<UpdateAssetDto>({ model3dRef: 'tank' }),
          eng,
        );
        expect(same.model3dRef).toBe('tank');
        await expect(
          svc.update('demo', ORG_ID, 'tk-01', dto<UpdateAssetDto>({ model3dRef: 'pump' }), eng),
        ).rejects.toBeInstanceOf(BadRequestException);
      });

      it('se puede migrar a null o a un modelo real', async () => {
        addModel('demo');
        expect(
          (
            await svc.update(
              'demo',
              ORG_ID,
              'tk-01',
              dto<UpdateAssetDto>({ model3dRef: null }),
              eng,
            )
          ).model3dRef,
        ).toBeNull();
        expect(
          (
            await svc.update(
              'demo',
              ORG_ID,
              'tk-01',
              dto<UpdateAssetDto>({ model3dRef: `model:${MODEL}` }),
              eng,
            )
          ).model3dRef,
        ).toBe(`model:${MODEL}`);
      });
    });
  });

  describe('metadata.layout / metadata.connectsTo (§10.3)', () => {
    const create = (metadata: Record<string, unknown>, id = 'p-new') =>
      svc.create(
        'demo',
        ORG_ID,
        dto<CreateAssetDto>({ id, name: 'B', type: 'pump', metadata }),
        eng,
      );

    it('acepta layout y connectsTo válidos junto a claves libres', async () => {
      const a = await create({
        capacityL: 5000,
        layout: { x: 3, z: -4, y: 0, rotY: 90, scale: 1.5 },
        connectsTo: ['tk-01'],
      });
      expect(a.metadata).toMatchObject({ capacityL: 5000, layout: { x: 3, z: -4 } });
      expect(a.warnings).toBeUndefined();
    });

    it('400 con el motivo si layout o connectsTo son inválidos (no se crea nada)', async () => {
      await expect(create({ layout: { x: 5000, z: 0 } })).rejects.toThrow('metadata.layout.x');
      await expect(create({ layout: { x: 0 } })).rejects.toThrow('metadata.layout.z');
      await expect(create({ connectsTo: 'tk-01' })).rejects.toThrow('metadata.connectsTo');
      await expect(create({ connectsTo: ['tk-01', 'tk-01'] })).rejects.toThrow('repetido');
      await expect(create({ connectsTo: ['Bad Id'] })).rejects.toThrow('connectsTo[0]');
      expect(assets.assets.find((a) => a.id === 'p-new')).toBeUndefined();
    });

    it('un activo no puede conectarse consigo mismo (create y update)', async () => {
      await expect(create({ connectsTo: ['p-new'] })).rejects.toThrow('consigo mismo');
      await expect(
        svc.update(
          'demo',
          ORG_ID,
          'tk-01',
          dto<UpdateAssetDto>({ metadata: { connectsTo: ['tk-01'] } }),
          eng,
        ),
      ).rejects.toThrow('consigo mismo');
    });

    it('ids de connectsTo inexistentes: se crea igual y la respuesta lleva warnings', async () => {
      const a = await create({ connectsTo: ['tk-01', 'aun-no-existe', 'otro'] });
      expect(a.warnings).toEqual([
        'connectsTo: el activo "aun-no-existe" no existe todavía en la planta',
        'connectsTo: el activo "otro" no existe todavía en la planta',
      ]);
      expect(assets.assets.find((x) => x.id === 'p-new')).toBeDefined();
      // los warnings no se guardan en el activo
      expect((await assets.get('demo', 'p-new'))?.metadata).not.toHaveProperty('warnings');
      expect(await assets.get('demo', 'p-new')).not.toHaveProperty('warnings');
    });

    it('update: valida y avisa; un PATCH sin metadata no devuelve warnings', async () => {
      const up = await svc.update(
        'demo',
        ORG_ID,
        'tk-01',
        dto<UpdateAssetDto>({ metadata: { connectsTo: ['fantasma'] } }),
        eng,
      );
      expect(up.warnings).toHaveLength(1);
      const plain = await svc.update(
        'demo',
        ORG_ID,
        'tk-01',
        dto<UpdateAssetDto>({ name: 'otro' }),
        eng,
      );
      expect(plain.warnings).toBeUndefined();
      await expect(
        svc.update(
          'demo',
          ORG_ID,
          'tk-01',
          dto<UpdateAssetDto>({ metadata: { layout: { x: 'a', z: 0 } } }),
          eng,
        ),
      ).rejects.toThrow('metadata.layout.x');
    });

    it('metadata null en update la vacía sin validar', async () => {
      const a = await svc.update(
        'demo',
        ORG_ID,
        'tk-01',
        dto<UpdateAssetDto>({ metadata: null as never }),
        eng,
      );
      expect(a.metadata).toEqual({});
    });
  });

  describe('módulos contratados (§11.2)', () => {
    const TANKS_ONLY = 'solo-tanques';
    const make = (type: string) =>
      dto<CreateAssetDto>({ id: 'nuevo', name: 'N', type: type as never });

    it.each([
      ['climate', 'climate'],
      ['energy', 'energy'],
      ['gas', 'gas'],
      ['machine', 'machines'],
      ['pressure', 'flow'],
      ['flow', 'flow'],
    ])('crear un activo %s sin el módulo %s -> 403 module_disabled', async (type, module) => {
      const err = await svc
        .create('tanques', TANKS_ONLY, make(type), eng)
        .catch((e: unknown) => e as ForbiddenException);
      expect(err).toBeInstanceOf(ForbiddenException);
      expect((err as ForbiddenException).getResponse()).toMatchObject({
        statusCode: 403,
        error: 'module_disabled',
        module,
        message: expect.any(String),
      });
      expect(assets.assets.some((a) => a.id === 'nuevo')).toBe(false);
      expect(audit.entries).toEqual([]);
    });

    it('los tipos del módulo contratado y el genérico `sensor` sí se pueden crear', async () => {
      for (const [i, type] of ['tank', 'pump', 'valve', 'sensor'].entries()) {
        await expect(
          svc.create(
            'tanques',
            TANKS_ONLY,
            dto<CreateAssetDto>({ id: `ok-${i}`, name: 'x', type: type as never }),
            eng,
          ),
        ).resolves.toMatchObject({ type });
      }
    });

    it('con todos los módulos se crean los 10 tipos', async () => {
      const types = [
        'tank',
        'pump',
        'valve',
        'sensor',
        'climate',
        'energy',
        'gas',
        'machine',
        'pressure',
        'flow',
      ];
      for (const [i, type] of types.entries()) {
        await svc.create(
          'demo',
          ORG_ID,
          dto<CreateAssetDto>({ id: `t-${i}`, name: 'x', type: type as never }),
          eng,
        );
      }
      expect(assets.assets.filter((a) => a.id.startsWith('t-'))).toHaveLength(10);
    });

    it('editar: cambiar el tipo a uno de un módulo no contratado -> 403; editar otros campos del activo existente no', async () => {
      await svc.create(
        'tanques',
        TANKS_ONLY,
        dto<CreateAssetDto>({ id: 'tk-a', name: 'A', type: 'tank' }),
        eng,
      );
      await expect(
        svc.update('tanques', TANKS_ONLY, 'tk-a', dto<UpdateAssetDto>({ type: 'gas' }), eng),
      ).rejects.toMatchObject({ response: { error: 'module_disabled', module: 'gas' } });
      // mismo tipo / otros campos: no se revalida el módulo (desactivar un módulo no rompe lo ya creado)
      await expect(
        svc.update(
          'tanques',
          TANKS_ONLY,
          'tk-a',
          dto<UpdateAssetDto>({ type: 'tank', name: 'B' }),
          eng,
        ),
      ).resolves.toMatchObject({ name: 'B' });
    });

    it('si el cliente deja de tener el módulo, los activos ya creados se siguen pudiendo editar', async () => {
      assets.assets.push({
        plant: 'tanques',
        id: 'old',
        name: 'x',
        type: 'gas',
        model3dRef: null,
        metadata: {},
      });
      await expect(
        svc.update('tanques', TANKS_ONLY, 'old', dto<UpdateAssetDto>({ name: 'sigue' }), eng),
      ).resolves.toMatchObject({ name: 'sigue' });
    });

    it('planta sin cliente registrado (orgId null) -> 404', async () => {
      await expect(svc.create('live', null, make('tank'), eng)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('metadatos de dominio (capacityM3, contractedKw, scale)', () => {
    const create = (metadata: Record<string, unknown>) =>
      svc.create(
        'demo',
        ORG_ID,
        dto<CreateAssetDto>({ id: 'm1', name: 'x', type: 'tank', metadata }),
        eng,
      );

    it('acepta valores válidos', async () => {
      await expect(
        create({
          capacityM3: 60,
          contractedKw: 220.5,
          scale: { level: { min: 0, max: 100 }, temp: { min: -10, max: 50 } },
        }),
      ).resolves.toMatchObject({ id: 'm1' });
    });

    it.each([
      [{ capacityM3: 0 }],
      [{ capacityM3: -1 }],
      [{ capacityM3: '60' }],
      [{ capacityM3: null }],
      [{ contractedKw: 0 }],
      [{ contractedKw: Infinity }],
      [{ scale: [] }],
      [{ scale: { level: { min: 10, max: 10 } } }],
      [{ scale: { level: { min: 10, max: 1 } } }],
      [{ scale: { level: { min: 0 } } }],
      [{ scale: { level: { min: 0, max: 1, extra: 1 } } }],
      [{ scale: { level: { min: '0', max: 1 } } }],
      [{ scale: { 'mala métrica': { min: 0, max: 1 } } }],
      [{ scale: { level: 5 } }],
    ])('rechaza %j con 400', async (metadata) => {
      await expect(create(metadata as Record<string, unknown>)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });
});
