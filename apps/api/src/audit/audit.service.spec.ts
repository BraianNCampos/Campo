import { Logger } from '@nestjs/common';
import type { AuthUser } from '../auth/auth.types';
import { MemoryAuditRepository } from '../../test/support/memory-repos';
import { AUDIT_ACTIONS, AUDIT_FIELDS, sanitizeDetail } from './audit.fields';
import { AuditService } from './audit.service';

const actor = { id: '11111111-1111-4111-8111-111111111111', email: 'admin@campo.test' };
const BCRYPT = '$2b$12$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ0123456';
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1In0.firmafirmafirma';

describe('AuditService', () => {
  let repo: MemoryAuditRepository;
  let svc: AuditService;

  beforeEach(() => {
    repo = new MemoryAuditRepository();
    svc = new AuditService(repo);
  });

  describe('qué se registra', () => {
    it('guarda actor, acción, destino y los campos permitidos de la acción', async () => {
      await svc.record(actor, 'asset.create', 'asset:demo/tk-01', 'campos-demo', {
        name: 'Tanque',
        type: 'tank',
        model3dRef: null,
      });
      expect(repo.entries).toEqual([
        {
          id: '1',
          ts: expect.any(Number),
          actorId: actor.id,
          actorEmail: actor.email,
          action: 'asset.create',
          target: 'asset:demo/tk-01',
          orgId: 'campos-demo',
          detail: { name: 'Tanque', type: 'tank', model3dRef: null },
        },
      ]);
    });

    it('sin actor (p. ej. tarea interna) guarda null', async () => {
      await svc.record(null, 'plant.create', 'plant:x', 'campos-demo', { name: 'X' });
      expect(repo.entries[0]).toMatchObject({ actorId: null, actorEmail: null });
    });

    it('cada acción documentada tiene su lista de campos y las acciones sin detalle guardan {}', async () => {
      expect(AUDIT_ACTIONS).toEqual(
        expect.arrayContaining([
          'user.create',
          'user.update',
          'user.plants',
          'user.revoke',
          'me.password',
          'plant.create',
          'plant.update',
          'plant.delete',
          'asset.create',
          'asset.update',
          'asset.delete',
          'model.upload',
          'model.delete',
          'rule.create',
          'rule.update',
          'rule.delete',
          'alarm.ack',
        ]),
      );
      await svc.record(actor, 'me.password', 'user:1', 'campos-demo', {
        newPassword: 'x',
        currentPassword: 'y',
      });
      await svc.record(actor, 'user.revoke', 'user:1', 'campos-demo', { token: JWT });
      expect(repo.entries.map((e) => e.detail)).toEqual([{}, {}]);
    });
  });

  describe('qué NUNCA se registra', () => {
    const SECRET_KEYS = [
      'password',
      'newPassword',
      'currentPassword',
      'passwordHash',
      'password_hash',
      'hash',
      'token',
      'accessToken',
      'authorization',
      'secret',
      'metadata',
    ];

    it('ninguna lista de campos permitidos contiene nombres de secretos', () => {
      for (const [action, fields] of Object.entries(AUDIT_FIELDS)) {
        for (const f of fields as readonly string[]) {
          expect({
            action,
            f,
            secretLike: /pass|hash|token|secret|authorization/i.test(f),
          }).toEqual({
            action,
            f,
            secretLike: false,
          });
        }
      }
    });

    it('para toda acción, un detalle hostil sólo conserva campos de su lista', () => {
      const hostile = Object.fromEntries(SECRET_KEYS.map((k) => [k, `valor-${k}`]));
      for (const action of AUDIT_ACTIONS) {
        const allowed = AUDIT_FIELDS[action] as readonly string[];
        const out = sanitizeDetail(action, { ...hostile, nombre: 'x' });
        expect(Object.keys(out).filter((k) => !allowed.includes(k))).toEqual([]);
        expect(JSON.stringify(out)).not.toContain('valor-');
      }
    });

    it('user.update: guarda qué campos cambiaron, no la contraseña', async () => {
      await svc.record(actor, 'user.update', 'user:1', 'campos-demo', {
        changed: ['role', 'password'],
        role: 'viewer',
        password: 'clave-super-secreta-1',
        passwordHash: BCRYPT,
        token: JWT,
      });
      const [entry] = repo.entries;
      expect(entry.detail).toEqual({ changed: ['role', 'password'], role: 'viewer' });
      expect(JSON.stringify(entry)).not.toMatch(/clave-super-secreta|\$2b\$|eyJ/);
    });

    it('model.upload / model.delete: sólo nombre, tamaño, hash, dedup e id; nunca el contenido', async () => {
      await svc.record(actor, 'model.upload', 'model:demo/x', 'campos-demo', {
        name: 'Bomba',
        size: 3004,
        sha256: 'a'.repeat(64),
        dedup: false,
        data: Buffer.from('glTF...'),
        content: 'AAAA',
        base64: 'AAAA',
      });
      await svc.record(actor, 'model.delete', 'model:demo/x', 'campos-demo', {
        name: 'Bomba',
        id: 'x',
        data: 'AAAA',
      });
      expect(repo.entries.map((e) => e.detail)).toEqual([
        { name: 'Bomba', size: 3004, sha256: 'a'.repeat(64), dedup: false },
        { name: 'Bomba', id: 'x' },
      ]);
    });

    it('asset.update: no guarda el contenido de metadata', async () => {
      await svc.record(actor, 'asset.update', 'asset:demo/tk-01', 'campos-demo', {
        changed: ['metadata'],
        metadata: { apiKey: 'abc123', capacityL: 5000 },
      });
      expect(repo.entries[0].detail).toEqual({ changed: ['metadata'] });
    });

    it('aunque un campo permitido traiga un hash bcrypt o un JWT, se descarta', () => {
      expect(
        sanitizeDetail('user.create', { email: BCRYPT, role: JWT, plants: [BCRYPT, 'demo'] }),
      ).toEqual({ plants: ['demo'] });
    });

    it('descarta objetos anidados y valores no finitos; acota longitudes', () => {
      const out = sanitizeDetail('asset.create', {
        name: 'n'.repeat(500),
        type: { nested: 'x' },
        model3dRef: Number.NaN,
      });
      expect(out).toEqual({ name: 'n'.repeat(200) });
      const many = sanitizeDetail('user.plants', {
        plants: Array.from({ length: 500 }, (_, i) => `p${i}`),
      });
      expect((many.plants as string[]).length).toBe(200);
      expect(sanitizeDetail('user.plants', { plants: [{ a: 1 }, 'demo'] })).toEqual({
        plants: ['demo'],
      });
    });
  });

  describe('un fallo de auditoría no tumba la operación', () => {
    it('record() no lanza si la escritura falla y deja el error en el log de errores (sin el detalle)', async () => {
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      try {
        repo.failWith = new Error('relation "audit_log" does not exist');
        await expect(
          svc.record(actor, 'user.update', 'user:1', 'campos-demo', {
            changed: ['password'],
            password: 'secreto',
          }),
        ).resolves.toBeUndefined();
        expect(repo.entries).toHaveLength(0);
        expect(error).toHaveBeenCalledTimes(1);
        const logged = error.mock.calls[0][0] as Record<string, unknown>;
        expect(logged).toMatchObject({
          msg: 'no se pudo escribir la auditoría',
          action: 'user.update',
          target: 'user:1',
          actorId: actor.id,
          error: 'relation "audit_log" does not exist',
        });
        expect(JSON.stringify(logged)).not.toContain('secreto');
      } finally {
        error.mockRestore();
      }
    });
  });

  describe('lectura', () => {
    const platform: AuthUser = {
      id: 'p',
      email: 'p@campo.test',
      role: 'platform_admin',
      plants: ['*'],
      org: null,
    };
    const adminOf = (id: string): AuthUser => ({
      id: `adm-${id}`,
      email: `adm@${id}.test`,
      role: 'admin',
      plants: ['*'],
      org: { id, name: id, modules: [] },
    });

    beforeEach(async () => {
      for (let i = 0; i < 5; i++) {
        await svc.record(
          i % 2 ? actor : { id: 'x', email: 'otro@campo.test' },
          'plant.create',
          `plant:p${i}`,
          'campos-demo',
          { name: `P${i}` },
        );
      }
      await svc.record(actor, 'plant.delete', 'plant:p0', 'campos-demo');
    });

    it('más recientes primero, límite por defecto 50', async () => {
      const all = await svc.list({}, adminOf('campos-demo'));
      expect(all.map((e) => e.target)).toEqual([
        'plant:p0',
        'plant:p4',
        'plant:p3',
        'plant:p2',
        'plant:p1',
        'plant:p0',
      ]);
    });

    it('limit, before, actor (id o email) y action', async () => {
      const a = adminOf('campos-demo');
      expect((await svc.list({ limit: 2 }, a)).map((e) => e.id)).toEqual(['6', '5']);
      expect((await svc.list({ limit: 2, before: '5' }, a)).map((e) => e.id)).toEqual(['4', '3']);
      expect((await svc.list({ action: 'plant.delete' }, a)).map((e) => e.id)).toEqual(['6']);
      expect((await svc.list({ actor: ' OTRO@campo.test ' }, a)).map((e) => e.actorId)).toEqual([
        'x',
        'x',
        'x',
      ]);
      expect((await svc.list({ actor: actor.id }, a)).map((e) => e.id)).toEqual(['6', '4', '2']);
    });

    describe('por cliente', () => {
      beforeEach(async () => {
        await svc.record(actor, 'plant.create', 'plant:b1', 'cliente-b', { name: 'B1' });
        await svc.record(null, 'org.create', 'org:cliente-b', null, { name: 'x' });
      });

      it('un admin sólo ve su cliente e ignora cualquier filtro de cliente', async () => {
        const a = await svc.list({ orgId: 'cliente-b', org: 'cliente-b' }, adminOf('campos-demo'));
        expect(a).toHaveLength(6);
        expect(a.every((e) => e.target !== 'plant:b1')).toBe(true);
        const b = await svc.list({}, adminOf('cliente-b'));
        expect(b.map((e) => e.target)).toEqual(['plant:b1']);
      });

      it('platform_admin ve todo (también lo sin cliente) y filtra con orgId u org', async () => {
        expect(await svc.list({}, platform)).toHaveLength(8);
        expect((await svc.list({ orgId: 'cliente-b' }, platform)).map((e) => e.target)).toEqual([
          'plant:b1',
        ]);
        expect((await svc.list({ org: 'cliente-b' }, platform)).map((e) => e.target)).toEqual([
          'plant:b1',
        ]);
      });

      it('un usuario sin cliente que no es platform_admin no ve nada', async () => {
        const broken: AuthUser = { ...adminOf('x'), org: null };
        expect(await svc.list({}, broken)).toEqual([]);
      });
    });
  });
});
