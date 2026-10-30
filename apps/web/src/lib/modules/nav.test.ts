import { describe, expect, it } from 'vitest';
import { MODULE_IDS, type ModuleId, type OrgSummary } from '@campo/shared';
import { activeModuleIds, canAckAlarms, canManageRules, landingHref, mobileNav, moduleHref, rulesHref, showAdminLink, showSectionNav } from './nav';

const org = (modules: ModuleId[]): OrgSummary => ({ id: 'c', name: 'Cliente', modules });
const ALL = [...MODULE_IDS];

describe('qué módulos ve cada cliente', () => {
  const rows: [string, Parameters<typeof activeModuleIds>, ModuleId[]][] = [
    ['cliente con todos los módulos', [org(ALL), 'admin'], ALL],
    ['cliente solo tanques', [org(['tanks']), 'viewer'], ['tanks']],
    ['cliente sin módulos', [org([]), 'admin'], []],
    ['usuario sin cliente que no es de plataforma', [null, 'admin'], []],
    ['sesión sin cargar', [undefined, undefined], []],
    ['plataforma sin saber el cliente de la planta: todos', [null, 'platform_admin', 'otra', []], ALL],
    ['plataforma con planta de cliente solo tanques', [null, 'platform_admin', 'cliente-tanques', [org(['tanks']), { ...org(ALL), id: 'x' }].map((o, i) => (i === 0 ? { ...o, id: 'cliente-tanques' } : o))], ['tanks']],
    ['plataforma con planta de cliente completo', [null, 'platform_admin', 'campos-demo', [{ ...org(ALL), id: 'campos-demo' }]], ALL],
  ];
  it.each(rows)('%s', (_n, args, expected) => {
    expect(activeModuleIds(...args)).toEqual(expected);
  });

  it('respeta el orden del registro aunque el cliente lo guarde desordenado', () => {
    expect(landingHref(['view3d', 'energy', 'tanks'])).toBe('/m/tanks');
  });
});

describe('landing y navegación', () => {
  it('/ lleva al primer módulo activo; sin módulos devuelve null', () => {
    expect(landingHref(['energy', 'gas'])).toBe('/m/energy');
    expect(landingHref([])).toBeNull();
    expect(moduleHref('flow')).toBe('/m/flow');
  });
  it('con un solo módulo no hay barra lateral de secciones', () => {
    expect(showSectionNav(['tanks'])).toBe(false);
    expect(showSectionNav(['tanks', 'gas'])).toBe(true);
    expect(showSectionNav([])).toBe(false);
  });
  it('barra inferior móvil: máximo 4 destinos; con más módulos, 3 + «Más»', () => {
    expect(mobileNav(['tanks'])).toEqual({ bar: [], more: [] });
    expect(mobileNav(['tanks', 'gas']).bar.map((m) => m.id)).toEqual(['tanks', 'gas']);
    expect(mobileNav(['tanks', 'climate', 'energy', 'gas']).more).toEqual([]);
    const n = mobileNav(ALL);
    expect(n.bar.map((m) => m.id)).toEqual(['tanks', 'climate', 'energy']);
    expect(n.more.map((m) => m.id)).toEqual(['gas', 'machines', 'flow', 'view3d']);
    expect(n.bar.length + (n.more.length ? 1 : 0)).toBeLessThanOrEqual(4);
  });
});

describe('permisos de la interfaz', () => {
  it('enlace de administración y reglas: admin, engineer y platform_admin', () => {
    for (const r of ['admin', 'engineer', 'platform_admin'] as const) {
      expect(showAdminLink(r)).toBe(true);
      expect(canManageRules(r)).toBe(true);
    }
    for (const r of ['operator', 'viewer', undefined] as const) expect(showAdminLink(r)).toBe(false);
  });
  it('reconocer alarmas: todos menos viewer', () => {
    expect(canAckAlarms('operator')).toBe(true);
    expect(canAckAlarms('platform_admin')).toBe(true);
    expect(canAckAlarms('viewer')).toBe(false);
    expect(canAckAlarms(null)).toBe(false);
  });
  it('el enlace de reglas lleva planta y módulo', () => {
    expect(rulesHref('demo', 'tanks')).toBe('/admin/rules?plant=demo&module=tanks');
  });
});
