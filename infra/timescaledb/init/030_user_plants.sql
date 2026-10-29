-- Autorización por planta (docs/architecture.md, 8.1). Idempotente.
-- El rol 'admin' accede a todas las plantas sin filas aquí; el resto sólo a las asignadas.
-- Sin asignaciones = sin acceso. Los scripts de init sólo corren al crear el volumen:
-- en bases existentes aplicar a mano (ver apps/api/README.md).
CREATE TABLE IF NOT EXISTS user_plants (
    user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    plant   TEXT NOT NULL CHECK (plant ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
    PRIMARY KEY (user_id, plant)
);
CREATE INDEX IF NOT EXISTS user_plants_plant_idx ON user_plants (plant);
