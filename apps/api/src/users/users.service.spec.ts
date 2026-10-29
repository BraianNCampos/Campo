import { NotFoundException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { MemoryAuditRepository, MemoryUsersRepository } from '../../test/support/memory-repos';
import { AuditService } from '../audit/audit.service';
import { AccessService } from '../auth/access.service';
import { InMemoryInvalidationBus } from '../auth/auth-invalidation';
import { AuthService } from '../auth/auth.service';
import { parseEnv } from '../config/app-config';
import { UsersService } from './users.service';

const cfg = parseEnv({ JWT_SECRET: 's'.repeat(40), NODE_ENV: 'test', BCRYPT_ROUNDS: '4' });

describe('UsersService: revocación y auditoría', () => {
  let users: MemoryUsersRepository;
  let audit: MemoryAuditRepository;
  let access: AccessService;
  let svc: UsersService;
  const admin = { id: 'adm', email: 'admin@campo.test', role: 'admin' as const, plants: ['*'] };

  beforeEach(() => {
    users = new MemoryUsersRepository();
    audit = new MemoryAuditRepository();
    const auth = new AuthService(users, new JwtService({ secret: cfg.jwtSecret }), cfg);
    access = new AccessService(users, new InMemoryInvalidationBus(), cfg);
    svc = new UsersService(users, auth, access, new AuditService(audit));
  });

  const version = () => users.users[0].tokenVersion;
  const create = () =>
    svc.create(
      { email: 'ana@campo.test', password: 'clave-larga-123', role: 'viewer', plants: ['demo'] },
      admin,
    );

  it('sólo cambiar la contraseña o desactivar sube token_version; cambiar rol o reactivar no', async () => {
    const { id } = await create();
    expect(version()).toBe(0);

    await svc.update(id, { role: 'operator' }, admin);
    expect(version()).toBe(0);
    await svc.update(id, { password: 'otra-clave-larga-1' }, admin);
    expect(version()).toBe(1);
    await svc.update(id, { active: false }, admin);
    expect(version()).toBe(2);
    await svc.update(id, { active: true }, admin);
    expect(version()).toBe(2);
    await svc.update(id, { password: 'otra-clave-larga-2', active: true, role: 'viewer' }, admin);
    expect(version()).toBe(3);
  });

  it('revoke sube la versión, invalida la caché/WS y audita; 404 si no existe', async () => {
    const { id } = await create();
    const seen: string[] = [];
    access.invalidations$.subscribe((x) => seen.push(x));
    const res = await svc.revoke(id, admin);
    expect(res).toEqual({
      id,
      email: 'ana@campo.test',
      role: 'viewer',
      active: true,
      plants: ['demo'],
    });
    expect(version()).toBe(1);
    expect(seen).toEqual([id]);
    expect(audit.entries.at(-1)).toMatchObject({
      action: 'user.revoke',
      target: `user:${id}`,
      detail: {},
    });
    await expect(svc.revoke('00000000-0000-4000-8000-000000000000', admin)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('audita alta, edición y plantas sin contraseñas ni hashes', async () => {
    const { id } = await create();
    await svc.update(id, { password: 'otra-clave-larga-1', role: 'engineer' }, admin);
    await svc.setPlants(id, ['demo', 'norte'], admin);
    expect(audit.entries.map((e) => [e.action, e.detail])).toEqual([
      ['user.create', { email: 'ana@campo.test', role: 'viewer', plants: ['demo'] }],
      ['user.update', { changed: ['password', 'role'], role: 'engineer' }],
      ['user.plants', { plants: ['demo', 'norte'] }],
    ]);
    const dump = JSON.stringify(audit.entries);
    expect(dump).not.toMatch(/clave-larga|\$2[aby]\$/);
    expect(audit.entries.every((e) => e.actorId === 'adm' && e.actorEmail === admin.email)).toBe(
      true,
    );
  });

  it('un cambio rechazado (último admin) ni sube la versión ni se audita', async () => {
    const root = (await users.create({
      email: 'root@campo.test',
      passwordHash: 'x',
      role: 'admin',
    }))!;
    await expect(svc.update(root.id, { active: false }, admin)).rejects.toThrow('último admin');
    expect(users.users[0].tokenVersion).toBe(0);
    expect(audit.entries).toEqual([]);
  });
});
