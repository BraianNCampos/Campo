import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ASSET_KINDS, MODULE_IDS } from '@campo/shared';
import { ROLES } from '../auth/auth.types';

/**
 * 060_orgs.sql se prueba de verdad contra PostgreSQL (README, "Verificación"); aquí se fijan en unit los
 * invariantes del texto que NO deben divergir del código: listas de módulos/tipos/roles, idempotencia de
 * cada sentencia y los ids exactos de las semillas (docs/architecture.md §11.3).
 */
const sql = readFileSync(
  join(__dirname, '../../../../infra/timescaledb/init/060_orgs.sql'),
  'utf8',
);
const code = sql
  .split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n');

const quoted = (list: readonly string[]) => list.map((x) => `'${x}'`).join(', ');

describe('060_orgs.sql: coherencia con el código', () => {
  it('los módulos del CHECK de organizations son exactamente MODULE_IDS', () => {
    expect(code).toContain(`ARRAY[${quoted(MODULE_IDS)}]`);
    // campos-demo: todos los módulos
    expect(code).toMatch(
      new RegExp(`'campos-demo',\\s+'Agroindustria Ejemplo',\\s+ARRAY\\[${quoted(MODULE_IDS)}\\]`),
    );
    expect(code).toMatch(/'cliente-tanques',\s+'Cliente Solo Tanques',\s+ARRAY\['tanks'\]/);
  });

  it('el CHECK de assets.type lista los 10 tipos de ASSET_KINDS', () => {
    expect(code).toContain(`CHECK (type IN\n            (${quoted(Object.keys(ASSET_KINDS))}))`);
  });

  it('el CHECK de users.role lista los roles de ROLES (incluido platform_admin)', () => {
    expect(code).toContain(`CHECK (role IN (${quoted(ROLES)}))`);
  });

  it('cada INSERT es idempotente (ON CONFLICT) y cada DDL usa IF NOT EXISTS o está protegido', () => {
    const inserts = code.match(/INSERT INTO [a-z_]+/g) ?? [];
    expect(inserts.length).toBeGreaterThanOrEqual(5);
    expect((code.match(/ON CONFLICT/g) ?? []).length).toBe(inserts.length);
    // (el ADD COLUMN sin IF NOT EXISTS de audit_log va dentro de un bloque protegido por un IF NOT EXISTS)
    for (const ddl of code.match(/(CREATE TABLE|CREATE INDEX|ADD COLUMN)[^;]*/g) ?? []) {
      if (ddl.trim() !== 'ADD COLUMN org_id TEXT') expect(ddl).toMatch(/IF NOT EXISTS/);
    }
  });

  it('va en una transacción y exige NOT NULL en plants.org_id tras el backfill', () => {
    expect(code.indexOf('BEGIN;')).toBeGreaterThanOrEqual(0);
    expect(code.trimEnd().endsWith('COMMIT;')).toBe(true);
    const backfill = code.indexOf("UPDATE plants SET org_id = 'campos-demo' WHERE org_id IS NULL");
    const notNull = code.indexOf('ALTER TABLE plants ALTER COLUMN org_id SET NOT NULL');
    expect(backfill).toBeGreaterThan(0);
    expect(notNull).toBeGreaterThan(backfill);
  });

  it('registra en `plants` las plantas que sólo existían por activos, asignaciones, reglas, alarmas o modelos', () => {
    for (const table of ['assets', 'user_plants', 'alarm_rules', 'alarms', 'asset_models']) {
      expect(code).toMatch(new RegExp(`(FROM|UNION SELECT plant FROM) ${table}`));
    }
    expect(code.indexOf('INSERT INTO plants (id, name, org_id)')).toBeLessThan(
      code.indexOf('SET NOT NULL'),
    );
  });

  it('el backfill de auditoría y de usuarios no se repite en una segunda ejecución', () => {
    // audit_log: sólo al crear la columna; users: sólo filas sin cliente que no son de plataforma
    expect(code).toMatch(
      /IF NOT EXISTS \(SELECT 1 FROM information_schema\.columns[\s\S]*?ADD COLUMN org_id TEXT;\s+UPDATE audit_log SET org_id = 'campos-demo';/,
    );
    expect(code).toContain(
      "UPDATE users SET org_id = 'campos-demo' WHERE org_id IS NULL AND role <> 'platform_admin'",
    );
  });

  it('semillas §11.3: ids de activos exactos y capacityM3/contractedKw', () => {
    const demo = [
      'clima-01',
      'clima-02',
      'en-linea1',
      'en-compresores',
      'en-clima',
      'en-calderas',
      'gas-01',
      'maq-01',
      'maq-02',
      'maq-03',
      'pres-01',
      'cau-01',
    ];
    for (const id of demo) expect(code).toContain(`('demo', '${id}',`);
    for (const id of ['tk-a', 'tk-b']) expect(code).toContain(`('tanques', '${id}',`);
    expect(code).toContain('{"capacityM3": 40}');
    expect(code).toContain('metadata || \'{"capacityM3": 60}\'');
    for (const [id, kw] of [
      ['en-linea1', 220],
      ['en-compresores', 130],
      ['en-clima', 118],
      ['en-calderas', 90],
    ] as const) {
      expect(code).toMatch(new RegExp(`'${id}',[^\\n]*"contractedKw": ${kw}`));
    }
  });

  it('semillas de reglas: umbrales de la arquitectura (kw 0.9x y 1x la contratada, presión, nivel)', () => {
    for (const t of [198, 220, 117, 130, 106, 118, 81, 90])
      expect(code).toMatch(new RegExp(`'kw',\\s+'gt', ${t},`));
    expect(code).toMatch(/'pressure', 'gt', 8,\s+'critical'/);
    expect(code).toMatch(/'pressure', 'lt', 2,\s+'warning'/);
    expect(code).toMatch(/'clima-\*',\s+'temp',\s+'gt', 30::double precision,\s+'warning'/);
    expect(code).toMatch(/'clima-\*',\s+'humidity', 'gt', 80,\s+'warning'/);
    expect(code).toMatch(/'tanques', 'tk-\*',\s+'level',\s+'gt', 90,\s+'critical'/);
    expect(code).toMatch(/'tanques', 'tk-\*',\s+'level',\s+'lt', 10,\s+'warning'/);
    const ids = code.match(/'00000000-0000-4000-8000-[0-9a-f]{12}'/g) ?? [];
    expect(new Set(ids).size).toBe(ids.length); // ids de regla únicos
  });

  it('las semillas no se meten en un cliente ajeno: sólo si la planta pertenece al cliente esperado', () => {
    expect(code).toContain(
      "WHERE EXISTS (SELECT 1 FROM plants WHERE id = 'demo' AND org_id = 'campos-demo')",
    );
    expect(code).toContain(
      "WHERE EXISTS (SELECT 1 FROM plants WHERE id = 'tanques' AND org_id = 'cliente-tanques')",
    );
  });
});
