import {
  MemoryOrgsRepository,
  MemoryUsersRepository,
  memoryOrgs,
} from '../../test/support/memory-repos';
import { parseEnv } from '../config/app-config';
import { AccessService } from './access.service';
import { InMemoryInvalidationBus } from './auth-invalidation';

const cfg = (ttl: number) =>
  parseEnv({
    JWT_SECRET: 's'.repeat(40),
    NODE_ENV: 'test',
    AUTH_CACHE_TTL_MS: String(ttl),
  });

describe('AccessService', () => {
  let users: MemoryUsersRepository;
  let orgs: MemoryOrgsRepository;
  let bus: InMemoryInvalidationBus;
  let id: string;

  const make = (ttl = 30_000) => {
    const svc = new AccessService(users, orgs, bus, cfg(ttl));
    svc.onModuleInit();
    return svc;
  };

  beforeEach(async () => {
    jest.useFakeTimers();
    users = new MemoryUsersRepository();
    orgs = memoryOrgs(users);
    await orgs.create({ id: 'acme', name: 'Acme', modules: ['tanks'], active: true });
    bus = new InMemoryInvalidationBus();
    const u = await users.create({
      email: 'ana@campo.test',
      passwordHash: 'x',
      role: 'operator',
      orgId: 'acme',
    });
    id = u!.id;
    await users.setPlants(id, ['demo']);
  });

  afterEach(() => jest.useRealTimers());

  it('devuelve rol y plantas de la base', async () => {
    const svc = make();
    await expect(svc.getAccess(id)).resolves.toEqual({
      id,
      email: 'ana@campo.test',
      role: 'operator',
      plants: ['demo'],
      org: { id: 'acme', name: 'Acme', modules: ['tanks'] },
    });
  });

  it('admin -> plants ["*"]', async () => {
    const admin = (await users.create({
      email: 'a@campo.test',
      passwordHash: 'x',
      role: 'admin',
      orgId: 'acme',
    }))!;
    expect((await make().getAccess(admin.id))?.plants).toEqual(['*']);
  });

  it('platform_admin -> plants ["*"] y org null; sin cliente un rol normal no es válido', async () => {
    const platform = (await users.create({
      email: 'p@campo.test',
      passwordHash: 'x',
      role: 'platform_admin',
      orgId: null,
    }))!;
    await expect(make().getAccess(platform.id)).resolves.toMatchObject({
      role: 'platform_admin',
      plants: ['*'],
      org: null,
    });
    // estados imposibles en la base (CHECK users_org_role_check): se deniegan en vez de abrir acceso
    const orphan = (await users.create({
      email: 'o@campo.test',
      passwordHash: 'x',
      role: 'viewer',
      orgId: null,
    }))!;
    await expect(make(0).getAccess(orphan.id)).resolves.toBeNull();
    users.users.find((u) => u.id === platform.id)!.orgId = 'acme';
    await expect(make(0).getAccess(platform.id)).resolves.toBeNull();
  });

  describe('cliente', () => {
    it('cliente desactivado o inexistente -> null; reactivado vuelve a entrar', async () => {
      const svc = make(0);
      await orgs.update('acme', { active: false });
      await expect(svc.getAccess(id)).resolves.toBeNull();
      await orgs.update('acme', { active: true });
      await expect(svc.getAccess(id)).resolves.toMatchObject({ id });
      orgs.orgs.delete('acme');
      await expect(svc.getAccess(id)).resolves.toBeNull();
    });

    it('un cambio del cliente no se ve hasta invalidarlo (o expirar el TTL); invalidateOrg lo aplica al instante', async () => {
      const svc = make();
      await svc.getAccess(id);
      await orgs.update('acme', { active: false, modules: ['gas'] });
      expect((await svc.getAccess(id))?.org?.modules).toEqual(['tanks']); // aún cacheado
      await svc.invalidateOrg('acme');
      await expect(svc.getAccess(id)).resolves.toBeNull();
      await orgs.update('acme', { active: true });
      await svc.invalidateOrg('acme');
      expect((await svc.getAccess(id))?.org?.modules).toEqual(['gas']);
    });

    it('invalidateOrg sólo limpia a los usuarios de ese cliente', async () => {
      await orgs.create({ id: 'otro', name: 'Otro', modules: [], active: true });
      const other = (await users.create({
        email: 'z@campo.test',
        passwordHash: 'x',
        role: 'admin',
        orgId: 'otro',
      }))!;
      const svc = make();
      await svc.getAccess(id);
      await svc.getAccess(other.id);
      const before = users.reads;
      await svc.invalidateOrg('acme');
      await svc.getAccess(other.id);
      expect(users.reads).toBe(before); // el de otro cliente sigue en caché
      await svc.getAccess(id);
      expect(users.reads).toBe(before + 1);
    });

    it('invalidateOrg publica `org:<id>`, emite en orgInvalidations$ y la otra réplica limpia su caché', async () => {
      const a = make();
      const b = make();
      const seen: string[] = [];
      b.orgInvalidations$.subscribe((x) => seen.push(x));
      await b.getAccess(id);
      await orgs.update('acme', { active: false });
      expect(await b.getAccess(id)).not.toBeNull();
      await a.invalidateOrg('acme');
      expect(seen).toEqual(['acme']);
      await expect(b.getAccess(id)).resolves.toBeNull();
    });
  });

  it('no existe o inactivo -> null', async () => {
    const svc = make(0);
    await expect(svc.getAccess('00000000-0000-4000-8000-000000000000')).resolves.toBeNull();
    await users.update(id, { active: false });
    await expect(svc.getAccess(id)).resolves.toBeNull();
  });

  describe('caché', () => {
    it('sirve de la caché dentro del TTL y relee al expirar', async () => {
      const svc = make(30_000);
      await svc.getAccess(id);
      await svc.getAccess(id);
      expect(users.reads).toBe(1);

      // un cambio hecho "por fuera" (otra réplica, sin aviso) no se ve hasta que expira el TTL
      await users.setPlants(id, []);
      jest.advanceTimersByTime(29_999);
      expect((await svc.getAccess(id))?.plants).toEqual(['demo']);
      jest.advanceTimersByTime(1);
      expect((await svc.getAccess(id))?.plants).toEqual([]);
      expect(users.reads).toBe(2);
    });

    it('TTL 0 = sin caché', async () => {
      const svc = make(0);
      await svc.getAccess(id);
      await svc.getAccess(id);
      expect(users.reads).toBe(2);
    });

    it('cachea también al usuario inactivo (sigue denegado sin tocar la base)', async () => {
      const svc = make();
      await users.update(id, { active: false });
      await svc.getAccess(id);
      await svc.getAccess(id);
      expect(users.reads).toBe(1);
    });

    it('fresh ignora la caché y la refresca', async () => {
      const svc = make();
      await svc.getAccess(id);
      await users.setPlants(id, ['otra']);
      expect((await svc.getAccess(id, { fresh: true }))?.plants).toEqual(['otra']);
      expect((await svc.getAccess(id))?.plants).toEqual(['otra']);
      expect(users.reads).toBe(2);
    });
  });

  describe('invalidación', () => {
    it('invalidate() surte efecto al instante, sin esperar al TTL', async () => {
      const svc = make();
      await svc.getAccess(id);
      await users.update(id, { active: false });
      expect((await svc.getAccess(id))?.id).toBe(id); // aún cacheado
      await svc.invalidate(id);
      await expect(svc.getAccess(id)).resolves.toBeNull();
    });

    it('invalidate() publica en el bus y emite en invalidations$', async () => {
      const svc = make();
      const published: string[] = [];
      bus.subscribe((x) => published.push(x));
      const seen: string[] = [];
      svc.invalidations$.subscribe((x) => seen.push(x));
      await svc.invalidate(id);
      expect(published).toContain(id);
      expect(seen).toContain(id);
    });

    it('una invalidación de otra réplica (vía el bus) limpia la caché local', async () => {
      const replicaA = make();
      const replicaB = make(); // comparten el bus: simulan dos procesos con Redis
      await replicaB.getAccess(id);
      await users.setPlants(id, []);
      expect((await replicaB.getAccess(id))?.plants).toEqual(['demo']);

      await replicaA.invalidate(id); // A modifica al usuario
      expect((await replicaB.getAccess(id))?.plants).toEqual([]);
    });

    it('un fallo al publicar no rompe la invalidación local', async () => {
      const failing = {
        publish: () => Promise.reject(new Error('redis caído')),
        subscribe: () => () => undefined,
      };
      const svc = new AccessService(users, orgs, failing, cfg(30_000));
      await svc.getAccess(id);
      await users.update(id, { active: false });
      await expect(svc.invalidate(id)).resolves.toBeUndefined();
      await expect(svc.getAccess(id)).resolves.toBeNull();
    });

    it('una lectura iniciada antes de invalidar no deja datos viejos en la caché', async () => {
      const svc = make();
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const original = users.findById.bind(users);
      users.findById = async (x: string) => {
        const stale = await original(x); // foto previa al cambio
        await gate;
        return stale && { ...stale };
      };
      const pending = svc.getAccess(id);
      await users.update(id, { active: false });
      await svc.invalidate(id);
      release();
      await pending;
      users.findById = original;
      await expect(svc.getAccess(id)).resolves.toBeNull(); // no quedó la versión vieja cacheada
    });
  });

  describe('versión de sesión (tv)', () => {
    it('un token con tv distinto del vigente se trata como sesión no válida (null)', async () => {
      const svc = make();
      await expect(svc.getAccess(id, { tv: 0 })).resolves.toMatchObject({ id });
      await users.update(id, { revokeTokens: true });
      await svc.invalidate(id);
      await expect(svc.getAccess(id, { tv: 0 })).resolves.toBeNull();
      await expect(svc.getAccess(id, { tv: 1 })).resolves.toMatchObject({ id });
      // sin `tv` (llamadas internas) no se comprueba
      await expect(svc.getAccess(id)).resolves.toMatchObject({ id });
    });

    it('la comprobación también funciona desde la caché y sin caché', async () => {
      for (const ttl of [30_000, 0]) {
        const svc = make(ttl);
        const before = users.reads;
        await svc.getAccess(id, { tv: users.users[0].tokenVersion });
        await expect(svc.getAccess(id, { tv: 99 })).resolves.toBeNull();
        expect(users.reads - before).toBe(ttl > 0 ? 1 : 2);
      }
    });

    it('un usuario inactivo es null aunque el tv coincida', async () => {
      const svc = make(0);
      await users.update(id, { active: false });
      await expect(svc.getAccess(id, { tv: 0 })).resolves.toBeNull();
    });
  });

  it('onModuleDestroy da de baja la suscripción al bus', async () => {
    const svc = make();
    await svc.getAccess(id);
    svc.onModuleDestroy();
    await users.setPlants(id, []);
    await bus.publish(id);
    expect((await svc.getAccess(id))?.plants).toEqual(['demo']); // ya no escucha
  });
});
