import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { parseEnv } from '../config/app-config';
import { MemoryUsersRepository } from '../../test/support/memory-repos';
import { AuthService } from './auth.service';

const cfg = parseEnv({ JWT_SECRET: 's'.repeat(40), NODE_ENV: 'test', BCRYPT_ROUNDS: '4' });

describe('AuthService', () => {
  const jwt = new JwtService({ secret: cfg.jwtSecret, signOptions: { expiresIn: '1h' } });
  let users: MemoryUsersRepository;
  let svc: AuthService;

  beforeEach(async () => {
    users = new MemoryUsersRepository();
    svc = new AuthService(users, jwt, cfg);
    await users.create({
      email: 'ana@campo.test',
      passwordHash: await svc.hashPassword('secreto-123'),
      role: 'operator',
    });
  });

  it('guarda hash bcrypt, nunca la contraseña', () => {
    expect(users.users[0].passwordHash).toMatch(/^\$2[aby]\$04\$/);
    expect(JSON.stringify(users.users)).not.toContain('secreto-123');
  });

  it('login correcto devuelve un JWT verificable con sub/email/role', async () => {
    const { accessToken } = await svc.login('ANA@campo.test ', 'secreto-123');
    const user = await svc.verifyToken(accessToken);
    expect(user).toMatchObject({ email: 'ana@campo.test', role: 'operator' });
  });

  it('rechaza contraseña incorrecta, usuario inexistente y usuario inactivo con el mismo error', async () => {
    users.users[0].active = false;
    await expect(svc.login('ana@campo.test', 'secreto-123')).rejects.toThrow(
      'Credenciales inválidas',
    );
    users.users[0].active = true;
    await expect(svc.login('ana@campo.test', 'mala')).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(svc.login('nadie@campo.test', 'secreto-123')).rejects.toThrow(
      'Credenciales inválidas',
    );
  });

  it('verifyToken devuelve null para tokens manipulados, de otro secreto o con rol desconocido', async () => {
    const { accessToken } = await svc.login('ana@campo.test', 'secreto-123');
    expect(await svc.verifyToken(accessToken + 'x')).toBeNull();
    expect(await svc.verifyToken('basura')).toBeNull();
    const other = new JwtService({ secret: 'otro-secreto-otro-secreto-otro-secreto' });
    expect(await svc.verifyToken(await other.signAsync({ sub: 'u', role: 'admin' }))).toBeNull();
    expect(
      await svc.verifyToken(await jwt.signAsync({ sub: 'u', email: 'e', role: 'root' })),
    ).toBeNull();
  });

  describe('versión de sesión (tv)', () => {
    it('el login emite el token con la token_version vigente', async () => {
      const first = await svc.login('ana@campo.test', 'secreto-123');
      expect(jwt.decode(first.accessToken)).toMatchObject({ tv: 0 });
      expect(await svc.verifyToken(first.accessToken)).toMatchObject({ tv: 0 });

      users.users[0].tokenVersion = 3;
      const next = await svc.login('ana@campo.test', 'secreto-123');
      expect(jwt.decode(next.accessToken)).toMatchObject({ tv: 3 });
      expect(await svc.verifyToken(next.accessToken)).toMatchObject({ tv: 3 });
    });

    it('un token sin `tv` (anterior al despliegue) cuenta como versión 0', async () => {
      const legacy = await jwt.signAsync({ sub: 'u', email: 'e', role: 'viewer' });
      expect(await svc.verifyToken(legacy)).toEqual({
        id: 'u',
        email: 'e',
        role: 'viewer',
        tv: 0,
      });
    });

    it('un `tv` que no es un entero >= 0 invalida el token', async () => {
      for (const tv of [-1, 1.5, '1', null, {}]) {
        const token = await jwt.signAsync({ sub: 'u', email: 'e', role: 'viewer', tv });
        expect(await svc.verifyToken(token)).toBeNull();
      }
    });

    it('signToken firma con la versión del usuario dado', async () => {
      const token = await svc.signToken({ ...users.users[0], tokenVersion: 7 });
      expect(jwt.decode(token)).toMatchObject({ sub: users.users[0].id, tv: 7 });
    });
  });

  it('rechaza tokens expirados', async () => {
    const expired = await jwt.signAsync(
      { sub: 'u', email: 'e', role: 'admin' },
      { expiresIn: -10 },
    );
    expect(await svc.verifyToken(expired)).toBeNull();
  });
});
