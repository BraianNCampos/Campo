import { describe, expect, it } from 'vitest';
import { canAccessSection, canEditCatalog, canManagePlants, canSeeAdminLink, isPlatformAdmin, landingSection, sectionForPath, visibleSections } from './access';

describe('guardas por rol', () => {
  it('matriz rol × sección (docs §9.2)', () => {
    const ids = (r: Parameters<typeof visibleSections>[0]) => visibleSections(r).map((s) => s.id);
    expect(ids('admin')).toEqual(['users', 'plants', 'rules', 'audit', 'account']);
    expect(ids('engineer')).toEqual(['plants', 'rules', 'account']);
    expect(ids('operator')).toEqual(['account']);
    expect(ids('viewer')).toEqual(['account']);
    expect(ids(null)).toEqual([]);
  });

  it('canAccessSection', () => {
    expect(canAccessSection('engineer', 'users')).toBe(false);
    expect(canAccessSection('engineer', 'rules')).toBe(true);
    expect(canAccessSection('viewer', 'audit')).toBe(false);
    expect(canAccessSection('viewer', 'account')).toBe(true);
    expect(canAccessSection(undefined, 'account')).toBe(false);
  });

  it('enlace Administración sólo admin/engineer; sólo admin gestiona plantas', () => {
    expect(canSeeAdminLink('admin')).toBe(true);
    expect(canSeeAdminLink('engineer')).toBe(true);
    expect(canSeeAdminLink('operator')).toBe(false);
    expect(canSeeAdminLink('viewer')).toBe(false);
    expect(canManagePlants('engineer')).toBe(false);
    expect(canManagePlants('admin')).toBe(true);
  });

  it('sección de aterrizaje y sección por ruta', () => {
    expect(landingSection('admin')?.href).toBe('/admin/users');
    expect(landingSection('engineer')?.href).toBe('/admin/plants');
    expect(landingSection('viewer')?.href).toBe('/admin/account');
    expect(landingSection(null)).toBeNull();
    expect(sectionForPath('/admin/plants/demo')).toBe('plants');
    expect(sectionForPath('/admin/audit')).toBe('audit');
    expect(sectionForPath('/')).toBeNull();
  });
});

describe('platform_admin y Clientes (docs §11)', () => {
  const ids = (r: Parameters<typeof visibleSections>[0]) => visibleSections(r).map((s) => s.id);

  it('platform_admin hereda todo y además ve Clientes (primero)', () => {
    expect(ids('platform_admin')).toEqual(['orgs', 'users', 'plants', 'rules', 'audit', 'account']);
    for (const s of ids('admin')) expect(ids('platform_admin')).toContain(s);
  });

  it('Clientes es exclusivo de plataforma', () => {
    for (const r of ['admin', 'engineer', 'operator', 'viewer'] as const) {
      expect(canAccessSection(r, 'orgs')).toBe(false);
      expect(ids(r)).not.toContain('orgs');
    }
    expect(canAccessSection('platform_admin', 'orgs')).toBe(true);
  });

  it('enlaces, aterrizaje, rutas y permisos de plataforma', () => {
    expect(canSeeAdminLink('platform_admin')).toBe(true);
    expect(canManagePlants('platform_admin')).toBe(true);
    expect(isPlatformAdmin('platform_admin')).toBe(true);
    expect(isPlatformAdmin('admin')).toBe(false);
    expect(canEditCatalog('engineer')).toBe(true);
    expect(canEditCatalog('operator')).toBe(false);
    expect(landingSection('platform_admin')?.href).toBe('/admin/orgs');
    expect(sectionForPath('/admin/orgs')).toBe('orgs');
    expect(sectionForPath('/admin/orgs/acme')).toBe('orgs');
  });
});
