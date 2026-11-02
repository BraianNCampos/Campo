import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_ALARM_POLICY } from '@campo/shared';
import { KINDS, RULE_LIMITS } from './alarm.types';

/**
 * 070_alarms_isa.sql se prueba de verdad contra PostgreSQL (README, "Verificación"); aquí se fijan en unit los
 * invariantes del texto que NO deben divergir del código: tipos, límites, política por defecto e idempotencia.
 */
const sql = readFileSync(
  join(__dirname, '../../../../infra/timescaledb/init/070_alarms_isa.sql'),
  'utf8',
);
const code = sql
  .split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n');
const quoted = (list: readonly string[]) => list.map((x) => `'${x}'`).join(', ');

describe('070_alarms_isa.sql: coherencia con el código', () => {
  it('el CHECK de kind lista exactamente los 6 tipos', () => {
    expect(code).toContain(`CHECK (kind IN (${quoted(KINDS)}))`);
  });

  it('los límites de ROC, retardo y textos son los del código', () => {
    expect(code).toContain(
      `roc_window_seconds BETWEEN ${RULE_LIMITS.rocWindowMin} AND ${RULE_LIMITS.rocWindowMax}`,
    );
    expect(code).toContain(`off_delay_seconds BETWEEN 0 AND ${RULE_LIMITS.offDelayMax}`);
    expect(code).toContain(`length(description) <= ${RULE_LIMITS.descriptionMax}`);
    expect(code).toContain(`length(consequence) <= ${RULE_LIMITS.consequenceMax}`);
    expect(code).toContain(`length(response) <= ${RULE_LIMITS.responseMax}`);
    expect(code).toContain(`BETWEEN ${RULE_LIMITS.reasonMin} AND ${RULE_LIMITS.reasonMax}`);
  });

  it('la política por defecto de plants.alarm_policy es DEFAULT_ALARM_POLICY', () => {
    const m = /DEFAULT '(\{[^']+\})'::jsonb/.exec(code);
    expect(JSON.parse((m as RegExpExecArray)[1])).toEqual(DEFAULT_ALARM_POLICY);
  });

  it('el diario admite los 7 tipos de evento', () => {
    expect(code).toContain(
      `CHECK (type IN (${quoted(['activate', 'ack', 'rtn', 'shelve', 'unshelve', 'suppress', 'close'])}))`,
    );
  });

  it('el CHECK de lifecycle liga estado y ciclo de vida', () => {
    expect(code).toContain("(state = 'active' AND lifecycle IN ('unacked', 'acked', 'shelved'))");
    expect(code).toContain("(state = 'cleared' AND lifecycle IN ('rtn_unacked', 'closed'))");
  });

  it('es idempotente: IF NOT EXISTS / guardas, INSERT con ON CONFLICT, backfill de lifecycle una sola vez', () => {
    for (const ddl of code.match(/(CREATE TABLE|CREATE INDEX|ADD COLUMN)[^;,]*/g) ?? []) {
      if (ddl.includes('lifecycle TEXT NOT NULL DEFAULT')) continue; // protegido por un IF NOT EXISTS (information_schema)
      expect(ddl).toMatch(/IF NOT EXISTS/);
    }
    const inserts = code.match(/INSERT INTO [a-z_]+/g) ?? [];
    expect(inserts.length).toBeGreaterThanOrEqual(1);
    expect((code.match(/ON CONFLICT/g) ?? []).length).toBe(inserts.length);
    expect(code).toMatch(
      /IF NOT EXISTS \(SELECT 1 FROM information_schema\.columns[^;]*column_name = 'lifecycle'\)/,
    );
    expect(code).toMatch(/^BEGIN;/m);
    expect(code).toMatch(/^COMMIT;/m);
  });

  it('los setpoints se fusionan sin pisar metadata ni un setpoint ya editado', () => {
    expect(code).toContain('jsonb_build_object(s.metric, s.sp)');
    expect(code).toContain('|| CASE');
    expect(code).toContain('? s.metric');
  });

  it('el kind por defecto lo pone un trigger (los scripts antiguos siguen valiendo tras 070)', () => {
    expect(code).toContain('CREATE TRIGGER alarm_rules_default_kind_trg');
    expect(code).toContain('DROP TRIGGER IF EXISTS alarm_rules_default_kind_trg');
  });
});
