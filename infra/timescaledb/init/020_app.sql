-- Tablas de configuración y alarmas del servicio api (NestJS). Idempotente.
-- Se ejecuta tras 010_telemetry.sql al crear el volumen por primera vez.
-- Esquema gestionado aquí (sin synchronize/ORM): cambios futuros = nuevos scripts de migración.

-- Usuarios y roles ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
    id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    email         TEXT        NOT NULL,
    password_hash TEXT        NOT NULL,                       -- bcrypt; jamás la contraseña en claro
    role          TEXT        NOT NULL CHECK (role IN ('admin', 'engineer', 'operator', 'viewer')),
    active        BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_uidx ON users (lower(email));

-- Catálogo de activos ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS assets (
    plant       TEXT        NOT NULL CHECK (plant ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
    id          TEXT        NOT NULL CHECK (id    ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
    name        TEXT        NOT NULL,
    type        TEXT        NOT NULL CHECK (type IN ('tank', 'pump', 'valve', 'sensor')),
    model3d_ref TEXT,                                          -- referencia al modelo 3D (glTF/nodo)
    metadata    JSONB       NOT NULL DEFAULT '{}'::jsonb,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (plant, id)
);

-- Reglas de alarma ------------------------------------------------------------------------------
-- asset: id exacto o patrón con '*' (p. ej. 'tk-*', '*').
CREATE TABLE IF NOT EXISTS alarm_rules (
    id          UUID             PRIMARY KEY DEFAULT gen_random_uuid(),
    plant       TEXT             NOT NULL CHECK (plant ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
    asset       TEXT             NOT NULL DEFAULT '*' CHECK (asset ~ '^[a-z0-9*][a-z0-9_*-]{0,63}$'),
    metric      TEXT             NOT NULL,
    operator    TEXT             NOT NULL CHECK (operator IN ('gt', 'lt', 'gte', 'lte')),
    threshold   DOUBLE PRECISION NOT NULL,
    severity    TEXT             NOT NULL CHECK (severity IN ('warning', 'critical')),
    for_seconds INTEGER          NOT NULL DEFAULT 0 CHECK (for_seconds >= 0),   -- debounce
    hysteresis  DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (hysteresis >= 0),    -- banda muerta
    enabled     BOOLEAN          NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ      NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ      NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS alarm_rules_plant_idx ON alarm_rules (plant) WHERE enabled;

-- Alarmas (ciclo de vida) -----------------------------------------------------------------------
-- rule_id sin FK a propósito: el histórico de alarmas sobrevive al borrado de la regla.
CREATE TABLE IF NOT EXISTS alarms (
    id           UUID             PRIMARY KEY,
    rule_id      UUID             NOT NULL,
    plant        TEXT             NOT NULL,
    asset        TEXT             NOT NULL,
    metric       TEXT             NOT NULL,
    severity     TEXT             NOT NULL CHECK (severity IN ('warning', 'critical')),
    state        TEXT             NOT NULL CHECK (state IN ('active', 'cleared')),
    value        DOUBLE PRECISION NOT NULL,
    threshold    DOUBLE PRECISION NOT NULL,
    message      TEXT             NOT NULL,
    triggered_at TIMESTAMPTZ      NOT NULL,
    cleared_at   TIMESTAMPTZ,
    acked_by     UUID             REFERENCES users (id) ON DELETE SET NULL,
    acked_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS alarms_state_time_idx ON alarms (state, triggered_at DESC);
CREATE INDEX IF NOT EXISTS alarms_plant_time_idx ON alarms (plant, triggered_at DESC);
-- Como mucho una alarma activa por (regla, activo).
CREATE UNIQUE INDEX IF NOT EXISTS alarms_one_active_uidx ON alarms (rule_id, asset) WHERE state = 'active';

-- Seed mínimo: planta 'demo' ------------------------------------------------------------------------
INSERT INTO assets (plant, id, name, type, model3d_ref, metadata) VALUES
    ('demo', 'tk-01',    'Tanque 01', 'tank',  'tank',  '{"capacityL": 10000, "unit": "%"}'),
    ('demo', 'tk-02',    'Tanque 02', 'tank',  'tank',  '{"capacityL": 10000, "unit": "%"}'),
    ('demo', 'tk-03',    'Tanque 03', 'tank',  'tank',  '{"capacityL": 5000, "unit": "%"}'),
    ('demo', 'tk-04',    'Tanque 04', 'tank',  'tank',  '{"capacityL": 5000, "unit": "%"}'),
    ('demo', 'pump-01',  'Bomba 01',  'pump',  'pump',  '{"ratedKw": 7.5}'),
    ('demo', 'pump-02',  'Bomba 02',  'pump',  'pump',  '{"ratedKw": 7.5}'),
    ('demo', 'valve-01', 'Válvula 01', 'valve', 'valve', '{"dn": 80}'),
    ('demo', 'valve-02', 'Válvula 02', 'valve', 'valve', '{"dn": 80}')
ON CONFLICT (plant, id) DO NOTHING;

-- Reglas de ejemplo (ids fijos para que el seed sea idempotente).
INSERT INTO alarm_rules (id, plant, asset, metric, operator, threshold, severity, for_seconds, hysteresis) VALUES
    ('00000000-0000-4000-8000-000000000001', 'demo', 'tk-*', 'level', 'gt', 90, 'critical', 5, 2),
    ('00000000-0000-4000-8000-000000000002', 'demo', 'tk-*', 'level', 'lt', 10, 'warning',  5, 2),
    ('00000000-0000-4000-8000-000000000003', 'demo', 'tk-*', 'temp',  'gt', 35, 'warning', 10, 1)
ON CONFLICT (id) DO NOTHING;
