import { describe, expect, it } from 'vitest';
import {
  describeRule,
  emptyRuleForm,
  parseMetadata,
  passwordStrength,
  ruleMatchesAsset,
  validateAssetForm,
  validatePasswordChange,
  validatePlantForm,
  validateRuleForm,
  validateUserForm,
  type RuleForm,
} from './validation';

const rule = (over: Partial<RuleForm> = {}): RuleForm => ({ ...emptyRuleForm('demo'), asset: 'tk-*', metric: 'level', threshold: '90', ...over });

describe('validateRuleForm (coherente con CreateRuleDto)', () => {
  it('regla válida → valor tipado', () => {
    const { errors, value } = validateRuleForm(rule({ forSeconds: '5', hysteresis: '2.5', severity: 'critical' }));
    expect(errors).toEqual({});
    expect(value).toEqual({ plant: 'demo', asset: 'tk-*', metric: 'level', operator: 'gt', threshold: 90, severity: 'critical', forSeconds: 5, hysteresis: 2.5, enabled: true });
  });
  it('rechaza lo que rechazaría el servidor', () => {
    expect(validateRuleForm(rule({ plant: '' })).errors.plant).toBeDefined();
    expect(validateRuleForm(rule({ asset: 'TK-01' })).errors.asset).toBeDefined();
    expect(validateRuleForm(rule({ asset: '' })).errors.asset).toBeDefined();
    expect(validateRuleForm(rule({ asset: '*' })).errors.asset).toBeUndefined();
    expect(validateRuleForm(rule({ metric: 'a b' })).errors.metric).toBeDefined();
    expect(validateRuleForm(rule({ threshold: '' })).errors.threshold).toBeDefined();
    expect(validateRuleForm(rule({ threshold: 'abc' })).errors.threshold).toBeDefined();
    expect(validateRuleForm(rule({ threshold: 'Infinity' })).errors.threshold).toBeDefined();
    expect(validateRuleForm(rule({ forSeconds: '1.5' })).errors.forSeconds).toBeDefined();
    expect(validateRuleForm(rule({ forSeconds: '-1' })).errors.forSeconds).toBeDefined();
    expect(validateRuleForm(rule({ forSeconds: '86401' })).errors.forSeconds).toBeDefined();
    expect(validateRuleForm(rule({ forSeconds: '86400' })).errors.forSeconds).toBeUndefined();
    expect(validateRuleForm(rule({ hysteresis: '-0.1' })).errors.hysteresis).toBeDefined();
    expect(validateRuleForm(rule({ operator: '' })).errors.operator).toBeDefined();
  });
  it('umbrales negativos y decimales válidos', () => {
    expect(validateRuleForm(rule({ threshold: '-5.5', operator: 'lte' })).value?.threshold).toBe(-5.5);
  });
});

describe('describeRule / ruleMatchesAsset', () => {
  it('explica activación y normalización con histéresis', () => {
    expect(describeRule({ metric: 'level', operator: 'gt', threshold: 90, forSeconds: 5, hysteresis: 2 })).toBe('Se activa cuando level > 90 durante 5 s; se normaliza al bajar a 88.');
    expect(describeRule({ metric: 'level', operator: 'lt', threshold: 10, forSeconds: 0, hysteresis: 2 })).toContain('subir a 12');
    expect(describeRule({ metric: 'temp', operator: 'gte', threshold: 30, forSeconds: 0, hysteresis: 0 })).toContain('al dejar de cumplirse');
  });
  it('patrones con *', () => {
    expect(ruleMatchesAsset('tk-*', 'tk-01')).toBe(true);
    expect(ruleMatchesAsset('*', 'x')).toBe(true);
    expect(ruleMatchesAsset('tk-01', 'tk-01')).toBe(true);
    expect(ruleMatchesAsset('tk-01', 'tk-011')).toBe(false);
    expect(ruleMatchesAsset('tk.*', 'tkx1')).toBe(false);
  });
});

describe('parseMetadata y validateAssetForm', () => {
  it('vacío → {}', () => {
    expect(parseMetadata('  ')).toEqual({ ok: true, value: {} });
  });
  it('JSON inválido → error claro con línea y columna', () => {
    const r = parseMetadata('{\n  "a": 1,\n}');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/^JSON no válido/);
  });
  it('sólo objetos', () => {
    for (const bad of ['[1]', '5', 'null', '"x"']) {
      const r = parseMetadata(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/objeto JSON/);
    }
    expect(parseMetadata('{"a":{"b":1}}')).toEqual({ ok: true, value: { a: { b: 1 } } });
  });
  const form = { id: 'tk-05', name: 'Tanque 05', type: 'tank' as const, model3dRef: '', metadataText: '' };
  it('activo válido y errores de campo', () => {
    expect(validateAssetForm(form).value).toEqual({ id: 'tk-05', name: 'Tanque 05', type: 'tank', model3dRef: null, metadata: {} });
    expect(validateAssetForm({ ...form, id: 'TK 05' }).errors.id).toBeDefined();
    expect(validateAssetForm({ ...form, name: ' ' }).errors.name).toBeDefined();
    expect(validateAssetForm({ ...form, type: '' }).errors.type).toBeDefined();
    expect(validateAssetForm({ ...form, metadataText: '{"a":' }).errors.metadata).toMatch(/JSON/);
  });
  it('al editar no se valida el id (inmutable)', () => {
    expect(validateAssetForm({ ...form, id: '' }, { editing: true }).errors.id).toBeUndefined();
  });
});

describe('usuario y contraseña', () => {
  it('validateUserForm normaliza el correo y exige ≥12', () => {
    const ok = validateUserForm({ email: ' Ana@Campo.com ', password: 'x'.repeat(12), role: 'viewer', plants: ['demo', 'demo'] });
    expect(ok.value).toEqual({ email: 'ana@campo.com', password: 'x'.repeat(12), role: 'viewer', plants: ['demo'] });
    expect(validateUserForm({ email: 'ana', password: 'x'.repeat(11), role: '', plants: [] }).errors).toMatchObject({
      email: expect.any(String), password: expect.stringContaining('12'), role: expect.any(String),
    });
    expect(validateUserForm({ email: 'a@b.co', password: 'ñ'.repeat(40), role: 'viewer', plants: [] }).errors.password).toMatch(/72 bytes/);
    expect(validateUserForm({ email: 'a@b.co', password: 'x'.repeat(12), role: 'viewer', plants: ['Mala id'] }).errors.plants).toBeDefined();
  });
  it('cambio de contraseña: actual, mínimo, distinta y confirmación', () => {
    expect(validatePasswordChange({ current: 'a', next: 'b'.repeat(12), confirm: 'b'.repeat(12) })).toEqual({});
    expect(validatePasswordChange({ current: '', next: 'b'.repeat(12), confirm: 'b'.repeat(12) }).current).toBeDefined();
    expect(validatePasswordChange({ current: 'a', next: 'corta', confirm: 'corta' }).next).toMatch(/12/);
    expect(validatePasswordChange({ current: 'c'.repeat(12), next: 'c'.repeat(12), confirm: 'c'.repeat(12) }).next).toMatch(/distinta/);
    expect(validatePasswordChange({ current: 'a', next: 'b'.repeat(12), confirm: 'x' }).confirm).toMatch(/coincide/);
    expect(validatePasswordChange({ current: 'a', next: 'b'.repeat(12), confirm: '' }).confirm).toBeDefined();
  });
  it('indicador de longitud', () => {
    expect(passwordStrength('abc')).toMatchObject({ ok: false, ratio: 0.25 });
    expect(passwordStrength('a'.repeat(20))).toMatchObject({ ok: true, ratio: 1 });
  });
  it('planta: id y nombre', () => {
    expect(validatePlantForm({ id: 'norte', name: 'Norte' })).toEqual({});
    expect(validatePlantForm({ id: 'Norte', name: 'x' }).id).toBeDefined();
    expect(validatePlantForm({ id: '', name: 'x' }).id).toBeDefined();
    expect(validatePlantForm({ id: '', name: ' ' }, { editing: true })).toEqual({ name: expect.any(String) });
  });
});

describe('parseMetadata: mensajes en español', () => {
  it('indica el carácter inesperado o el final prematuro', () => {
    const a = parseMetadata('{"x": }');
    const b = parseMetadata('{"x": 1');
    expect(a.ok || a.error).toMatch(/^JSON no válido/);
    expect(b.ok || b.error).toMatch(/^JSON no válido/);
    expect(a.ok || a.error).not.toMatch(/Unexpected/);
    expect(b.ok || b.error).not.toMatch(/Unexpected/);
  });
});
