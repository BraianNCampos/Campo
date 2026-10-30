import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { AssetDef, AuditEntry, ModelInfo } from '@campo/shared';
import request from 'supertest';
import type { App } from 'supertest/types';
import { WebSocket } from 'ws';
import { GLB_LIMITS } from '../src/models/glb-validator';
import { SAMPLES_DIR, bigMeshGlb, glb, sampleGlbs, triangleGlb } from './support/glb';
import { createTestApp, TestApp } from './support/test-app';

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const GLB = 'model/gltf-binary';
const MISSING = '00000000-0000-4000-8000-000000000000';

interface Socket {
  messages: { type: string; plant?: string }[];
  close: () => void;
}
function open(url: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const messages: Socket['messages'] = [];
    ws.on('message', (d) => messages.push(JSON.parse((d as Buffer).toString())));
    ws.on('open', () => resolve({ messages, close: () => ws.close() }));
    ws.on('error', reject);
  });
}
const catalogs = (s: Socket) => s.messages.filter((m) => m.type === 'catalog');

describe('Catálogo vivo y modelos 3D (e2e)', () => {
  let t: TestApp;
  let http: App;
  let wsBase: string;
  let admin: string;
  let engineer: { id: string; token: string };
  let viewer: { token: string };
  let operator: { token: string };
  let norteEngineer: { token: string };
  let norteViewer: { token: string };
  const samples = sampleGlbs();
  const pump = samples.find((s) => s.name === 'sample-pump.glb')!.data;

  const api = {
    get: (path: string, token?: string) => {
      const r = request(http).get(path);
      return token ? r.set(bearer(token)) : r;
    },
    post: (path: string, token: string) => request(http).post(path).set(bearer(token)),
    patch: (path: string, token: string) => request(http).patch(path).set(bearer(token)),
    delete: (path: string, token: string) => request(http).delete(path).set(bearer(token)),
    upload: (plant: string, token: string, body: Buffer | string, name = 'Modelo') =>
      request(http)
        .post(`/api/plants/${plant}/models?name=${encodeURIComponent(name)}`)
        .set(bearer(token))
        .set('Content-Type', GLB)
        .send(body),
    download: (id: string, token?: string, headers: Record<string, string> = {}) => {
      const r = request(http)
        .get(`/api/models/${id}`)
        .set(headers)
        .buffer(true)
        .parse((res, cb) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => cb(null, Buffer.concat(chunks)));
        });
      return token ? r.set(bearer(token)) : r;
    },
  };

  beforeAll(async () => {
    t = await createTestApp({ wsCatalogCoalesceMs: 50, wsRevalidateMs: 5000 });
    await t.app.listen(0, '127.0.0.1');
    http = t.app.getHttpServer() as App;
    wsBase = `ws://127.0.0.1:${(t.app.getHttpServer().address() as AddressInfo).port}/ws`;
    admin = await t.tokenFor('admin');
    engineer = await t.makeUser('ing@campo.test', 'engineer', ['demo']);
    viewer = await t.makeUser('vw@campo.test', 'viewer', ['demo']);
    operator = await t.makeUser('op@campo.test', 'operator', ['demo']);
    await api.post('/api/plants', admin).send({ id: 'norte', name: 'Norte' }).expect(201);
    norteEngineer = await t.makeUser('ing-n@campo.test', 'engineer', ['norte']);
    norteViewer = await t.makeUser('vw-n@campo.test', 'viewer', ['norte']);
  });

  afterAll(async () => {
    await t.app.close();
  });

  describe('flujo principal', () => {
    let model: ModelInfo;

    it('un engineer sube un GLB crudo: 201 y ModelInfo', async () => {
      const res = await api.upload('demo', engineer.token, pump, 'Bomba principal').expect(201);
      model = res.body as ModelInfo;
      expect(model).toEqual({
        id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
        plant: 'demo',
        name: 'Bomba principal',
        size: pump.length,
        sha256: sha(pump),
        createdAt: expect.any(Number),
      });
    });

    it('subir el mismo contenido otra vez devuelve el existente con 200 (dedup)', async () => {
      const res = await api
        .upload('demo', engineer.token, Buffer.from(pump), 'Otro nombre')
        .expect(200);
      expect(res.body).toEqual(model);
      expect(t.models.rows.filter((r) => r.plant === 'demo')).toHaveLength(1);
    });

    it('lo lista cualquier rol con acceso a la planta; otra planta: 403; sin token: 401', async () => {
      for (const tok of [admin, engineer.token, operator.token, viewer.token]) {
        const res = await api.get('/api/plants/demo/models', tok).expect(200);
        expect(res.body).toEqual([model]);
      }
      await api.get('/api/plants/demo/models', norteViewer.token).expect(403);
      await api.get('/api/plants/demo/models').expect(401);
      expect(
        (await api.get('/api/plants/norte/models', norteViewer.token).expect(200)).body,
      ).toEqual([]);
    });

    it('el engineer lo referencia desde un activo; otro usuario de la planta descarga bytes idénticos', async () => {
      const res = await api
        .post('/api/plants/demo/assets', engineer.token)
        .send({ id: 'pump-9', name: 'Bomba 9', type: 'pump', model3dRef: `model:${model.id}` })
        .expect(201);
      expect((res.body as AssetDef).model3dRef).toBe(`model:${model.id}`);

      const dl = await api.download(model.id, viewer.token).expect(200);
      const bytes = dl.body as Buffer;
      expect(bytes.equals(pump)).toBe(true);
      expect(sha(bytes)).toBe(model.sha256);
      expect(dl.headers['content-type']).toBe(GLB);
      expect(dl.headers['etag']).toBe(`"${model.sha256}"`);
      expect(dl.headers['cache-control']).toBe('private, max-age=31536000, immutable');
      expect(dl.headers['content-length']).toBe(String(pump.length));
    });

    it('If-None-Match con el ETag -> 304 sin cuerpo y con las cabeceras de caché', async () => {
      const etag = `"${model.sha256}"`;
      for (const header of [etag, `W/${etag}`, `"zzz", ${etag}`, '*']) {
        const res = await api
          .download(model.id, viewer.token, { 'If-None-Match': header })
          .expect(304);
        expect((res.body as Buffer).length).toBe(0);
        expect(res.headers['etag']).toBe(etag);
        expect(res.headers['cache-control']).toContain('immutable');
      }
      // un ETag distinto devuelve el contenido
      await api.download(model.id, viewer.token, { 'If-None-Match': '"otro"' }).expect(200);
    });

    it('un usuario de OTRA planta recibe 403 genérico (también con If-None-Match); sin token 401', async () => {
      const a = await api.download(model.id, norteViewer.token).expect(403);
      expect((a.body as Buffer).toString()).toContain('No tiene acceso a esta planta');
      await api
        .download(model.id, norteEngineer.token, { 'If-None-Match': `"${model.sha256}"` })
        .expect(403);
      await api.download(model.id).expect(401);
    });

    it('404 para un id inexistente y 400 para un id que no es UUID', async () => {
      await api.download(MISSING, admin).expect(404);
      await api.download('no-es-uuid', admin).expect(400);
    });

    it('borrar con referencias: 409 con la lista de activos; con permisos insuficientes 403', async () => {
      await api
        .post('/api/plants/demo/assets', engineer.token)
        .send({ id: 'pump-8', name: 'Bomba 8', type: 'pump', model3dRef: `model:${model.id}` })
        .expect(201);
      const res = await api
        .delete(`/api/plants/demo/models/${model.id}`, engineer.token)
        .expect(409);
      expect(res.body).toMatchObject({ statusCode: 409, assets: ['pump-8', 'pump-9'] });
      expect((res.body as { message: string }).message).toContain('2 activo(s)');
      await api.delete(`/api/plants/demo/models/${model.id}`, viewer.token).expect(403);
      await api.delete(`/api/plants/demo/models/${model.id}`, operator.token).expect(403);
      await api.delete(`/api/plants/demo/models/${model.id}`, norteEngineer.token).expect(403);
      await api.download(model.id, viewer.token).expect(200); // sigue ahí
    });

    it('liberado el modelo se borra (200) y desaparece; reintentar da 404', async () => {
      for (const id of ['pump-8', 'pump-9']) {
        await api
          .patch(`/api/plants/demo/assets/${id}`, engineer.token)
          .send({ model3dRef: null })
          .expect(200);
      }
      const res = await api
        .delete(`/api/plants/demo/models/${model.id}`, engineer.token)
        .expect(200);
      expect(res.body).toEqual({ deleted: true });
      await api.download(model.id, viewer.token).expect(404);
      expect((await api.get('/api/plants/demo/models', viewer.token)).body).toEqual([]);
      await api.delete(`/api/plants/demo/models/${model.id}`, engineer.token).expect(404);
    });
  });

  describe('permisos de subida y borrado (matriz rol x planta)', () => {
    it.each([
      ['viewer', () => viewer.token, 403],
      ['operator', () => operator.token, 403],
      ['engineer de otra planta', () => norteEngineer.token, 403],
      ['engineer de la planta', () => engineer.token, 201],
      ['admin', () => admin, 201],
    ])('%s', async (_n, token, status) => {
      const g = triangleGlb((j) => (j.asset.generator = `perm-${status}-${_n}`));
      await api.upload('demo', token(), g).expect(status);
    });

    it('sin token: 401; planta inexistente: 403 (admin) / 404 (platform_admin); id inválido: 400', async () => {
      await request(http)
        .post('/api/plants/demo/models?name=x')
        .set('Content-Type', GLB)
        .send(triangleGlb())
        .expect(401);
      await api.upload('fantasma', admin, triangleGlb()).expect(403);
      await api.upload('fantasma', await t.tokenFor('platform_admin'), triangleGlb()).expect(404);
      await api.upload('BAD_PLANT', admin, triangleGlb()).expect(400);
    });

    it('un usuario sin permiso con un cuerpo enorme recibe 403 sin que se almacene nada', async () => {
      const before = t.models.rows.length;
      await api.upload('demo', viewer.token, Buffer.alloc(GLB_LIMITS.maxBytes + 1024)).expect(403);
      await api
        .upload('demo', norteEngineer.token, Buffer.alloc(GLB_LIMITS.maxBytes + 1024))
        .expect(403);
      expect(t.models.rows.length).toBe(before);
    });
  });

  describe('referencias desde activos (model3dRef)', () => {
    let demoModel: ModelInfo;
    let norteModel: ModelInfo;

    beforeAll(async () => {
      demoModel = (await api.upload('demo', engineer.token, samples[0].data, 'demo-1').expect(201))
        .body as ModelInfo;
      norteModel = (
        await api.upload('norte', norteEngineer.token, samples[0].data, 'norte-1').expect(201)
      ).body as ModelInfo;
    });

    const create = (token: string, plant: string, id: string, model3dRef: unknown) =>
      api
        .post(`/api/plants/${plant}/assets`, token)
        .send({ id, name: id, type: 'tank', model3dRef });

    it('null y modelo de la misma planta: 201', async () => {
      await create(engineer.token, 'demo', 'r-null', null).expect(201);
      await create(engineer.token, 'demo', 'r-ok', `model:${demoModel.id}`).expect(201);
    });

    it('modelo de OTRA planta, inexistente, o texto libre: 400', async () => {
      const other = await create(engineer.token, 'demo', 'r-otra', `model:${norteModel.id}`).expect(
        400,
      );
      expect(JSON.stringify(other.body)).toContain('no existe en esta planta');
      await create(engineer.token, 'demo', 'r-nada', `model:${MISSING}`).expect(400);
      await create(engineer.token, 'demo', 'r-txt', 'tank').expect(400);
      await create(engineer.token, 'demo', 'r-up', `model:${demoModel.id.toUpperCase()}`).expect(
        400,
      );
      expect(
        t.assets.assets.some((a) => a.id.startsWith('r-') && /otra|nada|txt|up/.test(a.id)),
      ).toBe(false);
    });

    it('PATCH: cambia/limpia la referencia con las mismas reglas', async () => {
      const url = '/api/plants/demo/assets/r-null';
      await api
        .patch(url, engineer.token)
        .send({ model3dRef: `model:${norteModel.id}` })
        .expect(400);
      const ok = await api
        .patch(url, engineer.token)
        .send({ model3dRef: `model:${demoModel.id}` })
        .expect(200);
      expect((ok.body as AssetDef).model3dRef).toBe(`model:${demoModel.id}`);
      await api.patch(url, engineer.token).send({ model3dRef: null }).expect(200);
    });

    it('datos antiguos: el activo semilla con model3dRef "tank" se lista y se edita sin tocar la referencia', async () => {
      const list = (await api.get('/api/plants/demo/assets', viewer.token).expect(200))
        .body as AssetDef[];
      expect(list.find((a) => a.id === 'tk-01')?.model3dRef).toBe('tank');
      const res = await api
        .patch('/api/plants/demo/assets/tk-01', engineer.token)
        .send({ name: 'Tanque renombrado' })
        .expect(200);
      expect(res.body).toMatchObject({ name: 'Tanque renombrado', model3dRef: 'tank' });
      // reenviar el mismo valor antiguo se tolera; cambiarlo a otro texto libre no
      await api
        .patch('/api/plants/demo/assets/tk-01', engineer.token)
        .send({ model3dRef: 'tank' })
        .expect(200);
      await api
        .patch('/api/plants/demo/assets/tk-01', engineer.token)
        .send({ model3dRef: 'otro' })
        .expect(400);
    });
  });

  describe('validación del GLB y del cuerpo', () => {
    const msg = (res: request.Response) => (res.body as { message: string }).message;

    it('GLB con uri externa: 400 con el motivo', async () => {
      const res = await api
        .upload(
          'demo',
          engineer.token,
          triangleGlb((j) => (j.buffers[0].uri = 'http://evil.example/x.bin')),
        )
        .expect(400);
      expect(msg(res)).toMatch(/^GLB no válido: buffers\[0\]\.uri apunta a un recurso externo/);
    });

    it('Draco, versión 1, demasiados vértices, truncado, basura y texto: 400', async () => {
      const draco = triangleGlb((j) => (j.extensionsRequired = ['KHR_draco_mesh_compression']));
      expect(msg(await api.upload('demo', engineer.token, draco).expect(400))).toContain('Draco');
      const v1 = triangleGlb(undefined, { version: 1 });
      expect(msg(await api.upload('demo', engineer.token, v1).expect(400))).toContain(
        'Versión de contenedor',
      );
      expect(
        msg(await api.upload('demo', engineer.token, bigMeshGlb(200_001)).expect(400)),
      ).toContain('200001 vértices');
      expect(
        msg(
          await api.upload('demo', engineer.token, pump.subarray(0, pump.length - 40)).expect(400),
        ),
      ).toContain('no coincide');
      await api.upload('demo', engineer.token, Buffer.from('esto no es un glb')).expect(400);
      await api.upload('demo', engineer.token, '{"asset":{"version":"2.0"}}').expect(400);
    });

    it('cuerpo vacío: 400; sin ?name: 400; name vacío, largo o con control: 400', async () => {
      expect(msg(await api.upload('demo', engineer.token, Buffer.alloc(0)).expect(400))).toMatch(
        /vacío/,
      );
      const g = triangleGlb((j) => (j.asset.generator = 'nombres'));
      const raw = (qs: string) =>
        request(http)
          .post(`/api/plants/demo/models${qs}`)
          .set(bearer(engineer.token))
          .set('Content-Type', GLB)
          .send(g);
      await raw('').expect(400);
      await raw('?name=').expect(400);
      await raw('?name=%20%20').expect(400);
      await raw(`?name=${'a'.repeat(101)}`).expect(400);
      await raw('?name=a%0Ab').expect(400);
      await raw('?name=ok&extra=1').expect(400);
      await raw(`?name=${'a'.repeat(100)}`).expect(201);
    });

    it('Content-Type incorrecto (JSON, multipart, ausente): 415', async () => {
      const g = triangleGlb((j) => (j.asset.generator = 'ct'));
      await request(http)
        .post('/api/plants/demo/models?name=x')
        .set(bearer(engineer.token))
        .set('Content-Type', 'application/json')
        .send({ a: 1 })
        .expect(415);
      await request(http)
        .post('/api/plants/demo/models?name=x')
        .set(bearer(engineer.token))
        .attach('file', g, 'm.glb')
        .expect(415);
      await request(http)
        .post('/api/plants/demo/models?name=x')
        .set(bearer(engineer.token))
        .expect(415);
      // application/octet-stream se acepta
      await request(http)
        .post('/api/plants/demo/models?name=x')
        .set(bearer(engineer.token))
        .set('Content-Type', 'application/octet-stream')
        .send(g)
        .expect(201);
    });

    it('los 4 GLB de ejemplo se suben y se descargan idénticos', async () => {
      for (const s of samples) {
        const up = (
          await api
            .upload('norte', norteEngineer.token, s.data, s.name)
            .expect(s.data.equals(samples[0].data) ? 200 : 201)
        ).body as ModelInfo;
        const dl = await api.download(up.id, norteViewer.token).expect(200);
        expect(sha(dl.body as Buffer)).toBe(sha(s.data));
      }
      expect(SAMPLES_DIR).toContain('examples/models');
    });
  });

  describe('límite de tamaño (10 MB)', () => {
    /** GLB válido de exactamente `size` bytes (BIN relleno). */
    const glbOfSize = (size: number): Buffer => {
      let n = 44;
      for (let i = 0; i < 6; i++) {
        const g = triangleGlb((j) => (j.buffers[0].byteLength = n), undefined, Buffer.alloc(n));
        if (g.length === size) return g;
        n += size - g.length;
      }
      throw new Error('no se pudo ajustar el tamaño');
    };

    it('exactamente 10 MB se acepta', async () => {
      const g = glbOfSize(GLB_LIMITS.maxBytes);
      expect(g.length).toBe(10 * 1024 * 1024);
      const res = await api.upload('demo', engineer.token, g, 'grande').expect(201);
      expect((res.body as ModelInfo).size).toBe(GLB_LIMITS.maxBytes);
      const dl = await api.download((res.body as ModelInfo).id, viewer.token).expect(200);
      expect(sha(dl.body as Buffer)).toBe(sha(g));
    });

    it('más de 10 MB: 413 con mensaje claro, sin guardar, y la API sigue sirviendo', async () => {
      const before = t.models.rows.length;
      const big = Buffer.alloc(GLB_LIMITS.maxBytes + 1);
      glb({}).copy(big); // da igual el contenido: se corta por tamaño
      const res = await api.upload('demo', engineer.token, big).expect(413);
      expect((res.body as { message: string }).message).toBe('El modelo supera el límite de 10 MB');
      await api.upload('demo', engineer.token, Buffer.alloc(11 * 1024 * 1024)).expect(413);
      expect(t.models.rows.length).toBe(before);
      await request(http).get('/health').expect(200);
      await api
        .upload(
          'demo',
          engineer.token,
          triangleGlb((j) => (j.asset.generator = 'tras-413')),
        )
        .expect(201);
    });

    it('el límite global del resto de la API no cambia: un JSON de > 100 KB sigue dando 413', async () => {
      const res = await api
        .post('/api/plants/demo/assets', engineer.token)
        .send({ id: 'big', name: 'x', type: 'tank', metadata: { blob: 'z'.repeat(150_000) } });
      expect(res.status).toBe(413);
    });
  });

  describe('metadata.layout / connectsTo', () => {
    const body = (id: string, metadata: unknown) => ({ id, name: id, type: 'pump', metadata });
    const post = (b: object) => api.post('/api/plants/demo/assets', engineer.token).send(b);

    it('válido: 201 sin warnings cuando los ids existen', async () => {
      const res = await post(
        body('l-ok', {
          layout: { x: 3, z: -4.5, rotY: 90, scale: 2 },
          connectsTo: ['tk-01', 'pump-01'],
        }),
      ).expect(201);
      expect(res.body).not.toHaveProperty('warnings');
      expect((res.body as AssetDef).metadata).toMatchObject({
        layout: { x: 3 },
        connectsTo: ['tk-01', 'pump-01'],
      });
    });

    it('connectsTo con ids que no existen: 201 y warnings informativos; se pueden crear después', async () => {
      const res = await post(body('l-warn', { connectsTo: ['l-despues'] })).expect(201);
      expect((res.body as { warnings: string[] }).warnings).toEqual([
        'connectsTo: el activo "l-despues" no existe todavía en la planta',
      ]);
      await post(body('l-despues', { connectsTo: ['l-warn'] })).expect(201);
      const upd = await api
        .patch('/api/plants/demo/assets/l-warn', engineer.token)
        .send({ metadata: { connectsTo: ['l-despues'] } })
        .expect(200);
      expect(upd.body).not.toHaveProperty('warnings');
    });

    it.each([
      ['layout fuera de rango', { layout: { x: 1001, z: 0 } }, 'metadata.layout.x'],
      ['layout sin z', { layout: { x: 1 } }, 'metadata.layout.z'],
      ['layout con NaN en cadena', { layout: { x: 'NaN', z: 0 } }, 'metadata.layout.x'],
      ['scale 0', { layout: { x: 0, z: 0, scale: 0 } }, 'metadata.layout.scale'],
      ['layout con clave extra', { layout: { x: 0, z: 0, w: 1 } }, 'metadata.layout.w'],
      ['connectsTo no lista', { connectsTo: 'tk-01' }, 'metadata.connectsTo'],
      ['connectsTo con id inválido', { connectsTo: ['Bad Id'] }, 'connectsTo[0]'],
      ['connectsTo duplicado', { connectsTo: ['tk-01', 'tk-01'] }, 'repetido'],
      ['connectsTo a sí mismo', { connectsTo: ['l-self'] }, 'consigo mismo'],
      [
        'connectsTo con 33 ids',
        { connectsTo: Array.from({ length: 33 }, (_, i) => `a-${i}`) },
        'como máximo 32',
      ],
    ])('400: %s', async (_n, metadata, expected) => {
      const res = await post(body('l-self', metadata)).expect(400);
      expect(JSON.stringify(res.body)).toContain(expected);
    });

    it('sigue el límite de 8 KB de metadata', async () => {
      await post(body('l-big', { blob: 'z'.repeat(9000) })).expect(400);
    });

    it('PATCH con layout inválido: 400', async () => {
      await api
        .patch('/api/plants/demo/assets/l-ok', engineer.token)
        .send({ metadata: { layout: { x: 'a', z: 0 } } })
        .expect(400);
    });
  });

  describe('auditoría', () => {
    it('model.upload (con dedup) y model.delete, sin contenido', async () => {
      const g = triangleGlb((j) => (j.asset.generator = 'auditoria'));
      const up = (await api.upload('demo', engineer.token, g, 'Para auditar').expect(201))
        .body as ModelInfo;
      await api.upload('demo', admin, g, 'Repetido').expect(200);
      await api.delete(`/api/plants/demo/models/${up.id}`, engineer.token).expect(200);

      const entries = (await api.get('/api/audit?limit=200', admin).expect(200))
        .body as AuditEntry[];
      const mine = entries.filter((e) => e.target === `model:demo/${up.id}`);
      expect(mine.map((e) => e.action)).toEqual(['model.delete', 'model.upload', 'model.upload']);
      expect(mine[0]).toMatchObject({
        actorId: engineer.id,
        detail: { name: 'Para auditar', id: up.id },
      });
      expect(mine[1].detail).toEqual({
        name: 'Para auditar',
        size: g.length,
        sha256: sha(g),
        dedup: true,
      });
      expect(mine[2].detail).toEqual({
        name: 'Para auditar',
        size: g.length,
        sha256: sha(g),
        dedup: false,
      });
      expect(JSON.stringify(entries)).not.toContain(g.toString('base64').slice(0, 24));
      const filtered = (await api.get('/api/audit?action=model.upload', admin).expect(200))
        .body as AuditEntry[];
      expect(filtered.every((e) => e.action === 'model.upload')).toBe(true);
    });
  });

  describe('catálogo vivo por WebSocket', () => {
    let demoWs: Socket;
    let norteWs: Socket;

    beforeAll(async () => {
      demoWs = await open(`${wsBase}?plant=demo&token=${viewer.token}`);
      norteWs = await open(`${wsBase}?plant=norte&token=${norteViewer.token}`);
      await sleep(150);
    });
    afterAll(() => {
      demoWs.close();
      norteWs.close();
    });

    const settle = () => sleep(250);
    const mark = () => ({ demo: catalogs(demoWs).length, norte: catalogs(norteWs).length });

    it('subir un modelo avisa a los clientes de esa planta y no a los de otra', async () => {
      const m = mark();
      await api
        .upload(
          'demo',
          engineer.token,
          triangleGlb((j) => (j.asset.generator = 'ws-1')),
        )
        .expect(201);
      await settle();
      expect(catalogs(demoWs).length).toBe(m.demo + 1);
      expect(catalogs(demoWs).at(-1)).toEqual({ type: 'catalog', plant: 'demo' });
      expect(catalogs(norteWs).length).toBe(m.norte);
    });

    it('un dedup no cambia nada y no avisa', async () => {
      const g = triangleGlb((j) => (j.asset.generator = 'ws-dedup'));
      await api.upload('demo', engineer.token, g).expect(201);
      await settle();
      const m = mark();
      await api.upload('demo', engineer.token, g).expect(200);
      await settle();
      expect(mark()).toEqual(m);
    });

    it('crear/editar/borrar un activo avisa; una ráfaga se agrupa', async () => {
      const m = mark();
      for (const id of ['w-1', 'w-2', 'w-3', 'w-4', 'w-5']) {
        await api
          .post('/api/plants/demo/assets', engineer.token)
          .send({ id, name: id, type: 'tank' })
          .expect(201);
      }
      await settle();
      const delta = catalogs(demoWs).length - m.demo;
      expect(delta).toBeGreaterThanOrEqual(1);
      expect(delta).toBeLessThan(5);
      expect(catalogs(norteWs).length).toBe(m.norte);
      const m2 = mark();
      await api
        .patch('/api/plants/demo/assets/w-1', engineer.token)
        .send({ name: 'nuevo' })
        .expect(200);
      await settle();
      await api.delete('/api/plants/demo/assets/w-1', engineer.token).expect(200);
      await settle();
      expect(catalogs(demoWs).length).toBe(m2.demo + 2);
    });

    it('borrar un modelo, y crear/renombrar una planta, avisan', async () => {
      const g = triangleGlb((j) => (j.asset.generator = 'ws-del'));
      const up = (await api.upload('norte', norteEngineer.token, g).expect(201)).body as ModelInfo;
      await settle();
      let m = mark();
      await api.delete(`/api/plants/norte/models/${up.id}`, norteEngineer.token).expect(200);
      await settle();
      expect(catalogs(norteWs).length).toBe(m.norte + 1);
      expect(catalogs(demoWs).length).toBe(m.demo);

      m = mark();
      await api.patch('/api/plants/norte', admin).send({ name: 'Norte 2' }).expect(200);
      await settle();
      expect(catalogs(norteWs).length).toBe(m.norte + 1);
      expect(catalogs(demoWs).length).toBe(m.demo);

      // un admin de cliente no puede abrir un socket a una planta aún no registrada: lo hace plataforma
      const wsNew = await open(`${wsBase}?plant=nueva&token=${await t.tokenFor('platform_admin')}`);
      await sleep(100);
      await api.post('/api/plants', admin).send({ id: 'nueva', name: 'Nueva' }).expect(201);
      await settle();
      expect(catalogs(wsNew)).toEqual([{ type: 'catalog', plant: 'nueva' }]);
      wsNew.close();
    });

    it('el gateway no filtra mensajes de otras plantas (ni telemetría ni catálogo)', async () => {
      const m = mark();
      await t.redis.publish('campo:catalog:changed', JSON.stringify({ plant: 'otra-planta' }));
      await t.redis.publish('campo:catalog:changed', JSON.stringify({ plant: 'norte' }));
      await t.redis.publish('campo:catalog:changed', 'basura');
      await settle();
      expect(catalogs(demoWs).length).toBe(m.demo);
      expect(catalogs(norteWs).length).toBe(m.norte + 1);
      expect(norteWs.messages.every((x) => x.plant === 'norte')).toBe(true);
      expect(demoWs.messages.every((x) => x.plant === 'demo')).toBe(true);
    });
  });

  describe('borrado de una planta', () => {
    it('elimina también sus modelos 3D', async () => {
      await api.post('/api/plants', admin).send({ id: 'efimera', name: 'Efímera' }).expect(201);
      await api
        .upload(
          'efimera',
          admin,
          triangleGlb((j) => (j.asset.generator = 'efimera')),
        )
        .expect(201);
      expect(t.models.rows.some((r) => r.plant === 'efimera')).toBe(true);
      await api.delete('/api/plants/efimera', admin).expect(200);
      expect(t.models.rows.some((r) => r.plant === 'efimera')).toBe(false);
    });
  });
});
