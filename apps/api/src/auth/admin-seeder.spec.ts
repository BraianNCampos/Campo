import { JwtService } from '@nestjs/jwt';
import {
  MemoryOrgsRepository,
  MemoryUsersRepository,
  memoryOrgs,
} from '../../test/support/memory-repos';
import { parseEnv } from '../config/app-config';
import { AccessService } from './access.service';
import { AdminSeeder } from './admin-seeder';
import { InMemoryInvalidationBus } from './auth-invalidation';
import { AuthService } from './auth.service';

const cfg = parseEnv({
  JWT_SECRET: 's'.repeat(40),
  NODE_ENV: 'test',
  BCRYPT_ROUNDS: '4',
  ADMIN_EMAIL: 'Root@Campo.test',
  ADMIN_PASSWORD: 'clave-semilla-123',
});

describe('AdminSeeder: platform_admin semilla (ADMIN_EMAIL/ADMIN_PASSWORD)', () => {
  let users: MemoryUsersRepository;
  let orgs: MemoryOrgsRepository;
  let access: AccessService;
  let auth: AuthService;
  let seeder: AdminSeeder;

  beforeEach(async () => {
    users = new MemoryUsersRepository();
    orgs = memoryOrgs(users);
    await orgs.create({ id: 'campos-demo', name: 'Demo', modules: [], active: true });
    access = new AccessService(users, orgs, new InMemoryInvalidationBus(), cfg);
    auth = new AuthService(users, new JwtService({ secret: cfg.jwtSecret }), access, cfg);
    seeder = new AdminSeeder(users, auth, access, cfg);
  });

  const seed = () => seeder.onApplicationBootstrap();

  it('sin usuario: lo crea como platform_admin, sin cliente, con la contraseña indicada (hash)', async () => {
    await seed();
    expect(users.users).toHaveLength(1);
    expect(users.users[0]).toMatchObject({
      email: 'root@campo.test',
      role: 'platform_admin',
      orgId: null,
      active: true,
    });
    expect(users.users[0].passwordHash).not.toContain('clave-semilla-123');
    await expect(auth.login('root@campo.test', 'clave-semilla-123')).resolves.toMatchObject({
      user: { role: 'platform_admin', org: null },
    });
  });

  it('es idempotente: arrancar dos veces no duplica ni cambia nada', async () => {
    await seed();
    const before = JSON.stringify(users.users);
    await seed();
    expect(JSON.stringify(users.users)).toBe(before);
  });

  it('si ya existe como admin de un cliente (migración de la Fase 5) lo promueve, lo deja sin cliente ni plantas, cierra sus sesiones y NO toca su contraseña', async () => {
    const old = (await users.create({
      email: 'root@campo.test',
      passwordHash: await auth.hashPassword('contraseña-antigua-1'),
      role: 'admin',
      orgId: 'campos-demo',
    }))!;
    await users.setPlants(old.id, ['demo']);
    const invalidated: string[] = [];
    access.invalidations$.subscribe((x) => invalidated.push(x));

    await seed();

    expect(users.users).toHaveLength(1);
    expect(users.users[0]).toMatchObject({
      id: old.id,
      role: 'platform_admin',
      orgId: null,
      plants: [],
      tokenVersion: 1,
    });
    expect(invalidated).toEqual([old.id]);
    await expect(auth.login('root@campo.test', 'contraseña-antigua-1')).resolves.toMatchObject({
      user: { role: 'platform_admin' },
    });
    await expect(auth.login('root@campo.test', 'clave-semilla-123')).rejects.toThrow();
  });

  it.each(['engineer', 'operator', 'viewer'] as const)(
    'también promueve a un %s existente',
    async (role) => {
      await users.create({
        email: 'root@campo.test',
        passwordHash: 'x',
        role,
        orgId: 'campos-demo',
      });
      await seed();
      expect(users.users[0]).toMatchObject({ role: 'platform_admin', orgId: null });
    },
  );

  it('NUNCA degrada a un platform_admin existente (ni le cambia la contraseña)', async () => {
    await users.create({
      email: 'root@campo.test',
      passwordHash: 'hash-propio',
      role: 'platform_admin',
      orgId: null,
    });
    await seed();
    expect(users.users[0]).toMatchObject({
      role: 'platform_admin',
      orgId: null,
      passwordHash: 'hash-propio',
      tokenVersion: 0,
    });
  });

  it('sin ADMIN_EMAIL/ADMIN_PASSWORD no hace nada', async () => {
    const none = new AdminSeeder(
      users,
      auth,
      access,
      parseEnv({ JWT_SECRET: 's'.repeat(40), NODE_ENV: 'test' }),
    );
    await none.onApplicationBootstrap();
    expect(users.users).toEqual([]);
  });

  it('un fallo de la base no impide el arranque (se registra)', async () => {
    users.findByEmail = () => Promise.reject(new Error('db caída'));
    await expect(seed()).resolves.toBeUndefined();
  });
});
