import type { Pool } from 'pg';
import { PgAuditRepository } from './audit.repository';

describe('PgAuditRepository (forma de las consultas)', () => {
  const query = jest.fn().mockResolvedValue({ rows: [] });
  const repo = new PgAuditRepository({ query } as unknown as Pool);
  beforeEach(() => query.mockClear());

  it('ordena por la columna bigint calificada, no por el alias de texto `id`', async () => {
    await repo.list({ limit: 10 });
    const sql = String((query.mock.calls[0] as [string])[0]);
    // regresión: `ORDER BY id` resolvía al alias `id::text` y ordenaba "9" > "21"
    expect(sql).toMatch(/ORDER BY audit_log\.id DESC/);
    expect(sql).not.toMatch(/ORDER BY id\b/);
  });

  it('actor: un UUID filtra por actor_id; cualquier otra cosa por email (minúsculas)', async () => {
    const uuid = '11111111-1111-4111-8111-111111111111';
    await repo.list({ limit: 5, before: '40', actor: uuid, action: 'asset.create' });
    await repo.list({ limit: 5, actor: 'Ana@Campo.test' });
    const [first, second] = query.mock.calls as [string, unknown[]][];
    expect(first[1]).toEqual(['40', uuid, null, 'asset.create', 5, null]);
    expect(second[1]).toEqual([null, null, 'ana@campo.test', null, 5, null]);
    await repo.list({ limit: 5, orgId: 'cli' });
    expect((query.mock.calls[2] as [string, unknown[]])[1]).toEqual([
      null,
      null,
      null,
      null,
      5,
      'cli',
    ]);
  });

  it('inserta detail como JSON parametrizado (nunca interpolado en el SQL)', async () => {
    await repo.insert({
      actorId: null,
      actorEmail: null,
      action: 'plant.create',
      target: "plant:x'; DROP TABLE audit_log;--",
      orgId: 'campos-demo',
      detail: { name: 'N' },
    });
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).not.toContain('DROP');
    expect(params).toEqual([
      null,
      null,
      'plant.create',
      "plant:x'; DROP TABLE audit_log;--",
      'campos-demo',
      '{"name":"N"}',
    ]);
  });
});
