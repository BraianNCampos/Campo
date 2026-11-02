import { describe, expect, it } from 'vitest';
import {
  conditionText, deriveKind, emptyRuleForm, kindOf, operatorsFor, previewFromForm, previewRule, ruleToForm, setpointMessage, setpointStatus,
  suggestedSeverity, validateRuleForm, withKind, withUnit, type PreviewInput, type RuleForm,
} from './rule-form';
import type { AlarmRule } from './types';

const rule = (over: Partial<RuleForm> = {}): RuleForm => ({ ...emptyRuleForm('demo'), asset: 'tk-*', metric: 'level', threshold: '90', ...over });
const tanks = [{ id: 'tk-01', name: 'Tanque 01' }];

describe('validateRuleForm (coherente con CreateRuleDto y §12.1)', () => {
  it('regla clásica válida → valor tipado con tipo y retardo de retorno', () => {
    const { errors, value } = validateRuleForm(rule({ forSeconds: '5', hysteresis: '2.5', severity: 'critical', kind: 'HH' }));
    expect(errors).toEqual({});
    expect(value).toMatchObject({ plant: 'demo', asset: 'tk-*', metric: 'level', operator: 'gt', threshold: 90, severity: 'critical', forSeconds: 5, hysteresis: 2.5, enabled: true, kind: 'HH', offDelaySeconds: 0 });
    expect(value).not.toHaveProperty('suppressWhen');
    expect(value).not.toHaveProperty('rocWindowSeconds');
  });
  it('campos básicos', () => {
    expect(validateRuleForm(rule({ plant: '' })).errors.plant).toBeDefined();
    expect(validateRuleForm(rule({ asset: 'TK-01' })).errors.asset).toBeDefined();
    expect(validateRuleForm(rule({ asset: '*' })).errors.asset).toBeUndefined();
    expect(validateRuleForm(rule({ metric: 'a b' })).errors.metric).toBeDefined();
    expect(validateRuleForm(rule({ threshold: '' })).errors.threshold).toBeDefined();
    expect(validateRuleForm(rule({ threshold: 'Infinity' })).errors.threshold).toBeDefined();
    expect(validateRuleForm(rule({ forSeconds: '1.5' })).errors.forSeconds).toBeDefined();
    expect(validateRuleForm(rule({ forSeconds: '86401' })).errors.forSeconds).toBeDefined();
    expect(validateRuleForm(rule({ forSeconds: '86400' })).errors.forSeconds).toBeUndefined();
    expect(validateRuleForm(rule({ offDelaySeconds: '-1' })).errors.offDelaySeconds).toBeDefined();
    expect(validateRuleForm(rule({ hysteresis: '-0.1' })).errors.hysteresis).toBeDefined();
    expect(validateRuleForm(rule({ operator: '' })).errors.operator).toBeDefined();
    expect(validateRuleForm(rule({ threshold: '-5.5', kind: 'LO', operator: 'lte' })).value?.threshold).toBe(-5.5);
  });
  it('el operador tiene que corresponder al tipo', () => {
    expect(validateRuleForm(rule({ kind: 'HI', operator: 'lt' })).errors.operator).toBeDefined();
    expect(validateRuleForm(rule({ kind: 'LL', operator: 'gt' })).errors.operator).toBeDefined();
    expect(validateRuleForm(rule({ kind: 'DEV', operator: 'lt', threshold: '5' })).value?.operator).toBe('gt');
  });
  it('DEV: el desvío tiene que ser positivo', () => {
    expect(validateRuleForm(rule({ kind: 'DEV', threshold: '0' })).errors.threshold).toMatch(/mayor que 0/);
    expect(validateRuleForm(rule({ kind: 'DEV', threshold: '-3' })).errors.threshold).toBeDefined();
    expect(validateRuleForm(rule({ kind: 'DEV', threshold: '6' })).value).toMatchObject({ kind: 'DEV', threshold: 6, operator: 'gt' });
  });
  it('ROC: ventana 10–600 y dirección; sólo se envían en ROC', () => {
    expect(validateRuleForm(rule({ kind: 'ROC', threshold: '2', rocWindowSeconds: '9' })).errors.rocWindowSeconds).toBeDefined();
    expect(validateRuleForm(rule({ kind: 'ROC', threshold: '2', rocWindowSeconds: '601' })).errors.rocWindowSeconds).toBeDefined();
    expect(validateRuleForm(rule({ kind: 'ROC', threshold: '2', rocWindowSeconds: '30.5' })).errors.rocWindowSeconds).toBeDefined();
    expect(validateRuleForm(rule({ kind: 'ROC', threshold: '2', rocWindowSeconds: '30', rocDirection: 'rise' })).value).toMatchObject({ kind: 'ROC', rocWindowSeconds: 30, rocDirection: 'rise' });
    expect(validateRuleForm(rule({ kind: 'HI', rocWindowSeconds: '5' })).errors.rocWindowSeconds).toBeUndefined();
  });
  it('supresión: activo exacto, medida, condición y valor numérico', () => {
    const sup = (o: Partial<RuleForm['suppress']>) => rule({ suppressEnabled: true, suppress: { asset: 'pump-01', metric: 'rpm', operator: 'lt', value: '1', ...o } });
    expect(validateRuleForm(sup({})).value?.suppressWhen).toEqual({ asset: 'pump-01', metric: 'rpm', operator: 'lt', value: 1 });
    expect(validateRuleForm(sup({ asset: '' })).errors['suppress.asset']).toBeDefined();
    expect(validateRuleForm(sup({ asset: 'pump-*' })).errors['suppress.asset']).toBeDefined();
    expect(validateRuleForm(sup({ metric: 'r pm' })).errors['suppress.metric']).toBeDefined();
    expect(validateRuleForm(sup({ value: 'x' })).errors['suppress.value']).toBeDefined();
    // desactivada: no se valida ni se envía (al crear); al editar se envía null para vaciarla
    const off = rule({ suppress: { asset: '', metric: '', operator: 'lt', value: '' } });
    expect(validateRuleForm(off).value).not.toHaveProperty('suppressWhen');
    expect(validateRuleForm(off, { editing: true }).value?.suppressWhen).toBeNull();
  });
  it('racionalización: límites de largo; vacío se omite (crear) o se vacía (editar)', () => {
    expect(validateRuleForm(rule({ description: 'x'.repeat(201) })).errors.description).toBeDefined();
    expect(validateRuleForm(rule({ description: 'x'.repeat(200) })).errors.description).toBeUndefined();
    expect(validateRuleForm(rule({ consequence: 'x'.repeat(301) })).errors.consequence).toBeDefined();
    expect(validateRuleForm(rule({ response: 'x'.repeat(301) })).errors.response).toBeDefined();
    const ok = validateRuleForm(rule({ description: ' Nivel alto ', consequence: 'Rebalse', response: 'Cerrá la válvula' })).value;
    expect(ok).toMatchObject({ description: 'Nivel alto', consequence: 'Rebalse', response: 'Cerrá la válvula' });
    expect(validateRuleForm(rule()).value).not.toHaveProperty('description');
    expect(validateRuleForm(rule(), { editing: true }).value?.description).toBeNull();
  });
  it('fuera de servicio exige motivo (≥3) y lo envía; en servicio no lo envía', () => {
    expect(validateRuleForm(rule({ enabled: false })).errors.outOfServiceReason).toBeDefined();
    expect(validateRuleForm(rule({ enabled: false, outOfServiceReason: ' ab ' })).errors.outOfServiceReason).toBeDefined();
    expect(validateRuleForm(rule({ enabled: false, outOfServiceReason: 'sensor roto' })).value).toMatchObject({ enabled: false, outOfServiceReason: 'sensor roto' });
    expect(validateRuleForm(rule({ outOfServiceReason: 'viejo' })).value).not.toHaveProperty('outOfServiceReason');
    expect(validateRuleForm(rule({ outOfServiceReason: 'viejo' }), { editing: true }).value?.outOfServiceReason).toBeNull();
  });
});

describe('tipos y valores por defecto', () => {
  it('deriveKind como la API; kindOf respeta el tipo explícito', () => {
    expect(deriveKind('gt', 'critical')).toBe('HH');
    expect(deriveKind('gte', 'warning')).toBe('HI');
    expect(deriveKind('lt', 'critical')).toBe('LL');
    expect(deriveKind('lte', 'warning')).toBe('LO');
    expect(kindOf({ operator: 'gt', severity: 'warning' })).toBe('HI');
    expect(kindOf({ operator: 'gt', severity: 'warning', kind: 'DEV' })).toBe('DEV');
  });
  it('withKind ajusta operador y prioridad sugerida', () => {
    const f = withKind(rule(), 'LL');
    expect(f).toMatchObject({ kind: 'LL', operator: 'lt', severity: 'critical' });
    expect(withKind(f, 'DEV')).toMatchObject({ operator: 'gt', severity: 'warning' });
    expect(withKind({ ...rule(), operator: 'gte' }, 'HH').operator).toBe('gte');
    expect(operatorsFor('ROC')).toEqual(['gt']);
    expect(suggestedSeverity('HH')).toBe('critical');
  });
  it('ruleToForm de una regla vieja (sin campos nuevos) y de una completa', () => {
    const old: AlarmRule = { id: '1', plant: 'demo', asset: 'tk-*', metric: 'level', operator: 'lt', threshold: 10, severity: 'warning', forSeconds: 5, hysteresis: 2, enabled: true, createdAt: 0, updatedAt: 0 };
    expect(ruleToForm(old)).toMatchObject({ kind: 'LO', offDelaySeconds: '0', rocWindowSeconds: '60', suppressEnabled: false, description: '' });
    const full = ruleToForm({ ...old, kind: 'ROC', rocWindowSeconds: 30, rocDirection: 'fall', suppressWhen: { asset: 'pump-01', metric: 'rpm', operator: 'lt', value: 1 }, description: 'd', enabled: false, outOfServiceReason: 'mant' });
    expect(full).toMatchObject({ kind: 'ROC', rocWindowSeconds: '30', rocDirection: 'fall', suppressEnabled: true, suppress: { asset: 'pump-01', value: '1' }, description: 'd', enabled: false, outOfServiceReason: 'mant' });
  });
  it('conditionText', () => {
    expect(conditionText({ operator: 'gt', severity: 'warning', metric: 'level', threshold: 95 })).toBe('level > 95');
    expect(conditionText({ operator: 'gt', severity: 'warning', metric: 'temp', threshold: 6, kind: 'DEV' })).toBe('desvío temp > 6');
    expect(conditionText({ operator: 'gt', severity: 'warning', metric: 'pressure', threshold: 2, kind: 'ROC' })).toBe('cambio pressure > 2/min');
  });
});

describe('vista previa en lenguaje natural', () => {
  const base: PreviewInput = { asset: 'tk-01', metric: 'level', kind: 'HH', operator: 'gt', threshold: 90, forSeconds: 5, offDelaySeconds: 0, hysteresis: 2, enabled: true };
  it('el ejemplo del pedido', () => {
    expect(previewRule(base, tanks)[0]).toBe('Avisa cuando el nivel de Tanque 01 supere 90 % durante 5 s y vuelve a normal por debajo de 88 %.');
  });
  it('bajo, con operadores inclusivos y sin banda muerta ni retardo', () => {
    expect(previewRule({ ...base, kind: 'LO', operator: 'lt', threshold: 10, forSeconds: 0 }, tanks)[0]).toBe('Avisa cuando el nivel de Tanque 01 baje de 10 % y vuelve a normal por encima de 12 %.');
    expect(previewRule({ ...base, operator: 'gte', forSeconds: 0, hysteresis: 0 }, tanks)[0]).toBe('Avisa cuando el nivel de Tanque 01 alcance o supere 90 % y vuelve a normal apenas deja de cumplirse.');
    expect(previewRule({ ...base, kind: 'LO', operator: 'lte', threshold: 10, forSeconds: 0, hysteresis: 0 }, tanks)[0]).toContain('llegue a 10 % o menos');
  });
  it('retardo de retorno, patrones y activos sin catálogo', () => {
    expect(previewRule({ ...base, offDelaySeconds: 30 }, tanks)[0]).toMatch(/88 % y se sostiene 30 s\.$/);
    expect(previewRule({ ...base, asset: 'tk-*' })[0]).toContain('cualquiera de los activos «tk-*»');
    expect(previewRule({ ...base, asset: 'pump-09' })[0]).toContain('de pump-09');
  });
  it('DEV y ROC', () => {
    expect(previewRule({ ...base, metric: 'temp', kind: 'DEV', threshold: 6, hysteresis: 1, forSeconds: 0 }, [{ id: 'tk-01', name: 'Cámara 1' }])[0]).toBe(
      'Avisa cuando la temperatura de Cámara 1 se desvíe más de 6 °C de su setpoint y vuelve a normal cuando la desviación baja de 5 °C.',
    );
    expect(previewRule({ ...base, metric: 'pressure', kind: 'ROC', threshold: 2, rocWindowSeconds: 30, rocDirection: 'rise', forSeconds: 0, hysteresis: 0 })[0]).toBe(
      'Avisa cuando la presión de tk-01 suba más de 2 bar por minuto (medido en 30 s) y vuelve a normal cuando deja de cambiar tan rápido.',
    );
    expect(previewRule({ ...base, kind: 'ROC', metric: 'level', threshold: 5, rocDirection: 'any', forSeconds: 0 })[0]).toContain('cambie más de 5 % por minuto');
  });
  it('supresión y fuera de servicio agregan frases', () => {
    const out = previewRule({ ...base, suppressWhen: { asset: 'pump-01', metric: 'rpm', operator: 'lt', value: 1 }, enabled: false, outOfServiceReason: 'en calibración' }, tanks);
    expect(out).toHaveLength(3);
    expect(out[1]).toBe('No avisa mientras la velocidad de pump-01 es menor que 1 rpm: en ese caso la alarma se suprime y se cuenta como suprimida.');
    expect(out[2]).toBe('Fuera de servicio: no avisa. Motivo: en calibración.');
  });
  it('previewFromForm: null hasta tener métrica y umbral; usa el formulario', () => {
    expect(previewFromForm(rule({ threshold: '' }))).toBeNull();
    expect(previewFromForm(rule({ asset: 'tk-01', threshold: '95', forSeconds: '3', hysteresis: '2' }), tanks)?.[0]).toContain('supere 95 % durante 3 s y vuelve a normal por debajo de 93 %');
    expect(withUnit('humidity', 80)).toBe('80 %');
    expect(withUnit('state', 1)).toBe('1');
  });
});

describe('setpoints (DEV)', () => {
  const a = (id: string, sp?: number) => ({ id, metadata: sp === undefined ? {} : { setpoints: { level: sp } } });
  it('estado según los activos que abarca el patrón', () => {
    expect(setpointStatus('tk-*', 'level', [a('tk-01', 60), a('tk-02', 60)])).toBe('ok');
    expect(setpointStatus('tk-*', 'level', [a('tk-01', 60), a('tk-02')])).toBe('partial');
    expect(setpointStatus('tk-*', 'level', [a('tk-01'), a('tk-02')])).toBe('missing');
    expect(setpointStatus('pump-*', 'level', [a('tk-01', 60)])).toBe('unknown');
    expect(setpointStatus('tk-01', '', [a('tk-01', 60)])).toBe('unknown');
  });
  it('mensajes', () => {
    expect(setpointMessage('missing', 'level')).toMatch(/no se evalúa hasta que lo tenga.*level_sp/);
    expect(setpointMessage('partial', 'level')).toMatch(/Algunos/);
    expect(setpointMessage('ok', 'level')).toBeNull();
  });
});
