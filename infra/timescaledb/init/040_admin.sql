-- Administración (docs/architecture.md, 9.1). Idempotente: se puede aplicar varias veces.
-- Requiere 020_app.sql y 030_user_plants.sql ya aplicados (orden lexicográfico en init/).
-- Los scripts de init sólo corren al crear el volumen: en bases existentes aplicar a mano
-- (ver apps/api/README.md) ANTES de arrancar la versión nueva de la API.

-- Plantas ---------------------------------------------------------------------------------------
-- Registro de plantas con nombre visible. Una planta también puede ser "conocida" sólo por sus
-- activos o por el estado vivo en Redis (la API las une en GET /api/plants para el admin).
CREATE TABLE IF NOT EXISTS plants (
    id         TEXT        PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
    name       TEXT        NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Siembra con las plantas ya presentes en assets y user_plants (nombre = id). No pisa nombres editados.
INSERT INTO plants (id, name)
SELECT p, p FROM (
    SELECT plant AS p FROM assets
    UNION
    SELECT plant AS p FROM user_plants
) AS known
ON CONFLICT (id) DO NOTHING;

-- Revocación de tokens ---------------------------------------------------------------------------
-- El JWT lleva `tv`; si no coincide con esta versión la API responde 401. Los tokens emitidos antes
-- del despliegue no llevan `tv` y la API los trata como versión 0 (= el valor por defecto aquí).
ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0;

-- Auditoría ----------------------------------------------------------------------------------------
-- Sólo se inserta y se lee desde la API (sin UPDATE/DELETE). `detail` nunca contiene contraseñas,
-- hashes ni tokens: la API sólo escribe campos de una lista explícita por acción.
-- actor_id sin FK a propósito: el registro sobrevive a cualquier cambio en `users`.
CREATE TABLE IF NOT EXISTS audit_log (
    id          BIGSERIAL   PRIMARY KEY,
    ts          TIMESTAMPTZ NOT NULL DEFAULT now(),
    actor_id    UUID,
    actor_email TEXT,
    action      TEXT        NOT NULL,
    target      TEXT        NOT NULL,
    detail      JSONB       NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS audit_log_actor_idx  ON audit_log (actor_id, id DESC);
CREATE INDEX IF NOT EXISTS audit_log_action_idx ON audit_log (action, id DESC);
