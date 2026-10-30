-- Modelos 3D (GLB) por planta (docs/architecture.md, 10.2). Idempotente: se puede aplicar varias veces.
-- Requiere 020_app.sql (users) ya aplicado. Los scripts de init sólo corren al crear el volumen:
-- en bases existentes aplicar a mano ANTES de arrancar la versión nueva de la API (ver apps/api/README.md).
--
-- gen_random_uuid() es nativo desde PostgreSQL 13 (la imagen timescale/timescaledb:*-pg16 y el PG16
-- del sistema lo incluyen); 020_app.sql ya depende de él, así que no hace falta pgcrypto.

CREATE TABLE IF NOT EXISTS asset_models (
    id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    plant      TEXT        NOT NULL CHECK (plant ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
    name       TEXT        NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
    size       INTEGER     NOT NULL CHECK (size BETWEEN 1 AND 10485760),            -- 10 MiB (arquitectura 10.2)
    sha256     TEXT        NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    data       BYTEA       NOT NULL,
    created_by UUID        REFERENCES users (id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (octet_length(data) = size),
    -- Deduplicación por contenido dentro de la planta (la API devuelve el existente).
    UNIQUE (plant, sha256)
);
-- plant sin FK a propósito: una planta puede existir sólo por su estado en Redis o por sus activos.
CREATE INDEX IF NOT EXISTS asset_models_plant_idx ON asset_models (plant, created_at DESC);
