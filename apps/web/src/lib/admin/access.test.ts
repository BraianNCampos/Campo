import { describe, expect, it } from 'vitest';
import { canAccessSection, canManagePlants, canSeeAdminLink, landingSection, sectionForPath, visibleSections } from './access';

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
