-- Clientes (organizaciones) y módulos (docs/architecture.md, 11). Idempotente: se puede aplicar varias veces,
-- también sobre una base que ya tiene datos de las fases anteriores.
-- Requiere 020, 030, 040 y 050 ya aplicados (orden lexicográfico en init/). Los scripts de init sólo corren al
-- crear el volumen: en bases existentes aplicar a mano ANTES de arrancar la versión nueva de la API
-- (ver apps/api/README.md). Todo se hace en una transacción: o se aplica entero o no se aplica nada.

BEGIN;

-- Clientes ----------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS organizations (
    id         TEXT        PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
    name       TEXT        NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
    modules    TEXT[]      NOT NULL DEFAULT '{}'
               CHECK (modules <@ ARRAY['tanks', 'climate', 'energy', 'gas', 'machines', 'flow', 'view3d']),
    active     BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Cliente de las instalaciones y usuarios que ya existían (todos los módulos) y cliente de demostración
-- de sólo tanques. No pisan cambios hechos después.
INSERT INTO organizations (id, name, modules) VALUES
    ('campos-demo',     'Agroindustria Ejemplo',  ARRAY['tanks', 'climate', 'energy', 'gas', 'machines', 'flow', 'view3d']),
    ('cliente-tanques', 'Cliente Solo Tanques',   ARRAY['tanks'])
ON CONFLICT (id) DO NOTHING;

-- Plantas y usuarios: pertenencia ----------------------------------------------------------------------
-- plants.org_id NOT NULL. Las plantas que sólo existían por activos, asignaciones, reglas, alarmas o modelos
-- se registran antes (nombre = id) para poder asignarlas a un cliente. La columna se añade primero (nullable)
-- para que el INSERT con org_id explícito sea válido también cuando ya es NOT NULL (segunda ejecución).
ALTER TABLE plants ADD COLUMN IF NOT EXISTS org_id TEXT REFERENCES organizations (id);

INSERT INTO plants (id, name, org_id)
SELECT p, p, 'campos-demo' FROM (
    SELECT plant AS p FROM assets
    UNION SELECT plant FROM user_plants
    UNION SELECT plant FROM alarm_rules
    UNION SELECT plant FROM alarms
    UNION SELECT plant FROM asset_models
) AS known
ON CONFLICT (id) DO NOTHING;

UPDATE plants SET org_id = 'campos-demo' WHERE org_id IS NULL;
ALTER TABLE plants ALTER COLUMN org_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS plants_org_idx ON plants (org_id);

-- users.org_id: NULL = personal de Campos Ingeniería (platform_admin). Los usuarios existentes (incluidos los
-- admin) pasan a ser del cliente campos-demo; el usuario sembrado por ADMIN_EMAIL lo promueve la API al arrancar.
ALTER TABLE users ADD COLUMN IF NOT EXISTS org_id TEXT REFERENCES organizations (id);
UPDATE users SET org_id = 'campos-demo' WHERE org_id IS NULL AND role <> 'platform_admin';
CREATE INDEX IF NOT EXISTS users_org_idx ON users (org_id);

-- Rol platform_admin y restricciones --------------------------------------------------------------------
-- Se sustituye el CHECK de `role` (su nombre automático es users_role_check, pero se busca por contenido).
DO $$
DECLARE c record;
BEGIN
    FOR c IN SELECT conname FROM pg_constraint
              WHERE conrelid = 'users'::regclass AND contype = 'c'
                AND pg_get_constraintdef(oid) LIKE '%''operator''%'
                AND pg_get_constraintdef(oid) NOT LIKE '%platform_admin%'
    LOOP
        EXECUTE format('ALTER TABLE users DROP CONSTRAINT %I', c.conname);
    END LOOP;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'users'::regclass AND conname = 'users_role_check') THEN
        ALTER TABLE users ADD CONSTRAINT users_role_check
            CHECK (role IN ('platform_admin', 'admin', 'engineer', 'operator', 'viewer'));
    END IF;
    -- Invariante: sólo el personal de plataforma no tiene cliente; todos los demás roles sí.
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'users'::regclass AND conname = 'users_org_role_check') THEN
        ALTER TABLE users ADD CONSTRAINT users_org_role_check
            CHECK ((role = 'platform_admin') = (org_id IS NULL));
    END IF;
END $$;

-- Tipos de activo ampliados (10 tipos, docs/architecture.md 11.2) ---------------------------------------
DO $$
DECLARE c record;
BEGIN
    FOR c IN SELECT conname FROM pg_constraint
              WHERE conrelid = 'assets'::regclass AND contype = 'c'
                AND pg_get_constraintdef(oid) LIKE '%''tank''%'
                AND pg_get_constraintdef(oid) NOT LIKE '%''machine''%'
    LOOP
        EXECUTE format('ALTER TABLE assets DROP CONSTRAINT %I', c.conname);
    END LOOP;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'assets'::regclass AND conname = 'assets_type_check') THEN
        ALTER TABLE assets ADD CONSTRAINT assets_type_check CHECK (type IN
            ('tank', 'pump', 'valve', 'sensor', 'climate', 'energy', 'gas', 'machine', 'pressure', 'flow'));
    END IF;
END $$;

-- Auditoría por cliente -------------------------------------------------------------------------------------
-- org_id = cliente del recurso afectado (NULL = acción de plataforma sin cliente). Sin FK a propósito: el
-- registro sobrevive al borrado del cliente. Las entradas anteriores a esta migración son todas del único
-- cliente que existía: se atribuyen a campos-demo UNA sola vez (al crear la columna).
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = current_schema() AND table_name = 'audit_log' AND column_name = 'org_id') THEN
        ALTER TABLE audit_log ADD COLUMN org_id TEXT;
        UPDATE audit_log SET org_id = 'campos-demo';
    END IF;
END $$;
CREATE INDEX IF NOT EXISTS audit_log_org_idx ON audit_log (org_id, id DESC);

-- Semillas de desarrollo/pruebas (docs/architecture.md 11.3) ----------------------------------------------
-- Planta demo: se añaden capacityM3 a los tanques existentes sin pisar un valor ya editado.
UPDATE assets
   SET metadata = metadata || '{"capacityM3": 60}'::jsonb
 WHERE plant = 'demo' AND id IN ('tk-01', 'tk-02', 'tk-03', 'tk-04') AND NOT (metadata ? 'capacityM3');

-- Los activos y reglas nuevos de `demo` sólo se siembran si la planta es de campos-demo (si alguien la
-- reasignó, no se mete nada en un cliente ajeno).
INSERT INTO assets (plant, id, name, type, model3d_ref, metadata)
SELECT v.plant, v.id, v.name, v.type, NULL, v.metadata::jsonb
  FROM (VALUES
    ('demo', 'clima-01',       'Cámara 1',                   'climate',  '{}'),
    ('demo', 'clima-02',       'Depósito de insumos',        'climate',  '{}'),
    ('demo', 'en-linea1',      'Línea de producción 1',      'energy',   '{"contractedKw": 220}'),
    ('demo', 'en-compresores', 'Compresores',                'energy',   '{"contractedKw": 130}'),
    ('demo', 'en-clima',       'Climatización y frío',       'energy',   '{"contractedKw": 118}'),
    ('demo', 'en-calderas',    'Calderas y hornos',          'energy',   '{"contractedKw": 90}'),
    ('demo', 'gas-01',         'Gas natural',                'gas',      '{}'),
    ('demo', 'maq-01',         'Envasadora',                 'machine',  '{}'),
    ('demo', 'maq-02',         'Cinta transportadora',       'machine',  '{}'),
    ('demo', 'maq-03',         'Mezcladora',                 'machine',  '{}'),
    ('demo', 'pres-01',        'Presión de aire comprimido', 'pressure', '{}'),
    ('demo', 'cau-01',         'Agua de proceso',            'flow',     '{}')
  ) AS v(plant, id, name, type, metadata)
 WHERE EXISTS (SELECT 1 FROM plants WHERE id = 'demo' AND org_id = 'campos-demo')
ON CONFLICT (plant, id) DO NOTHING;

-- Cliente de sólo tanques: planta `tanques` con dos tanques.
INSERT INTO plants (id, name, org_id) VALUES ('tanques', 'Planta de tanques', 'cliente-tanques')
ON CONFLICT (id) DO NOTHING;

INSERT INTO assets (plant, id, name, type, model3d_ref, metadata)
SELECT v.plant, v.id, v.name, v.type, NULL, v.metadata::jsonb
  FROM (VALUES
    ('tanques', 'tk-a', 'Agua de proceso', 'tank', '{"capacityM3": 40}'),
    ('tanques', 'tk-b', 'Gasoil',          'tank', '{"capacityM3": 40}')
  ) AS v(plant, id, name, type, metadata)
 WHERE EXISTS (SELECT 1 FROM plants WHERE id = 'tanques' AND org_id = 'cliente-tanques')
ON CONFLICT (plant, id) DO NOTHING;

-- Reglas de ejemplo (ids fijos para que sea idempotente; las reglas tk-* de demo son las de 020_app.sql).
INSERT INTO alarm_rules (id, plant, asset, metric, operator, threshold, severity, for_seconds, hysteresis)
SELECT v.id::uuid, v.plant, v.asset, v.metric, v.operator, v.threshold, v.severity, v.for_seconds, v.hysteresis
  FROM (VALUES
    ('00000000-0000-4000-8000-000000000011', 'demo', 'clima-*',        'temp',     'gt', 30::double precision,  'warning',  10, 1::double precision),
    ('00000000-0000-4000-8000-000000000012', 'demo', 'clima-*',        'humidity', 'gt', 80,                    'warning',  10, 2),
    ('00000000-0000-4000-8000-000000000013', 'demo', 'en-linea1',      'kw',       'gt', 198,                   'warning',  10, 2),
    ('00000000-0000-4000-8000-000000000014', 'demo', 'en-linea1',      'kw',       'gt', 220,                   'critical', 5,  2),
    ('00000000-0000-4000-8000-000000000015', 'demo', 'en-compresores', 'kw',       'gt', 117,                   'warning',  10, 2),
    ('00000000-0000-4000-8000-000000000016', 'demo', 'en-compresores', 'kw',       'gt', 130,                   'critical', 5,  2),
    ('00000000-0000-4000-8000-000000000017', 'demo', 'en-clima',       'kw',       'gt', 106,                   'warning',  10, 2),
    ('00000000-0000-4000-8000-000000000018', 'demo', 'en-clima',       'kw',       'gt', 118,                   'critical', 5,  2),
    ('00000000-0000-4000-8000-000000000019', 'demo', 'en-calderas',    'kw',       'gt', 81,                    'warning',  10, 2),
    ('00000000-0000-4000-8000-00000000001a', 'demo', 'en-calderas',    'kw',       'gt', 90,                    'critical', 5,  2),
    ('00000000-0000-4000-8000-00000000001b', 'demo', 'pres-01',        'pressure', 'gt', 8,                     'critical', 5,  0.2),
    ('00000000-0000-4000-8000-00000000001c', 'demo', 'pres-01',        'pressure', 'lt', 2,                     'warning',  10, 0.2),
    ('00000000-0000-4000-8000-000000000021', 'tanques', 'tk-*',        'level',    'gt', 90,                    'critical', 5,  2),
    ('00000000-0000-4000-8000-000000000022', 'tanques', 'tk-*',        'level',    'lt', 10,                    'warning',  5,  2)
  ) AS v(id, plant, asset, metric, operator, threshold, severity, for_seconds, hysteresis)
 WHERE EXISTS (
        SELECT 1 FROM plants p
         WHERE p.id = v.plant AND p.org_id = CASE v.plant WHEN 'demo' THEN 'campos-demo' ELSE 'cliente-tanques' END)
ON CONFLICT (id) DO NOTHING;

COMMIT;
