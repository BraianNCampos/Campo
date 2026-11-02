import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  AlarmPolicyDto,
  CreateRuleDto,
  KpiQuery,
  ListAlarmsQuery,
  ShelveDto,
  UpdateRuleDto,
} from './dto';

async function errors<T extends object>(cls: new () => T, body: unknown): Promise<string[]> {
  const dto = plainToInstance(cls, body);
  const errs = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
  return errs.map((e) => e.property).sort();
}

const base = {
  plant: 'demo',
  asset: 'tk-*',
  metric: 'level',
  operator: 'gt',
  threshold: 90,
  severity: 'critical',
};

describe('CreateRuleDto: regla clásica (aditivo)', () => {
  it('una regla sin ningún campo nuevo sigue siendo válida', async () => {
    expect(await errors(CreateRuleDto, base)).toEqual([]);
  });
});

describe('CreateRuleDto: kind coherente con operator', () => {
  it.each([
    ['HH', 'gt', true],
    ['HH', 'gte', true],
    ['HH', 'lt', false],
    ['HI', 'lte', false],
    ['LO', 'lt', true],
    ['LO', 'lte', true],
    ['LL', 'gt', false],
    ['LL', 'gte', false],
    ['DEV', 'gt', true],
    ['DEV', 'gte', true],
    ['DEV', 'lt', false],
    ['DEV', 'lte', false],
    ['ROC', 'gte', true],
    ['ROC', 'lt', false],
  ])('%s con %s -> válido=%s', async (kind, operator, ok) => {
    expect(await errors(CreateRuleDto, { ...base, kind, operator })).toEqual(ok ? [] : ['kind']);
  });

  it('kind desconocido -> error', async () => {
    expect(await errors(CreateRuleDto, { ...base, kind: 'XX' })).toEqual(['kind']);
    expect(await errors(CreateRuleDto, { ...base, kind: 'hh' })).toEqual(['kind']);
  });

  it('en PATCH sin operator no se puede comprobar aquí (lo hace el servicio con la regla guardada)', async () => {
    expect(await errors(UpdateRuleDto, { kind: 'LL' })).toEqual([]);
  });
});

describe('CreateRuleDto: rangos de los campos nuevos', () => {
  it.each([
    ['offDelaySeconds', 0, true],
    ['offDelaySeconds', 86_400, true],
    ['offDelaySeconds', -1, false],
    ['offDelaySeconds', 86_401, false],
    ['offDelaySeconds', 1.5, false],
    ['rocWindowSeconds', 10, true],
    ['rocWindowSeconds', 600, true],
    ['rocWindowSeconds', 9, false],
    ['rocWindowSeconds', 601, false],
    ['rocDirection', 'any', true],
    ['rocDirection', 'rise', true],
    ['rocDirection', 'fall', true],
    ['rocDirection', 'up', false],
    ['description', 'x'.repeat(200), true],
    ['description', 'x'.repeat(201), false],
    ['consequence', 'x'.repeat(300), true],
    ['consequence', 'x'.repeat(301), false],
    ['response', 'x'.repeat(300), true],
    ['response', 'x'.repeat(301), false],
    ['description', null, true],
    ['response', 5, false],
  ])('%s = %j -> válido=%s', async (field, value, ok) => {
    expect(await errors(CreateRuleDto, { ...base, [field]: value })).toEqual(ok ? [] : [field]);
  });

  it('outOfServiceReason: 3..300 caracteres tras recortar', async () => {
    expect(await errors(CreateRuleDto, { ...base, outOfServiceReason: 'abc' })).toEqual([]);
    expect(await errors(CreateRuleDto, { ...base, outOfServiceReason: '  ab  ' })).toEqual([
      'outOfServiceReason',
    ]);
    expect(await errors(CreateRuleDto, { ...base, outOfServiceReason: '' })).toEqual([
      'outOfServiceReason',
    ]);
    expect(await errors(CreateRuleDto, { ...base, outOfServiceReason: 'x'.repeat(301) })).toEqual([
      'outOfServiceReason',
    ]);
    expect(await errors(CreateRuleDto, { ...base, outOfServiceReason: null })).toEqual([]);
  });
});

describe('CreateRuleDto: suppressWhen', () => {
  const ok = { asset: 'pump-01', metric: 'rpm', operator: 'lt', value: 1 };

  it('válido con id, patrón y todos los operadores', async () => {
    expect(await errors(CreateRuleDto, { ...base, suppressWhen: ok })).toEqual([]);
    expect(
      await errors(CreateRuleDto, { ...base, suppressWhen: { ...ok, asset: 'pump-*' } }),
    ).toEqual([]);
    for (const operator of ['eq', 'neq', 'gt', 'lt']) {
      expect(await errors(CreateRuleDto, { ...base, suppressWhen: { ...ok, operator } })).toEqual(
        [],
      );
    }
    expect(await errors(CreateRuleDto, { ...base, suppressWhen: null })).toEqual([]);
  });

  it.each([
    ['asset con mayúsculas', { ...ok, asset: 'Pump' }],
    ['asset vacío', { ...ok, asset: '' }],
    ['asset con barra', { ...ok, asset: 'a/b' }],
    ['metric inválida', { ...ok, metric: 'a b' }],
    ['operador gte (no admitido)', { ...ok, operator: 'gte' }],
    ['operador desconocido', { ...ok, operator: '==' }],
    ['value NaN (null)', { ...ok, value: null }],
    ['value texto', { ...ok, value: '1' }],
    ['value infinito', { ...ok, value: Infinity }],
    ['campo extra', { ...ok, extra: 1 }],
    ['falta value', { asset: 'a', metric: 'm', operator: 'eq' }],
  ])('rechaza %s', async (_n, suppressWhen) => {
    expect(await errors(CreateRuleDto, { ...base, suppressWhen })).toEqual(['suppressWhen']);
  });

  it('no admite un valor que no sea objeto', async () => {
    expect(await errors(CreateRuleDto, { ...base, suppressWhen: 'pump-01' })).toEqual([
      'suppressWhen',
    ]);
    expect(await errors(CreateRuleDto, { ...base, suppressWhen: [ok] })).toEqual(['suppressWhen']);
  });
});

describe('ShelveDto', () => {
  it.each([
    [{ minutes: 1, reason: 'abc' }, []],
    [{ minutes: 480, reason: 'mantenimiento' }, []],
    [{ minutes: 0, reason: 'abc' }, ['minutes']],
    [{ minutes: 481, reason: 'abc' }, ['minutes']],
    [{ minutes: 1.5, reason: 'abc' }, ['minutes']],
    [{ minutes: '30', reason: 'abc' }, ['minutes']],
    [{ minutes: 30, reason: 'ab' }, ['reason']],
    [{ minutes: 30, reason: '   ' }, ['reason']],
    [{ minutes: 30, reason: 'x'.repeat(201) }, ['reason']],
    [{ minutes: 30 }, ['reason']],
    [{ reason: 'abc' }, ['minutes']],
    [{ minutes: 30, reason: 'abc', until: 5 }, ['until']],
  ])('%j -> %j', async (body, expected) => {
    expect(await errors(ShelveDto, body)).toEqual(expected);
  });
});

describe('AlarmPolicyDto y consultas', () => {
  it.each([
    [{ ratePerDay: 150, peak10min: 10, staleHours: 24 }, []],
    [{ ratePerDay: 1, peak10min: 1, staleHours: 1 }, []],
    [{ ratePerDay: 10_000, peak10min: 1_000, staleHours: 720 }, []],
    [{ ratePerDay: 0, peak10min: 10, staleHours: 24 }, ['ratePerDay']],
    [{ ratePerDay: 10_001, peak10min: 10, staleHours: 24 }, ['ratePerDay']],
    [{ ratePerDay: 150, peak10min: 0, staleHours: 24 }, ['peak10min']],
    [{ ratePerDay: 150, peak10min: 1_001, staleHours: 24 }, ['peak10min']],
    [{ ratePerDay: 150, peak10min: 10, staleHours: 721 }, ['staleHours']],
    [{ ratePerDay: 1.5, peak10min: 10, staleHours: 24 }, ['ratePerDay']],
    [{ ratePerDay: 150, peak10min: 10 }, ['staleHours']],
    [{}, ['peak10min', 'ratePerDay', 'staleHours']],
    [{ ratePerDay: 150, peak10min: 10, staleHours: 24, extra: 1 }, ['extra']],
  ])('política %j -> %j', async (body, expected) => {
    expect(await errors(AlarmPolicyDto, body)).toEqual(expected);
  });

  it('window de los KPIs y state de las alarmas', async () => {
    for (const w of ['24h', '7d', '30d']) expect(await errors(KpiQuery, { window: w })).toEqual([]);
    expect(await errors(KpiQuery, {})).toEqual([]);
    expect(await errors(KpiQuery, { window: '1h' })).toEqual(['window']);
    for (const s of ['active', 'cleared', 'shelved']) {
      expect(await errors(ListAlarmsQuery, { state: s })).toEqual([]);
    }
    expect(await errors(ListAlarmsQuery, { state: 'closed' })).toEqual(['state']);
  });
});
