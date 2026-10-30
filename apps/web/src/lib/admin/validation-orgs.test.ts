import { describe, expect, it } from 'vitest';
import { MODULE_DISABLED_TEXT } from './errors';
import {
  domainFormFrom,
  emptyDomainForm,
  emptyLayoutForm,
  isTypeAllowed,
  mergeDomainIntoMetadata,
  metricLabel,
  metricsForAssets,
  passwordStrength,
  syncDomainIntoText,
  validateAssetForm,
  validateDomainForm,
  validateMetadataDomain,
  validateOrgAdminForm,
  validateOrgForm,
  validateUserForm,
  type AssetForm,
  type DomainForm,
} from './validation';

describe('validateOrgForm', () => {
  const ok = { id: 'acme-sa', name: 'Acme', modules: ['tanks' as const] };
  it('válido', () => expect(validateOrgForm(ok)).toEqual({}));
  it('id con ID_PATTERN (sólo al crear)', () => {
    for (const id of ['', 'Acme', 'con espacio', '-x', 'a'.repeat(65)]) expect(validateOrgForm({ ...ok, id }).id).toBeDefined();
    expect(validateOrgForm({ ...ok, id: 'Mal Id' }, { editing: true }).id).toBeUndefined();
  });
  it('nombre obligatorio y ≤100', () => {
    expect(validateOrgForm({ ...ok, name: ' ' }).name).toBeDefined();
    expect(validateOrgForm({ ...ok, name: 'x'.repeat(101) }).name).toMatch(/100/);
  });
  it('al menos un módulo y sólo conocidos', () => {
    expect(validateOrgForm({ ...ok, modules: [] }).modules).toMatch(/al menos un módulo/);
    expect(validateOrgForm({ ...ok, modules: ['raro' as never] }).modules).toMatch(/no existe/);
    expect(validateOrgForm({ ...ok, modules: ['energy', 'gas', 'view3d'] })).toEqual({});
  });
});

describe('validateOrgAdminForm y fortaleza', () => {
  it('correo y contraseña ≥12', () => {
    expect(validateOrgAdminForm({ email: ' Jefe@Acme.com ', password: 'x'.repeat(12) }).value).toEqual({ email: 'jefe@acme.com', password: 'x'.repeat(12) });
    const bad = validateOrgAdminForm({ email: 'no', password: 'corta' }).errors;
    expect(bad.email).toBeDefined();
    expect(bad.password).toMatch(/Mínimo 12.*llevás 5/);
  });
  it('indicador simple: corta, aceptable, buena, muy buena', () => {
    expect(passwordStrength('abc')).toMatchObject({ ok: false, level: 0, label: 'Muy corta' });
    expect(passwordStrength('a'.repeat(12))).toMatchObject({ ok: true, level: 1, label: 'Aceptable' });
    expect(passwordStrength('a'.repeat(16)).level).toBe(2);
    expect(passwordStrength('Abcdefgh123!').level).toBe(2);
    expect(passwordStrength('Abcdefgh123!zzzz').level).toBe(3);
  });
});

describe('validateUserForm con clientes', () => {
  const base = { email: 'a@b.co', password: 'x'.repeat(12), plants: ['demo'] };
  it('el platform_admin debe elegir cliente, salvo para otro platform_admin (sin plantas ni cliente)', () => {
    expect(validateUserForm({ ...base, role: 'viewer' }, { actorRole: 'platform_admin' }).errors.orgId).toMatch(/cliente/);
    expect(validateUserForm({ ...base, role: 'viewer', orgId: 'acme' }, { actorRole: 'platform_admin' }).value).toMatchObject({ orgId: 'acme', role: 'viewer' });
    const staff = validateUserForm({ ...base, role: 'platform_admin', orgId: 'acme' }, { actorRole: 'platform_admin' });
    expect(staff.value).toMatchObject({ role: 'platform_admin', plants: [] });
    expect(staff.value && 'orgId' in staff.value).toBe(false);
  });
  it('un administrador de cliente no otorga platform_admin ni envía orgId', () => {
    expect(validateUserForm({ ...base, role: 'platform_admin' }).errors.role).toMatch(/Campos Ingeniería/);
    const v = validateUserForm({ ...base, role: 'viewer', orgId: 'otro' });
    expect(v.value && 'orgId' in v.value).toBe(false);
  });
});

describe('campos de dominio: capacityM3, contractedKw, scale', () => {
  const dom = (over: Partial<DomainForm> = {}): DomainForm => ({ ...emptyDomainForm(), ...over });

  it('tanque: capacidad opcional, > 0, con coma decimal', () => {
    expect(validateDomainForm(dom(), 'tank').value.capacityM3).toBeNull();
    expect(validateDomainForm(dom({ capacityM3: '60' }), 'tank').value.capacityM3).toBe(60);
    expect(validateDomainForm(dom({ capacityM3: '12,5' }), 'tank').value.capacityM3).toBe(12.5);
    for (const bad of ['0', '-3', 'abc']) expect(validateDomainForm(dom({ capacityM3: bad }), 'tank').errors.capacityM3).toMatch(/mayor que 0/);
  });
  it('energía: potencia contratada; no aplica a otros tipos', () => {
    expect(validateDomainForm(dom({ contractedKw: '220' }), 'energy').value.contractedKw).toBe(220);
    expect(validateDomainForm(dom({ contractedKw: '0' }), 'energy').errors.contractedKw).toBeDefined();
    expect(validateDomainForm(dom({ contractedKw: '0' }), 'tank').errors).toEqual({}); // no se muestra para tanques: se ignora
    expect(validateDomainForm(dom({ capacityM3: '-1' }), 'energy').errors).toEqual({});
  });
  it('escala por métrica del tipo: mín < máx, ambos o ninguno', () => {
    const f = (min: string, max: string) => dom({ scale: { level: { min, max } } });
    expect(validateDomainForm(f('0', '120'), 'tank').value.scale).toMatchObject({ level: { min: 0, max: 120 }, temp: null });
    expect(validateDomainForm(f('', ''), 'tank').value.scale?.level).toBeNull();
    expect(validateDomainForm(f('10', ''), 'tank').errors['scale:level']).toMatch(/mínimo y el máximo/);
    expect(validateDomainForm(f('5', '5'), 'tank').errors['scale:level']).toMatch(/menor que el máximo/);
    expect(validateDomainForm(f('9', '3'), 'tank').errors['scale:level']).toBeDefined();
    expect(validateDomainForm(f('a', '3'), 'tank').errors['scale:level']).toMatch(/números/);
    // una métrica que el tipo no tiene no se valida
    expect(validateDomainForm(dom({ scale: { kw: { min: '9', max: '1' } } }), 'tank').errors).toEqual({});
  });
  it('lee los campos del metadata (sólo números)', () => {
    const f = domainFormFrom({ capacityM3: 60, contractedKw: 'x', scale: { level: { min: 0, max: 100 }, malo: { min: 'a', max: 1 } } });
    expect(f).toEqual({ capacityM3: '60', contractedKw: '', scale: { level: { min: '0', max: '100' } } });
    expect(domainFormFrom(null)).toEqual(emptyDomainForm());
  });
  it('validateMetadataDomain señala lo escrito a mano en el JSON', () => {
    expect(validateMetadataDomain({ capacityM3: 60, contractedKw: 10, scale: { kw: { min: 0, max: 5 } } })).toEqual([]);
    expect(validateMetadataDomain({ capacityM3: 'x' })[0]).toMatch(/capacityM3/);
    expect(validateMetadataDomain({ contractedKw: 0 })[0]).toMatch(/contractedKw/);
    expect(validateMetadataDomain({ scale: 3 })[0]).toMatch(/objeto/);
    expect(validateMetadataDomain({ scale: { kw: { min: 4, max: 1 } } })[0]).toMatch(/scale\.kw/);
    expect(validateMetadataDomain({ scale: { kw: { min: 'a' } } })[0]).toMatch(/numéricos/);
    expect(validateMetadataDomain({ scale: { 'a b': { min: 0, max: 1 } } })[0]).toMatch(/métrica/);
  });
});

describe('sincronía de los campos de dominio con el JSON avanzado (sin pisar claves manuales)', () => {
  it('merge conserva claves propias y otras métricas de scale; null quita', () => {
    const meta = { notas: 'a mano', layout: { x: 1, z: 2 }, capacityM3: 10, scale: { temp: { min: 0, max: 80 }, level: { min: 0, max: 100 } } };
    const out = mergeDomainIntoMetadata(meta, { capacityM3: 60, scale: { level: { min: 0, max: 120 } } });
    expect(out).toEqual({ notas: 'a mano', layout: { x: 1, z: 2 }, capacityM3: 60, scale: { temp: { min: 0, max: 80 }, level: { min: 0, max: 120 } } });
    const cleared = mergeDomainIntoMetadata(out, { capacityM3: null, scale: { level: null, temp: null } });
    expect(cleared).toEqual({ notas: 'a mano', layout: { x: 1, z: 2 } });
    expect(meta.capacityM3).toBe(10); // no muta
  });
  it('syncDomainIntoText reescribe el JSON; JSON inválido → null (no se toca); vacío → ""', () => {
    expect(JSON.parse(syncDomainIntoText('{"x":1}', { capacityM3: 40 })!)).toEqual({ x: 1, capacityM3: 40 });
    expect(syncDomainIntoText('{"x":', { capacityM3: 40 })).toBeNull();
    expect(syncDomainIntoText('{"capacityM3":5}', { capacityM3: null })).toBe('');
    expect(JSON.parse(syncDomainIntoText('', { contractedKw: 90, scale: { kw: { min: 0, max: 100 } } })!)).toEqual({ contractedKw: 90, scale: { kw: { min: 0, max: 100 } } });
  });
});

describe('validateAssetForm con dominio y módulos', () => {
  const form = (over: Partial<AssetForm> = {}): AssetForm => ({
    id: 'tk-9', name: 'T9', type: 'tank', model3dRef: '', layout: emptyLayoutForm(), connectsTo: [], metadataText: '', domain: emptyDomainForm(), ...over,
  });

  it('los campos de dominio se escriben en metadata y respetan las claves manuales', () => {
    const v = validateAssetForm(form({ metadataText: '{"notas":"a mano"}', domain: { capacityM3: '40', contractedKw: '', scale: { level: { min: '0', max: '110' } } } }));
    expect(v.errors).toEqual({});
    expect(v.value?.metadata).toEqual({ notas: 'a mano', capacityM3: 40, scale: { level: { min: 0, max: 110 } } });
  });
  it('errores de dominio impiden guardar y se indexan por campo', () => {
    const v = validateAssetForm(form({ domain: { ...emptyDomainForm(), capacityM3: '-2' } }));
    expect(v.value).toBeUndefined();
    expect(v.errors.capacityM3).toBeDefined();
    expect(validateAssetForm(form({ metadataText: '{"capacityM3":"x"}' })).errors.metadata).toMatch(/capacityM3/);
  });
  it('un tipo de un módulo no contratado se rechaza con el mensaje claro', () => {
    const v = validateAssetForm(form({ type: 'climate' }), { modules: ['tanks'] });
    expect(v.errors.type).toBe(MODULE_DISABLED_TEXT);
    expect(v.value).toBeUndefined();
    expect(validateAssetForm(form({ type: 'pump' }), { modules: ['tanks'] }).errors.type).toBeUndefined();
    expect(validateAssetForm(form({ type: 'sensor' }), { modules: [] }).errors.type).toBeUndefined(); // genérico
    expect(validateAssetForm(form({ type: 'climate' })).errors.type).toBeUndefined(); // sin lista de módulos no se valida
  });
  it('al editar no se vuelve a exigir el módulo si el tipo no cambia', () => {
    expect(validateAssetForm(form({ type: 'climate' }), { modules: ['tanks'], editing: true, originalType: 'climate' }).errors.type).toBeUndefined();
    expect(validateAssetForm(form({ type: 'energy' }), { modules: ['tanks'], editing: true, originalType: 'climate' }).errors.type).toBe(MODULE_DISABLED_TEXT);
  });
  it('isTypeAllowed', () => {
    expect(isTypeAllowed('flow', ['flow'])).toBe(true);
    expect(isTypeAllowed('pressure', ['tanks'])).toBe(false);
    expect(isTypeAllowed('sensor', [])).toBe(true);
  });
});

describe('métricas ofrecidas por tipo de activo', () => {
  const assets = [
    { id: 'tk-01', type: 'tank' as const },
    { id: 'tk-02', type: 'tank' as const },
    { id: 'pump-01', type: 'pump' as const },
    { id: 'en-1', type: 'energy' as const },
    { id: 's-1', type: 'sensor' as const },
  ];
  it('según el activo o patrón', () => {
    expect(metricsForAssets('tk-01', assets)).toEqual(['level', 'temp']);
    expect(metricsForAssets('tk-*', assets)).toEqual(['level', 'temp']);
    expect(metricsForAssets('pump-*', assets)).toEqual(['rpm', 'current']);
    expect(metricsForAssets('en-1', assets)).toEqual(['kw', 'kwh', 'pf']);
    expect(metricsForAssets('s-1', assets)).toEqual([]); // sensor genérico: métrica libre
    expect(metricsForAssets('nada', assets)).toEqual([]);
  });
  it('"*" o vacío abarcan a todos, sin repetir', () => {
    const all = metricsForAssets('*', assets);
    expect(all).toEqual(['level', 'temp', 'rpm', 'current', 'kw', 'kwh', 'pf']);
    expect(metricsForAssets('', assets)).toEqual(all);
  });
  it('etiquetas con unidad', () => {
    expect(metricLabel('level')).toBe('Nivel (%)');
    expect(metricLabel('pf')).toBe('Factor de potencia');
    expect(metricLabel('custom')).toBe('custom');
  });
});

describe('escala: sólo métricas con barra', () => {
  it('los contadores acumulados no tienen barra de rango', async () => {
    const { scaleMetricsFor } = await import('./validation');
    expect(scaleMetricsFor('energy')).toEqual(['kw', 'pf']);
    expect(scaleMetricsFor('gas')).toEqual(['flow']);
    expect(scaleMetricsFor('tank')).toEqual(['level', 'temp']);
    expect(scaleMetricsFor('sensor')).toEqual([]);
    expect(scaleMetricsFor('')).toEqual([]);
  });
});
