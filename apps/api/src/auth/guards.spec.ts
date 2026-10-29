import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Role } from '@campo/shared';
import type { AuthService } from './auth.service';
import type { AuthUser, AuthenticatedRequest } from './auth.types';
import { IS_PUBLIC_KEY, ROLES_KEY } from './decorators';
import { JwtAuthGuard } from './jwt-auth.guard';
import { RolesGuard } from './roles.guard';

function ctx(
  req: Partial<AuthenticatedRequest>,
  meta: { roles?: Role[]; isPublic?: boolean } = {},
  type = 'http',
): ExecutionContext {
  const handler = () => undefined;
  Reflect.defineMetadata(ROLES_KEY, meta.roles, handler);
  Reflect.defineMetadata(IS_PUBLIC_KEY, meta.isPublic, handler);
  return {
    getType: () => type,
    getHandler: () => handler,
    getClass: () => class Dummy {},
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

describe('JwtAuthGuard', () => {
  const user: AuthUser = { id: 'u1', email: 'a@b.c', role: 'viewer' };
  const verify = jest.fn((t: string) => Promise.resolve(t === 'good' ? user : null));
  const guard = new JwtAuthGuard(new Reflector(), {
    verifyToken: verify,
  } as unknown as AuthService);

  beforeEach(() => verify.mockClear());

  it('deja pasar rutas @Public sin token', async () => {
    await expect(guard.canActivate(ctx({ headers: {} }, { isPublic: true }))).resolves.toBe(true);
    expect(verify).not.toHaveBeenCalled();
  });

  it('exige Authorization: Bearer', async () => {
    await expect(guard.canActivate(ctx({ headers: {} }))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    await expect(
      guard.canActivate(ctx({ headers: { authorization: 'Basic abc' } })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rechaza tokens inválidos', async () => {
    await expect(
      guard.canActivate(ctx({ headers: { authorization: 'Bearer bad' } })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('acepta un token válido y adjunta el usuario a la petición', async () => {
    const req: Partial<AuthenticatedRequest> = { headers: { authorization: 'Bearer good' } };
    await expect(guard.canActivate(ctx(req))).resolves.toBe(true);
    expect(req.user).toEqual(user);
  });

  it('no interfiere con contextos no HTTP', async () => {
    await expect(guard.canActivate(ctx({}, {}, 'ws'))).resolves.toBe(true);
  });
});

describe('RolesGuard', () => {
  const guard = new RolesGuard(new Reflector());
  const asUser = (role: Role): Partial<AuthenticatedRequest> => ({
    user: { id: 'u', email: 'e', role },
  });

  it('sin @Roles basta con estar autenticado', () => {
    expect(guard.canActivate(ctx(asUser('viewer')))).toBe(true);
  });

  it('permite los roles listados', () => {
    expect(guard.canActivate(ctx(asUser('engineer'), { roles: ['admin', 'engineer'] }))).toBe(true);
    expect(guard.canActivate(ctx(asUser('operator'), { roles: ['operator'] }))).toBe(true);
  });

  it('deniega los no listados', () => {
    expect(() =>
      guard.canActivate(ctx(asUser('viewer'), { roles: ['admin', 'engineer'] })),
    ).toThrow(ForbiddenException);
    expect(() => guard.canActivate(ctx(asUser('operator'), { roles: ['engineer'] }))).toThrow(
      ForbiddenException,
    );
  });

  it('admin siempre pasa', () => {
    expect(guard.canActivate(ctx(asUser('admin'), { roles: ['operator'] }))).toBe(true);
  });

  it('deniega si hay @Roles pero no hay usuario', () => {
    expect(() => guard.canActivate(ctx({}, { roles: ['viewer'] }))).toThrow(ForbiddenException);
  });
});
