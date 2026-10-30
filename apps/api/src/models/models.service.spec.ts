import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import type Redis from 'ioredis';
import { bigMeshGlb, sampleGlbs, triangleGlb } from '../../test/support/glb';
import {
  MemoryAssetsRepository,
  MemoryAuditRepository,
  MemoryModelsRepository,
} from '../../test/support/memory-repos';
import { createRedisMocks } from '../../test/support/redis-mock';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/auth.types';
import { CATALOG_CHANGED_CHANNEL, CatalogNotifier } from '../redis/catalog-notifier';
import { GLB_LIMITS } from './glb-validator';
import { ModelsService, etagMatches } from './models.service';

const admin: AuthUser = { id: 'adm', email: 'admin@campo.test', role: 'admin', plants: ['*'] };
const eng: AuthUser = { id: 'eng', email: 'eng@campo.test', role: 'engineer', plants: ['demo'] };
const viewer: AuthUser = { id: 'v', email: 'v@campo.test', role: 'viewer', plants: ['demo'] };
const otherPlant: AuthUser = {
  id: 'o',
  email: 'o@campo.test',
  role: 'operator',
  plants: ['norte'],
};
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

describe('etagMatches', () => {
  const s = 'a'.repeat(64);
  it.each([
    [`"${s}"`, true],
    [s, true],
    [`W/"${s}"`, true],
    [`"otro", "${s}"`, true],
    [`  "${s}"  `, true],
    ['*', true],
    ['"otro"', false],
    ['', false],
    [undefined, false],
    [`"${s}x"`, false],
  ])('%s -> %s', (header, expected) => {
    expect(etagMatches(header, s)).toBe(expected);
  });
});

describe('ModelsService', () => {
  let redis: Redis;
  let repo: MemoryModelsRepository;
  let assets: MemoryAssetsRepository;
  let audit: MemoryAuditRepository;
  let svc: ModelsService;
  let published: string[];
  let realPublish: Redis['publish'];

  beforeAll(() => {
    ({ redis } = createRedisMocks());
    realPublish = redis.publish.bind(redis);
  });

  beforeEach(async () => {
    await redis.flushall();
    assets = new MemoryAssetsRepository();
    repo = new MemoryModelsRepository(assets);
    audit = new MemoryAuditRepository();
    svc = new ModelsService(repo, new AuditService(audit), new CatalogNotifier(redis));
    published = [];
    redis.publish = (channel: string, message: string) => {
      if (channel === CATALOG_CHANGED_CHANNEL) published.push(message);
      return realPublish(channel, message);
    };
  });

  describe('upload', () => {
    it('valida, guarda, devuelve ModelInfo, publica catalog:changed y audita sin contenido', async () => {
      const glb = triangleGlb();
      const { model, created } = await svc.upload('demo', 'Tanque', glb, eng);
      expect(created).toBe(true);
      expect(model).toEqual({
        id: expect.stringMatching(/^[0-9a-f-]{36}$/),
        plant: 'demo',
        name: 'Tanque',
        size: glb.length,
        sha256: sha(glb),
        createdAt: expect.any(Number),
      });
      expect(repo.rows[0].createdBy).toBe('eng');
      expect(published).toEqual([JSON.stringify({ plant: 'demo' })]);
      expect(audit.entries).toEqual([
        expect.objectContaining({
          action: 'model.upload',
          target: `model:demo/${model.id}`,
          actorId: 'eng',
          detail: { name: 'Tanque', size: glb.length, sha256: sha(glb), dedup: false },
        }),
      ]);
      expect(JSON.stringify(audit.entries)).not.toContain(glb.toString('base64').slice(0, 20));
    });

    it('acepta los GLB de ejemplo', async () => {
      for (const s of sampleGlbs()) {
        const { model } = await svc.upload('demo', s.name, s.data, eng);
        expect(model.size).toBe(s.data.length);
      }
      expect(await svc.list('demo')).toHaveLength(4);
    });

    it('deduplica por sha256 dentro de la planta: devuelve el existente, sin publicar y auditando dedup:true', async () => {
      const glb = triangleGlb();
      const first = await svc.upload('demo', 'Uno', glb, eng);
      published.length = 0;
      const second = await svc.upload('demo', 'Otro nombre', Buffer.from(glb), admin);
      expect(second.created).toBe(false);
      expect(second.model).toEqual(first.model); // conserva el nombre original
      expect(repo.rows).toHaveLength(1);
      expect(published).toEqual([]);
      expect(audit.entries.at(-1)).toMatchObject({
        action: 'model.upload',
        detail: { name: 'Uno', dedup: true, sha256: sha(glb) },
      });
    });

    it('el mismo contenido en otra planta es otro modelo', async () => {
      const glb = triangleGlb();
      const a = await svc.upload('demo', 'm', glb, admin);
      const b = await svc.upload('norte', 'm', glb, admin);
      expect(a.created && b.created).toBe(true);
      expect(a.model.id).not.toBe(b.model.id);
    });

    it('GLB inválido: 400 con el motivo y nada se guarda ni se publica ni se audita', async () => {
      const bad = triangleGlb((j) => (j.buffers[0].uri = 'http://evil.example/x.bin'));
      await expect(svc.upload('demo', 'x', bad, eng)).rejects.toThrow(
        /GLB no válido: buffers\[0\]\.uri apunta a un recurso externo/,
      );
      await expect(svc.upload('demo', 'x', bad, eng)).rejects.toBeInstanceOf(BadRequestException);
      await expect(svc.upload('demo', 'x', bigMeshGlb(200_001), eng)).rejects.toThrow(
        '200001 vértices',
      );
      expect(repo.rows).toHaveLength(0);
      expect(published).toEqual([]);
      expect(audit.entries).toHaveLength(0);
    });

    it('cuerpo vacío o que no es un GLB: 400', async () => {
      await expect(svc.upload('demo', 'x', Buffer.alloc(0), eng)).rejects.toThrow(/vacío/);
      await expect(svc.upload('demo', 'x', Buffer.from('hola'), eng)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('más de 10 MB: 413 (defensa en profundidad; el límite real lo aplica el body parser)', async () => {
      await expect(
        svc.upload('demo', 'x', Buffer.alloc(GLB_LIMITS.maxBytes + 1), eng),
      ).rejects.toBeInstanceOf(PayloadTooLargeException);
    });
  });

  describe('download', () => {
    let id: string;
    let glb: Buffer;
    beforeEach(async () => {
      glb = triangleGlb();
      id = (await svc.upload('demo', 'm', glb, eng)).model.id;
    });

    it('devuelve info y bytes idénticos a los subidos', async () => {
      const res = await svc.download(viewer, id);
      expect(res.info.sha256).toBe(sha(glb));
      expect(res.data?.equals(glb)).toBe(true);
    });

    it.each([
      ['admin', admin],
      ['engineer de la planta', eng],
      ['viewer de la planta', viewer],
    ])('%s puede descargar', async (_n, user) => {
      await expect(svc.download(user, id)).resolves.toMatchObject({ data: expect.any(Buffer) });
    });

    it('un usuario de otra planta (o sin plantas) recibe 403 genérico, sin leer el contenido', async () => {
      repo.dataReads = 0;
      for (const u of [otherPlant, { ...viewer, plants: [] }]) {
        const e = await svc.download(u, id).catch((x: unknown) => x);
        expect(e).toBeInstanceOf(ForbiddenException);
        expect((e as ForbiddenException).message).toBe('No tiene acceso a esta planta');
      }
      expect(repo.dataReads).toBe(0);
    });

    it('If-None-Match coincidente: data null (304) sin leer el contenido', async () => {
      repo.dataReads = 0;
      const res = await svc.download(viewer, id, `"${sha(glb)}"`);
      expect(res.data).toBeNull();
      expect(repo.dataReads).toBe(0);
      // no coincide -> contenido completo
      expect((await svc.download(viewer, id, '"otro"')).data).not.toBeNull();
    });

    it('el 304 tampoco se concede a quien no tiene acceso a la planta', async () => {
      await expect(svc.download(otherPlant, id, `"${sha(glb)}"`)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('modelo inexistente: 404', async () => {
      await expect(
        svc.download(admin, '00000000-0000-4000-8000-000000000000'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('list', () => {
    it('sólo los modelos de la planta, sin contenido, más recientes primero', async () => {
      const a = await svc.upload('demo', 'a', triangleGlb(), eng);
      await new Promise((r) => setTimeout(r, 3));
      const b = await svc.upload(
        'demo',
        'b',
        triangleGlb((j) => (j.asset.generator = 'otro')),
        eng,
      );
      await svc.upload('norte', 'n', triangleGlb(), admin);
      const list = await svc.list('demo');
      expect(list.map((m) => m.id)).toEqual([b.model.id, a.model.id]);
      expect(Object.keys(list[0]).sort()).toEqual(
        ['createdAt', 'id', 'name', 'plant', 'sha256', 'size'].sort(),
      );
    });
  });

  describe('remove', () => {
    let id: string;
    beforeEach(async () => {
      id = (await svc.upload('demo', 'Bomba', triangleGlb(), eng)).model.id;
      published.length = 0;
    });
    const asset = (aid: string, ref: string | null) => ({
      plant: 'demo',
      id: aid,
      name: aid,
      type: 'pump' as const,
      model3dRef: ref,
      metadata: {},
    });

    it('borra, publica y audita name e id', async () => {
      await expect(svc.remove('demo', id, eng)).resolves.toEqual({ deleted: true });
      expect(repo.rows).toHaveLength(0);
      expect(published).toEqual([JSON.stringify({ plant: 'demo' })]);
      expect(audit.entries.at(-1)).toMatchObject({
        action: 'model.delete',
        target: `model:demo/${id}`,
        detail: { name: 'Bomba', id },
      });
    });

    it('409 con la lista de activos que lo usan; no se borra nada', async () => {
      await assets.create(asset('p2', `model:${id}`));
      await assets.create(asset('p1', `model:${id}`));
      await assets.create(asset('p3', null));
      const e = await svc.remove('demo', id, eng).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(ConflictException);
      expect((e as ConflictException).getResponse()).toMatchObject({
        statusCode: 409,
        assets: ['p1', 'p2'],
        message: expect.stringContaining('2 activo(s)'),
      });
      expect(repo.rows).toHaveLength(1);
      expect(published).toEqual([]);
      expect(audit.entries.filter((x) => x.action === 'model.delete')).toHaveLength(0);
    });

    it('una vez liberado el modelo se puede borrar', async () => {
      await assets.create(asset('p1', `model:${id}`));
      await expect(svc.remove('demo', id, eng)).rejects.toBeInstanceOf(ConflictException);
      await assets.update('demo', 'p1', { model3dRef: null });
      await expect(svc.remove('demo', id, eng)).resolves.toEqual({ deleted: true });
    });

    it('404 si no existe o es de otra planta', async () => {
      await expect(svc.remove('norte', id, admin)).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        svc.remove('demo', '00000000-0000-4000-8000-000000000000', admin),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(repo.rows).toHaveLength(1);
    });
  });
});
