import { MemoryUsersRepository } from '../../test/support/memory-repos';
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
  let bus: InMemoryInvalidationBus;
  let id: string;

  const make = (ttl = 30_000) => {
    const svc = new AccessService(users, bus, cfg(ttl));
    svc.onModuleInit();
    return svc;
  };

  beforeEach(async () => {
    jest.useFakeTimers();
    users = new MemoryUsersRepository();
    bus = new InMemoryInvalidationBus();
    const u = await users.create({ email: 'ana@campo.test', passwordHash: 'x', role: 'operator' });
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
    });
  });

  it('admin -> plants ["*"]', async () => {
    const admin = (await users.create({
      email: 'a@campo.test',
      passwordHash: 'x',
      role: 'admin',
    }))!;
    expect((await make().getAccess(admin.id))?.plants).toEqual(['*']);
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
      const svc = new AccessService(users, failing, cfg(30_000));
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
