import {
  BadRequestException,
  ExecutionContext,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import type { Role } from '@campo/shared';
import type { AuthUser } from './auth.types';
import { PlantAccessGuard } from './plant-access.guard';
import { PlantAccessDenied, assertPlantAccess, plantFilter, toAuthUser } from './plant-access';

const existing = new Set(['demo', 'otra']);
const catalog = { exists: jest.fn((p: string) => Promise.resolve(existing.has(p))) };
const guard = new PlantAccessGuard(catalog);

const user = (role: Role, plants: string[]): AuthUser =>
  toAuthUser({ id: 'u1', email: 'u@campo.test', role, plants });

const ctx = (plant: unknown, u?: AuthUser, type = 'http'): ExecutionContext =>
  ({
    getType: () => type,
    switchToHttp: () => ({ getRequest: () => ({ params: { plant }, user: u }) }),
  }) as unknown as ExecutionContext;

describe('PlantAccessGuard', () => {
  beforeEach(() => catalog.exists.mockClear());

  describe.each(['engineer', 'operator', 'viewer'] as const)('rol %s', (role) => {
    it('con la planta asignada pasa', async () => {
      await expect(guard.canActivate(ctx('demo', user(role, ['demo'])))).resolves.toBe(true);
      expect(catalog.exists).not.toHaveBeenCalled();
    });

    it('con otra planta asignada -> 403 genérico', async () => {
      await expect(guard.canActivate(ctx('otra', user(role, ['demo'])))).rejects.toThrow(
        new PlantAccessDenied('otra'),
      );
    });

    it('sin asignaciones -> 403 (sin acceso por defecto)', async () => {
      await expect(guard.canActivate(ctx('demo', user(role, [])))).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('el 403 es idéntico exista o no la planta (no filtra existencia)', async () => {
      const real = await guard.canActivate(ctx('otra', user(role, []))).catch((e: Error) => e);
      const fake = await guard.canActivate(ctx('no-existe', user(role, []))).catch((e: Error) => e);
      expect((real as ForbiddenException).getResponse()).toEqual(
        (fake as ForbiddenException).getResponse(),
      );
      expect(catalog.exists).not.toHaveBeenCalled();
    });
  });

  describe('admin', () => {
    it('accede a cualquier planta existente sin asignaciones', async () => {
      await expect(guard.canActivate(ctx('demo', user('admin', [])))).resolves.toBe(true);
      await expect(guard.canActivate(ctx('otra', user('admin', [])))).resolves.toBe(true);
    });

    it('planta inexistente -> 404 (sólo para admin)', async () => {
      await expect(guard.canActivate(ctx('fantasma', user('admin', [])))).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  it('id de planta inválido -> 400 antes que nada', async () => {
    await expect(guard.canActivate(ctx('BAD_PLANT', user('viewer', [])))).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(guard.canActivate(ctx(undefined, user('admin', [])))).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('sin usuario en la petición -> 403', async () => {
    await expect(guard.canActivate(ctx('demo'))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('no interfiere con contextos no HTTP', async () => {
    await expect(guard.canActivate(ctx('demo', undefined, 'ws'))).resolves.toBe(true);
  });
});

describe('helpers de acceso por planta', () => {
  it('toAuthUser: admin -> ["*"]; el resto conserva sus plantas', () => {
    expect(user('admin', ['demo']).plants).toEqual(['*']);
    expect(user('operator', ['demo']).plants).toEqual(['demo']);
  });

  it('plantFilter: admin sin filtro; el resto, sus plantas (vacío = nada)', () => {
    expect(plantFilter(user('admin', []))).toBeUndefined();
    expect(plantFilter(user('viewer', ['a', 'b']))).toEqual(['a', 'b']);
    expect(plantFilter(user('viewer', []))).toEqual([]);
  });

  it('assertPlantAccess lanza PlantAccessDenied con la planta', () => {
    expect(() => assertPlantAccess(user('viewer', ['demo']), 'otra')).toThrow(PlantAccessDenied);
    expect(() => assertPlantAccess(user('viewer', ['demo']), 'demo')).not.toThrow();
  });
});
