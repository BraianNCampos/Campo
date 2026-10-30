import {
  BadRequestException,
  ExecutionContext,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import type { Role } from '@campo/shared';
import type { AuthUser } from './auth.types';
import { PlantAccessGuard, PlantRequest } from './plant-access.guard';
import { PlantAccessDenied, ALL_PLANTS, plantAllowed, scopeOf, toAuthUser } from './plant-access';
import { PlantCatalog } from './plant-catalog';
import { TenantScope } from './tenant-scope';

/** demo y otra son de A; b1 es de B; `live` sólo tiene telemetría (sin registrar). */
const owners: Record<string, string> = { demo: 'A', otra: 'A', b1: 'B' };
const catalog: PlantCatalog & { orgOf: jest.Mock } = Object.assign(
  Object.create(PlantCatalog.prototype) as PlantCatalog,
  {
    orgOf: jest.fn((p: string) => Promise.resolve(owners[p] ?? null)),
    isLive: jest.fn((p: string) => Promise.resolve(p === 'live')),
  },
);
const tenant = new TenantScope(catalog);
const guard = new PlantAccessGuard(tenant);

const org = (id: string) => ({ id, name: id, modules: [] });
const user = (role: Role, plants: string[], orgId: string | null = 'A'): AuthUser =>
  toAuthUser(
    { id: 'u1', email: 'u@campo.test', role, plants },
    role === 'platform_admin' || orgId === null ? null : org(orgId),
  );

const ctx = (plant: unknown, u?: AuthUser, type = 'http', req: object = {}): ExecutionContext =>
  ({
    getType: () => type,
    switchToHttp: () => ({ getRequest: () => Object.assign(req, { params: { plant }, user: u }) }),
  }) as unknown as ExecutionContext;

describe('PlantAccessGuard', () => {
  beforeEach(() => catalog.orgOf.mockClear());

  describe.each(['engineer', 'operator', 'viewer'] as const)('rol %s', (role) => {
    it('con la planta asignada de su cliente pasa', async () => {
      await expect(guard.canActivate(ctx('demo', user(role, ['demo'])))).resolves.toBe(true);
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

    it('una planta de OTRO cliente asignada por error es inerte: 403', async () => {
      await expect(guard.canActivate(ctx('b1', user(role, ['b1'])))).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('el 403 es idéntico para una planta de otro cliente, una no asignada y una inexistente', async () => {
      const u = user(role, []);
      const bodies = await Promise.all(
        ['b1', 'otra', 'no-existe', 'live'].map((p) =>
          guard.canActivate(ctx(p, u)).catch((e: ForbiddenException) => e.getResponse()),
        ),
      );
      expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
    });
  });

  describe('admin de cliente', () => {
    it('accede a todas las plantas de SU cliente sin asignaciones', async () => {
      await expect(guard.canActivate(ctx('demo', user('admin', [])))).resolves.toBe(true);
      await expect(guard.canActivate(ctx('otra', user('admin', [])))).resolves.toBe(true);
    });

    it('planta de otro cliente, inexistente o sólo con telemetría -> 403 (nunca 404: no revela existencia)', async () => {
      for (const p of ['b1', 'fantasma', 'live']) {
        await expect(guard.canActivate(ctx(p, user('admin', [])))).rejects.toBeInstanceOf(
          PlantAccessDenied,
        );
      }
    });

    it('deja el cliente de la planta en la petición', async () => {
      const req: PlantRequest = {} as PlantRequest;
      await guard.canActivate(ctx('demo', user('admin', []), 'http', req));
      expect(req.plantOrgId).toBe('A');
    });
  });

  describe('platform_admin', () => {
    it('accede a plantas de cualquier cliente y a las que sólo tienen telemetría', async () => {
      for (const p of ['demo', 'b1', 'live']) {
        await expect(guard.canActivate(ctx(p, user('platform_admin', [])))).resolves.toBe(true);
      }
    });

    it('planta inexistente -> 404', async () => {
      await expect(
        guard.canActivate(ctx('fantasma', user('platform_admin', []))),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  it('id de planta inválido -> 400 antes que nada', async () => {
    await expect(guard.canActivate(ctx('BAD_PLANT', user('viewer', [])))).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(guard.canActivate(ctx(undefined, user('admin', [])))).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(catalog.orgOf).not.toHaveBeenCalled();
  });

  it('sin usuario en la petición -> 403', async () => {
    await expect(guard.canActivate(ctx('demo'))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('no interfiere con contextos no HTTP', async () => {
    await expect(guard.canActivate(ctx('demo', undefined, 'ws'))).resolves.toBe(true);
  });
});

describe('reglas puras de acceso (plant-access.ts)', () => {
  it('toAuthUser: admin y platform_admin -> ["*"]; el resto conserva sus plantas', () => {
    expect(user('admin', ['demo']).plants).toEqual([ALL_PLANTS]);
    expect(user('platform_admin', []).plants).toEqual([ALL_PLANTS]);
    expect(user('operator', ['demo']).plants).toEqual(['demo']);
  });

  it('plantAllowed: matriz rol x (mi cliente | otro cliente | sin registrar)', () => {
    const cases: [Role, string[], string, string | null, boolean][] = [
      ['admin', [], 'demo', 'A', true],
      ['admin', [], 'b1', 'B', false],
      ['admin', [], 'live', null, false],
      ['engineer', ['demo'], 'demo', 'A', true],
      ['engineer', ['demo'], 'otra', 'A', false],
      ['engineer', ['b1'], 'b1', 'B', false],
      ['viewer', ['live'], 'live', null, false],
      ['platform_admin', [], 'b1', 'B', true],
      ['platform_admin', [], 'live', null, true],
    ];
    for (const [role, plants, plant, plantOrg, expected] of cases) {
      expect([role, plant, plantOrg, plantAllowed(user(role, plants), plant, plantOrg)]).toEqual([
        role,
        plant,
        plantOrg,
        expected,
      ]);
    }
  });

  it('un usuario no platform_admin sin cliente (estado imposible) no accede a nada', () => {
    expect(plantAllowed(user('admin', [], null), 'demo', 'A')).toBe(false);
    expect(scopeOf(user('admin', [], null))).toEqual({ plants: [] });
  });

  it('scopeOf: platform sin restricción; admin por cliente; el resto por cliente y plantas', () => {
    expect(scopeOf(user('platform_admin', []))).toEqual({});
    expect(scopeOf(user('admin', []))).toEqual({ orgId: 'A' });
    expect(scopeOf(user('viewer', ['a', 'b']))).toEqual({ orgId: 'A', plants: ['a', 'b'] });
    expect(scopeOf(user('viewer', []))).toEqual({ orgId: 'A', plants: [] });
  });
});

describe('TenantScope.canAccessPlant', () => {
  it('memoriza el cliente de cada planta dentro de una pasada', async () => {
    catalog.orgOf.mockClear();
    const memo = new Map<string, string | null>();
    const u = user('viewer', ['demo']);
    expect(await tenant.canAccessPlant(u, 'demo', memo)).toBe(true);
    expect(await tenant.canAccessPlant(u, 'demo', memo)).toBe(true);
    expect(await tenant.canAccessPlant(u, 'b1', memo)).toBe(false);
    expect(catalog.orgOf).toHaveBeenCalledTimes(2);
  });

  it('platform_admin siempre puede (sin consultar)', async () => {
    catalog.orgOf.mockClear();
    expect(await tenant.canAccessPlant(user('platform_admin', []), 'cualquiera')).toBe(true);
    expect(catalog.orgOf).not.toHaveBeenCalled();
  });
});
