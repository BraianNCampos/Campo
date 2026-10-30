import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  MemoryAuditRepository,
  MemoryUsersRepository,
  memoryOrgs,
} from '../../test/support/memory-repos';
import { AuditService } from '../audit/audit.service';
import { parseEnv } from '../config/app-config';
import { AccessService } from './access.service';
import { AccountService } from './account.service';
import { InMemoryInvalidationBus } from './auth-invalidation';
import { AuthService } from './auth.service';
import { ChangePasswordDto } from './dto';

const cfg = parseEnv({ JWT_SECRET: 's'.repeat(40), NODE_ENV: 'test', BCRYPT_ROUNDS: '4' });
const CURRENT = 'clave-actual-larga-1';
const NEXT = 'clave-nueva-larga-2';

describe('AccountService.changePassword', () => {
  const jwt = new JwtService({ secret: cfg.jwtSecret, signOptions: { expiresIn: '1h' } });
  let users: MemoryUsersRepository;
  let audit: MemoryAuditRepository;
  let auth: AuthService;
  let access: AccessService;
  let svc: AccountService;
  let id: string;
  const actor = () => ({
    id,
    email: 'ana@campo.test',
    role: 'operator' as const,
    plants: [],
    org: { id: 'acme', name: 'Acme', modules: [] },
  });

  beforeEach(async () => {
    users = new MemoryUsersRepository();
    audit = new MemoryAuditRepository();
    const orgs = memoryOrgs(users);
    await orgs.create({ id: 'acme', name: 'Acme', modules: [], active: true });
    access = new AccessService(users, orgs, new InMemoryInvalidationBus(), cfg);
    auth = new AuthService(users, jwt, access, cfg);
    access.onModuleInit();
    svc = new AccountService(users, auth, access, new AuditService(audit));
    id = (await users.create({
      email: 'ana@campo.test',
      passwordHash: await auth.hashPassword(CURRENT),
      role: 'operator',
      orgId: 'acme',
    }))!.id;
  });

  it('login -> cambio -> el token viejo deja de valer y el nuevo sí', async () => {
    const { accessToken: old } = await auth.login('ana@campo.test', CURRENT);
    const oldClaims = (await auth.verifyToken(old))!;
    await expect(access.getAccess(id, { tv: oldClaims.tv })).resolves.toMatchObject({ id });

    const { accessToken } = await svc.changePassword(actor(), {
      currentPassword: CURRENT,
      newPassword: NEXT,
    });

    await expect(access.getAccess(id, { tv: oldClaims.tv })).resolves.toBeNull(); // 401 en el guard
    const claims = (await auth.verifyToken(accessToken))!;
    expect(claims.tv).toBe(oldClaims.tv + 1);
    await expect(access.getAccess(id, { tv: claims.tv })).resolves.toMatchObject({ id });
    // la contraseña vieja ya no sirve
    await expect(auth.login('ana@campo.test', CURRENT)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    await expect(auth.login('ana@campo.test', NEXT)).resolves.toHaveProperty('accessToken');
  });

  it('avisa a la caché/WS (invalidations$) del cambio', async () => {
    const seen: string[] = [];
    access.invalidations$.subscribe((x) => seen.push(x));
    await svc.changePassword(actor(), { currentPassword: CURRENT, newPassword: NEXT });
    expect(new Set(seen)).toEqual(new Set([id]));
  });

  it('contraseña actual errónea -> 400 y no cambia nada (ni versión ni auditoría)', async () => {
    const hash = users.users[0].passwordHash;
    await expect(
      svc.changePassword(actor(), { currentPassword: 'no-es-esta-1234', newPassword: NEXT }),
    ).rejects.toThrow(new BadRequestException('La contraseña actual no es correcta'));
    expect(users.users[0]).toMatchObject({ passwordHash: hash, tokenVersion: 0 });
    expect(audit.entries).toEqual([]);
  });

  it('la nueva debe ser distinta de la actual', async () => {
    await expect(
      svc.changePassword(actor(), { currentPassword: CURRENT, newPassword: CURRENT }),
    ).rejects.toThrow('distinta de la actual');
    expect(users.users[0].tokenVersion).toBe(0);
  });

  it('usuario desactivado o borrado -> 401', async () => {
    users.users[0].active = false;
    await expect(
      svc.changePassword(actor(), { currentPassword: CURRENT, newPassword: NEXT }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(
      svc.changePassword(
        { ...actor(), id: '00000000-0000-4000-8000-000000000000' },
        { currentPassword: CURRENT, newPassword: NEXT },
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('audita el cambio sin ninguna contraseña, hash ni token', async () => {
    const { accessToken } = await svc.changePassword(actor(), {
      currentPassword: CURRENT,
      newPassword: NEXT,
    });
    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0]).toMatchObject({
      actorId: id,
      action: 'me.password',
      target: `user:${id}`,
      detail: {},
    });
    const dump = JSON.stringify(audit.entries);
    for (const secret of [CURRENT, NEXT, users.users[0].passwordHash, accessToken]) {
      expect(dump).not.toContain(secret);
    }
  });

  it('guarda un hash bcrypt nuevo, nunca la contraseña', async () => {
    await svc.changePassword(actor(), { currentPassword: CURRENT, newPassword: NEXT });
    expect(users.users[0].passwordHash).toMatch(/^\$2[aby]\$04\$/);
    expect(JSON.stringify(users.users)).not.toContain(NEXT);
  });
});

describe('ChangePasswordDto (política de contraseña)', () => {
  const errors = async (body: unknown) =>
    (
      await validate(plainToInstance(ChangePasswordDto, body), {
        whitelist: true,
        forbidNonWhitelisted: true,
      })
    )
      .map((e) => e.property)
      .sort();

  it('acepta >= 12 caracteres y <= 72 bytes', async () => {
    expect(await errors({ currentPassword: 'x', newPassword: 'a'.repeat(12) })).toEqual([]);
    expect(await errors({ currentPassword: 'x', newPassword: 'a'.repeat(72) })).toEqual([]);
  });

  it('rechaza < 12 caracteres, > 72 bytes (UTF-8) y no-strings', async () => {
    expect(await errors({ currentPassword: 'x', newPassword: 'a'.repeat(11) })).toEqual([
      'newPassword',
    ]);
    expect(await errors({ currentPassword: 'x', newPassword: 'a'.repeat(73) })).toEqual([
      'newPassword',
    ]);
    // 40 caracteres pero 80 bytes
    expect(await errors({ currentPassword: 'x', newPassword: 'ñ'.repeat(40) })).toEqual([
      'newPassword',
    ]);
    expect(await errors({ currentPassword: 'x', newPassword: 123456789012 })).toEqual([
      'newPassword',
    ]);
    expect(await errors({ currentPassword: 'x' })).toEqual(['newPassword']);
  });

  it('exige la contraseña actual y no admite campos extra', async () => {
    expect(await errors({ newPassword: 'a'.repeat(12) })).toEqual(['currentPassword']);
    expect(await errors({ currentPassword: '', newPassword: 'a'.repeat(12) })).toEqual([
      'currentPassword',
    ]);
    expect(
      await errors({ currentPassword: 'x', newPassword: 'a'.repeat(12), role: 'admin' }),
    ).toEqual(['role']);
  });
});
