import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ASSET_KINDS,
  DEFAULT_TAG_PREFIX,
  MODULE_IDS,
  TAG_PATTERN,
  TAG_PREFIXES,
} from '@campo/shared';
import type { AssetType } from '@campo/shared';
import { ORDER_COMMANDS, ORDER_STATUSES } from '../control/control.types';

/**
 * 080_tags_control.sql se prueba de verdad contra PostgreSQL (README, "Verificación"); aquí se fijan en unit los
 * invariantes del texto que NO deben divergir del código: módulos, tipos, tags, estados de las órdenes e
 * idempotencia (docs/architecture.md §13-14).
 */
const sql = readFileSync(
  join(__dirname, '../../../../infra/timescaledb/init/080_tags_control.sql'),
  'utf8',
);
const code = sql
  .split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n');
const quoted = (list: readonly string[]) => list.map((x) => `'${x}'`).join(', ');

describe('080_tags_control.sql: coherencia con el código', () => {
  it('el CHECK de organizations.modules lista exactamente MODULE_IDS (incluido control)', () => {
    expect(code).toContain(`CHECK (modules <@ ARRAY[${quoted(MODULE_IDS)}])`);
    expect(MODULE_IDS).toContain('control');
  });

  it('el CHECK de assets.type lista los 13 tipos de ASSET_KINDS', () => {
    expect(code).toContain(
      `CHECK (type IN\n            (${quoted(Object.keys(ASSET_KINDS))}))`,
    );
  });

  it('el CHECK del tag es TAG_PATTERN (prefijos incluidos)', () => {
    const m = /tag ~ '([^']+)'/.exec(code);
    expect(m?.[1]).toBe(TAG_PATTERN.source);
    expect(TAG_PATTERN.source).toContain(TAG_PREFIXES.join('|'));
  });

  it('el backfill usa el prefijo por defecto de cada tipo (DEFAULT_TAG_PREFIX); las estructuras no llevan tag', () => {
    const body = /CASE type([\s\S]*?)END AS prefix/.exec(code)?.[1] ?? '';
    const sqlMap = new Map<string, string>();
    for (const m of body.matchAll(/WHEN '([a-z]+)'\s+THEN '([A-Z]+)'/g)) sqlMap.set(m[1], m[2]);
    const elsePrefix = /ELSE '([A-Z]+)'/.exec(body)?.[1];
    for (const type of Object.keys(ASSET_KINDS) as AssetType[]) {
      if (type === 'structure') continue;
      expect(sqlMap.get(type) ?? elsePrefix).toBe(DEFAULT_TAG_PREFIX[type]);
    }
    expect(code).toContain("WHERE type <> 'structure'");
  });

  it('el tag es único por planta sin distinguir mayúsculas (índice único parcial)', () => {
    expect(code).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS assets_plant_tag_uidx ON assets (plant, lower(tag)) WHERE tag IS NOT NULL',
    );
  });

  it('orders: comandos y estados son los del contrato', () => {
    expect(code).toContain(`CHECK (command IN (${quoted(ORDER_COMMANDS)}))`);
    expect(code).toContain(`CHECK (status IN (${quoted(ORDER_STATUSES)}))`);
  });

  it('orders: índices por planta/activo/cliente y una sola orden en curso por activo', () => {
    expect(code).toContain('orders_plant_time_idx ON orders (plant, created_at DESC)');
    expect(code).toContain('orders_asset_time_idx ON orders (plant, asset, created_at DESC)');
    expect(code).toContain('orders_org_time_idx ON orders (org_id, created_at DESC)');
    expect(code).toContain(
      "CREATE UNIQUE INDEX IF NOT EXISTS orders_one_open_uidx ON orders (plant, asset) WHERE status IN ('pending', 'accepted', 'running')",
    );
  });

  it('es idempotente: IF NOT EXISTS / guardas, INSERT con ON CONFLICT, backfill una sola vez, transacción', () => {
    for (const ddl of code.match(/(CREATE TABLE|CREATE INDEX|CREATE UNIQUE INDEX|ADD COLUMN)[^;,]*/g) ??
      []) {
      if (ddl.trim() === 'ADD COLUMN tag TEXT') continue; // protegido por un IF NOT EXISTS (information_schema)
      expect(ddl).toMatch(/IF NOT EXISTS/);
    }
    const inserts = code.match(/INSERT INTO [a-z_]+/g) ?? [];
    expect(inserts.length).toBeGreaterThanOrEqual(1);
    expect((code.match(/ON CONFLICT/g) ?? []).length).toBe(inserts.length);
    expect(code).toMatch(
      /IF NOT EXISTS \(SELECT 1 FROM information_schema\.columns[^;]*column_name = 'tag'\)/,
    );
    expect(code).toMatch(/^BEGIN;/m);
    expect(code.trimEnd().endsWith('COMMIT;')).toBe(true);
  });

  it('el backfill y el alta del módulo control ocurren dentro del bloque de "una sola vez"', () => {
    const once = /column_name = 'tag'\) THEN([\s\S]*?)END IF;\s*END \$\$;/.exec(code)?.[1] ?? '';
    expect(once).toContain('ADD COLUMN tag TEXT');
    expect(once).toContain('UPDATE assets a');
    expect(once).toContain("SET modules = modules || ARRAY['control']");
  });

  it('semillas de demo (§14.5): silos TNK-3xx, cintas, nave con layout y control 10-90 en los tanques', () => {
    for (const row of [
      "'silo-01'",
      "'silo-02'",
      "'conv-01'",
      "'conv-02'",
      "'nave-01'",
      "'TNK-301'",
      "'TNK-302'",
      "'CONV-101'",
      "'CONV-102'",
      '"layout"',
      '"capacityM3": 120',
    ]) {
      expect(code).toContain(row);
    }
    expect(code).toContain('"control": {"enabled": true, "minTarget": 10, "maxTarget": 90}');
    for (const id of ["'tk-01'", "'tk-02'", "'tk-03'", "'tk-04'", "'tk-a'", "'tk-b'"]) {
      expect(code).toContain(id);
    }
    // sólo se pisa nada si no había ya una configuración de control
    expect(code).toContain("NOT (a.metadata ? 'control')");
  });
});
