-- Tags, tipos silo/conveyor/structure y control de llenado (docs/architecture.md, 13-14). Idempotente: se puede
-- aplicar varias veces, también sobre una base que ya tiene activos, clientes y alarmas de fases anteriores.
-- Requiere 020 a 070 ya aplicados (orden lexicográfico en init/). Los scripts de init sólo corren al crear el
-- volumen: en bases existentes aplicar a mano ANTES de arrancar la versión nueva de la API (ver apps/api/README.md).
-- Todo se hace en una transacción: o se aplica entero o no se aplica nada.

BEGIN;

-- Módulo `control` en los clientes ---------------------------------------------------------------------------------
-- Se sustituye el CHECK de organizations.modules (8 módulos). El viejo se localiza por contenido, no por nombre.
DO $$
DECLARE c record;
BEGIN
    FOR c IN SELECT conname FROM pg_constraint
              WHERE conrelid = 'organizations'::regclass AND contype = 'c'
                AND pg_get_constraintdef(oid) LIKE '%view3d%'
                AND pg_get_constraintdef(oid) NOT LIKE '%control%'
    LOOP
        EXECUTE format('ALTER TABLE organizations DROP CONSTRAINT %I', c.conname);
    END LOOP;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'organizations'::regclass AND conname = 'organizations_modules_check') THEN
        ALTER TABLE organizations ADD CONSTRAINT organizations_modules_check
            CHECK (modules <@ ARRAY['tanks', 'climate', 'energy', 'gas', 'machines', 'flow', 'view3d', 'control']);
    END IF;
END $$;

-- Tipos de activo ampliados (13 tipos, docs/architecture.md 13) ---------------------------------------------------------
DO $$
DECLARE c record;
BEGIN
    FOR c IN SELECT conname FROM pg_constraint
              WHERE conrelid = 'assets'::regclass AND contype = 'c'
                AND pg_get_constraintdef(oid) LIKE '%''tank''%'
                AND pg_get_constraintdef(oid) NOT LIKE '%''structure''%'
    LOOP
        EXECUTE format('ALTER TABLE assets DROP CONSTRAINT %I', c.conname);
    END LOOP;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'assets'::regclass AND conname = 'assets_type_check') THEN
        ALTER TABLE assets ADD CONSTRAINT assets_type_check CHECK (type IN
            ('tank', 'pump', 'valve', 'sensor', 'climate', 'energy', 'gas', 'machine', 'pressure', 'flow', 'silo', 'conveyor', 'structure'));
    END IF;
END $$;

-- Tags (docs/architecture.md 14.1) ------------------------------------------------------------------------------------------
-- El backfill y las semillas "de una sola vez" se hacen UNA sola vez (al crear la columna): reaplicar la migración
-- no debe asignar tags a activos que se dejaron sin tag a propósito ni volver a activar el módulo `control`.
-- Tag = prefijo por tipo (DEFAULT_TAG_PREFIX) + número desde 101, por planta y prefijo, en orden de id. Las
-- estructuras (decorativas) no reciben tag. Con más de 9899 activos de un mismo prefijo en una planta el resto queda sin tag.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = current_schema() AND table_name = 'assets' AND column_name = 'tag') THEN
        ALTER TABLE assets ADD COLUMN tag TEXT;

        UPDATE assets a
           SET tag = t.prefix || '-' || t.n
          FROM (
            SELECT s.plant, s.id, s.prefix,
                   100 + row_number() OVER (PARTITION BY s.plant, s.prefix ORDER BY s.id) AS n
              FROM (
                SELECT plant, id,
                       CASE type
                           WHEN 'tank'     THEN 'TNK'
                           WHEN 'silo'     THEN 'TNK'
                           WHEN 'pump'     THEN 'PMP'
                           WHEN 'valve'    THEN 'VLV'
                           WHEN 'machine'  THEN 'MTR'
                           WHEN 'conveyor' THEN 'CONV'
                           ELSE 'XMTR'
                       END AS prefix
                  FROM assets
                 WHERE type <> 'structure'
              ) AS s
          ) AS t
         WHERE a.plant = t.plant AND a.id = t.id AND t.n <= 9999;

        -- El cliente de demostración contrata el módulo de control (el de sólo tanques no).
        UPDATE organizations SET modules = modules || ARRAY['control']
         WHERE id = 'campos-demo' AND NOT ('control' = ANY (modules));
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'assets'::regclass AND conname = 'assets_tag_check') THEN
        ALTER TABLE assets ADD CONSTRAINT assets_tag_check
            CHECK (tag IS NULL OR tag ~ '^(TNK|PMP|VLV|MTR|XMTR|PID|COMP|CONV)-[0-9]{3,4}[A-Z]?$');
    END IF;
END $$;

-- Único por planta sin distinguir mayúsculas; los activos sin tag no cuentan.
CREATE UNIQUE INDEX IF NOT EXISTS assets_plant_tag_uidx ON assets (plant, lower(tag)) WHERE tag IS NOT NULL;

-- Órdenes de control (docs/architecture.md 14.3) ------------------------------------------------------------------------------
-- Registro de cada orden enviada a un equipo. `org_id`, `plant` y `asset` sin FK a propósito: el registro (auditoría
-- operativa) sobrevive al borrado del activo, la planta o el cliente. `requested_email` es una copia para no perder
-- quién fue si se borra el usuario. `max_duration_minutes` es la copia de metadata.control al crear la orden.
-- Estados: pending -> accepted -> running -> done (o rejected, failed, timeout, cancelled).
CREATE TABLE IF NOT EXISTS orders (
    id                   UUID             PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id               TEXT             NOT NULL,
    plant                TEXT             NOT NULL CHECK (plant ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
    asset                TEXT             NOT NULL CHECK (asset ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
    tag                  TEXT,
    command              TEXT             NOT NULL
                         CHECK (command IN ('fill', 'drain', 'stop', 'start', 'open', 'close', 'set_position')),
    target               DOUBLE PRECISION,
    status               TEXT             NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending', 'accepted', 'running', 'done', 'failed', 'rejected', 'timeout', 'cancelled')),
    reason               TEXT             CHECK (reason IS NULL OR length(reason) <= 300),
    requested_by         UUID,
    requested_email      TEXT             NOT NULL,
    max_duration_minutes INTEGER          NOT NULL DEFAULT 120 CHECK (max_duration_minutes BETWEEN 1 AND 1440),
    created_at           TIMESTAMPTZ      NOT NULL DEFAULT now(),
    accepted_at          TIMESTAMPTZ,
    running_at           TIMESTAMPTZ,
    finished_at          TIMESTAMPTZ,
    updated_at           TIMESTAMPTZ      NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS orders_plant_time_idx ON orders (plant, created_at DESC);
CREATE INDEX IF NOT EXISTS orders_asset_time_idx ON orders (plant, asset, created_at DESC);
CREATE INDEX IF NOT EXISTS orders_org_time_idx ON orders (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS orders_open_idx ON orders (created_at) WHERE status IN ('pending', 'accepted', 'running');
-- Una sola orden en curso por activo (la API además lo comprueba antes: 409 order_in_progress).
CREATE UNIQUE INDEX IF NOT EXISTS orders_one_open_uidx ON orders (plant, asset) WHERE status IN ('pending', 'accepted', 'running');

-- Semillas de desarrollo/pruebas (docs/architecture.md 14.5) ----------------------------------------------------------------
-- Sólo si la planta es del cliente esperado (si alguien la reasignó, no se mete nada en un cliente ajeno) y sin pisar
-- nada (ON CONFLICT DO NOTHING también cubre un tag ya usado). Los tags de las semillas son fijos: TNK-3xx para silos,
-- CONV-1xx para cintas.
INSERT INTO assets (plant, id, name, type, model3d_ref, metadata, tag)
SELECT v.plant, v.id, v.name, v.type, NULL, v.metadata::jsonb, v.tag
  FROM (VALUES
    ('demo', 'silo-01', 'Silo 01',         'silo',      '{"capacityM3": 120}',                         'TNK-301'),
    ('demo', 'silo-02', 'Silo 02',         'silo',      '{"capacityM3": 120}',                         'TNK-302'),
    ('demo', 'conv-01', 'Cinta 01',        'conveyor',  '{}',                                          'CONV-101'),
    ('demo', 'conv-02', 'Cinta 02',        'conveyor',  '{}',                                          'CONV-102'),
    ('demo', 'nave-01', 'Nave principal',  'structure', '{"layout": {"x": 0, "z": 0, "y": 0}}',        NULL)
  ) AS v(plant, id, name, type, metadata, tag)
 WHERE EXISTS (SELECT 1 FROM plants WHERE id = 'demo' AND org_id = 'campos-demo')
ON CONFLICT DO NOTHING;

-- Control de llenado habilitado en los tanques de las plantas de demostración (mín. 10 %, máx. 90 %). Se fusiona en
-- metadata.control sin pisar un valor ya editado ni el resto de metadata.
UPDATE assets a
   SET metadata = a.metadata || '{"control": {"enabled": true, "minTarget": 10, "maxTarget": 90}}'::jsonb
 WHERE NOT (a.metadata ? 'control')
   AND ((a.plant = 'demo'    AND a.id IN ('tk-01', 'tk-02', 'tk-03', 'tk-04'))
     OR (a.plant = 'tanques' AND a.id IN ('tk-a', 'tk-b')))
   AND EXISTS (SELECT 1 FROM plants p
                WHERE p.id = a.plant
                  AND p.org_id = CASE a.plant WHEN 'demo' THEN 'campos-demo' ELSE 'cliente-tanques' END);

COMMIT;
