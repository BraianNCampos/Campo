-- Alarmas ISA-18.2 y desviación (docs/architecture.md, 12). Idempotente: se puede aplicar varias veces, también
-- sobre una base que ya tiene reglas y alarmas de fases anteriores.
-- Requiere 020 a 060 ya aplicados (orden lexicográfico en init/). Los scripts de init sólo corren al crear el
-- volumen: en bases existentes aplicar a mano ANTES de arrancar la versión nueva de la API (ver apps/api/README.md).
-- Todo se hace en una transacción: o se aplica entero o no se aplica nada.

BEGIN;

-- Reglas: tipo, ROC, retardo de retorno, supresión por estado y racionalización -----------------------------------
ALTER TABLE alarm_rules
    ADD COLUMN IF NOT EXISTS kind                 TEXT,
    ADD COLUMN IF NOT EXISTS roc_window_seconds   INTEGER NOT NULL DEFAULT 60,
    ADD COLUMN IF NOT EXISTS roc_direction        TEXT    NOT NULL DEFAULT 'any',
    ADD COLUMN IF NOT EXISTS off_delay_seconds    INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS suppress_when        JSONB,
    ADD COLUMN IF NOT EXISTS description          TEXT,
    ADD COLUMN IF NOT EXISTS consequence          TEXT,
    ADD COLUMN IF NOT EXISTS response             TEXT,
    ADD COLUMN IF NOT EXISTS out_of_service_reason TEXT;

-- kind por defecto derivado de operador + severidad (gt/gte+critical=HH, gt/gte+warning=HI, lt/lte+critical=LL,
-- lt/lte+warning=LO). Un trigger lo aplica a cualquier INSERT sin kind, de modo que los scripts antiguos
-- (020/060, que no lo conocen) siguen funcionando al reaplicarse después de esta migración.
CREATE OR REPLACE FUNCTION alarm_rules_default_kind() RETURNS trigger AS $$
BEGIN
    IF NEW.kind IS NULL THEN
        NEW.kind := CASE
            WHEN NEW.operator IN ('gt', 'gte') AND NEW.severity = 'critical' THEN 'HH'
            WHEN NEW.operator IN ('gt', 'gte') THEN 'HI'
            WHEN NEW.severity = 'critical' THEN 'LL'
            ELSE 'LO'
        END;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS alarm_rules_default_kind_trg ON alarm_rules;
CREATE TRIGGER alarm_rules_default_kind_trg
    BEFORE INSERT OR UPDATE ON alarm_rules
    FOR EACH ROW EXECUTE FUNCTION alarm_rules_default_kind();

-- Backfill de las reglas existentes (el UPDATE dispara el trigger, que rellena kind).
UPDATE alarm_rules SET kind = NULL WHERE kind IS NULL;
ALTER TABLE alarm_rules ALTER COLUMN kind SET NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'alarm_rules'::regclass AND conname = 'alarm_rules_kind_check') THEN
        ALTER TABLE alarm_rules ADD CONSTRAINT alarm_rules_kind_check
            CHECK (kind IN ('HH', 'HI', 'LO', 'LL', 'DEV', 'ROC'));
    END IF;
    -- HH/HI con gt|gte, LO/LL con lt|lte; DEV y ROC comparan una magnitud absoluta con gt|gte.
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'alarm_rules'::regclass AND conname = 'alarm_rules_kind_operator_check') THEN
        ALTER TABLE alarm_rules ADD CONSTRAINT alarm_rules_kind_operator_check CHECK (
            (kind IN ('HH', 'HI', 'DEV', 'ROC') AND operator IN ('gt', 'gte'))
            OR (kind IN ('LO', 'LL') AND operator IN ('lt', 'lte')));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'alarm_rules'::regclass AND conname = 'alarm_rules_roc_window_check') THEN
        ALTER TABLE alarm_rules ADD CONSTRAINT alarm_rules_roc_window_check
            CHECK (roc_window_seconds BETWEEN 10 AND 600);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'alarm_rules'::regclass AND conname = 'alarm_rules_roc_direction_check') THEN
        ALTER TABLE alarm_rules ADD CONSTRAINT alarm_rules_roc_direction_check
            CHECK (roc_direction IN ('any', 'rise', 'fall'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'alarm_rules'::regclass AND conname = 'alarm_rules_off_delay_check') THEN
        ALTER TABLE alarm_rules ADD CONSTRAINT alarm_rules_off_delay_check
            CHECK (off_delay_seconds BETWEEN 0 AND 86400);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'alarm_rules'::regclass AND conname = 'alarm_rules_suppress_check') THEN
        ALTER TABLE alarm_rules ADD CONSTRAINT alarm_rules_suppress_check
            CHECK (suppress_when IS NULL OR jsonb_typeof(suppress_when) = 'object');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'alarm_rules'::regclass AND conname = 'alarm_rules_text_check') THEN
        ALTER TABLE alarm_rules ADD CONSTRAINT alarm_rules_text_check CHECK (
            (description IS NULL OR length(description) <= 200)
            AND (consequence IS NULL OR length(consequence) <= 300)
            AND (response IS NULL OR length(response) <= 300)
            AND (out_of_service_reason IS NULL OR length(out_of_service_reason) BETWEEN 3 AND 300));
    END IF;
END $$;

-- Alarmas: ciclo de vida, postergación y retorno a normal -------------------------------------------------------
-- El backfill de `lifecycle` se hace UNA sola vez (al crear la columna): reaplicar la migración no debe pisar
-- estados reales (postergadas, normalizadas sin reconocer). active+sin ack -> unacked, active+ack -> acked,
-- cleared -> closed.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = current_schema() AND table_name = 'alarms' AND column_name = 'lifecycle') THEN
        ALTER TABLE alarms ADD COLUMN lifecycle TEXT NOT NULL DEFAULT 'unacked';
        UPDATE alarms SET lifecycle = CASE
            WHEN state = 'cleared' THEN 'closed'
            WHEN acked_at IS NOT NULL THEN 'acked'
            ELSE 'unacked' END;
    END IF;
END $$;

ALTER TABLE alarms
    ADD COLUMN IF NOT EXISTS kind           TEXT,
    ADD COLUMN IF NOT EXISTS shelved_until  TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS shelved_by     UUID REFERENCES users (id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS shelved_reason TEXT,
    ADD COLUMN IF NOT EXISTS rtn_at         TIMESTAMPTZ;

-- Alarmas anteriores: kind de la regla si todavía existe; si no, aproximado por severidad (HH/HI: no se conserva
-- el operador de una regla borrada). rtn_at = cleared_at.
UPDATE alarms a SET kind = COALESCE(
        (SELECT r.kind FROM alarm_rules r WHERE r.id = a.rule_id),
        CASE a.severity WHEN 'critical' THEN 'HH' ELSE 'HI' END)
 WHERE a.kind IS NULL;
UPDATE alarms SET rtn_at = cleared_at WHERE rtn_at IS NULL AND cleared_at IS NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'alarms'::regclass AND conname = 'alarms_lifecycle_check') THEN
        -- Invariante: activa = unacked|acked|shelved; normalizada = rtn_unacked|closed.
        ALTER TABLE alarms ADD CONSTRAINT alarms_lifecycle_check CHECK (
            (state = 'active' AND lifecycle IN ('unacked', 'acked', 'shelved'))
            OR (state = 'cleared' AND lifecycle IN ('rtn_unacked', 'closed')));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'alarms'::regclass AND conname = 'alarms_kind_check') THEN
        ALTER TABLE alarms ADD CONSTRAINT alarms_kind_check
            CHECK (kind IS NULL OR kind IN ('HH', 'HI', 'LO', 'LL', 'DEV', 'ROC'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'alarms'::regclass AND conname = 'alarms_shelved_check') THEN
        ALTER TABLE alarms ADD CONSTRAINT alarms_shelved_check
            CHECK ((lifecycle = 'shelved') = (shelved_until IS NOT NULL));
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS alarms_plant_lifecycle_idx ON alarms (plant, lifecycle, triggered_at DESC);
CREATE INDEX IF NOT EXISTS alarms_shelved_idx ON alarms (shelved_until) WHERE lifecycle = 'shelved';

-- Diario de alarmas ------------------------------------------------------------------------------------------------
-- Una fila por evento del ciclo de vida. `alarm_id` es NULL sólo en las supresiones (la alarma suprimida no se
-- genera): esas filas llevan plant/rule_id/asset/metric para poder contarse. `user_id` NULL = lo hizo el sistema
-- (activación, normalización, vencimiento de una postergación).
CREATE TABLE IF NOT EXISTS alarm_events (
    id       BIGSERIAL        PRIMARY KEY,
    alarm_id UUID             REFERENCES alarms (id) ON DELETE CASCADE,
    plant    TEXT             NOT NULL,
    rule_id  UUID,
    asset    TEXT,
    metric   TEXT,
    ts       TIMESTAMPTZ      NOT NULL DEFAULT now(),
    type     TEXT             NOT NULL CHECK (type IN ('activate', 'ack', 'rtn', 'shelve', 'unshelve', 'suppress', 'close')),
    user_id  UUID             REFERENCES users (id) ON DELETE SET NULL,
    value    DOUBLE PRECISION,
    note     TEXT             CHECK (note IS NULL OR length(note) <= 300),
    CHECK (alarm_id IS NOT NULL OR type = 'suppress')
);
CREATE INDEX IF NOT EXISTS alarm_events_alarm_idx ON alarm_events (alarm_id, ts, id);
CREATE INDEX IF NOT EXISTS alarm_events_plant_type_idx ON alarm_events (plant, type, ts DESC);

-- Política de alarmas por planta -------------------------------------------------------------------------------------
ALTER TABLE plants
    ADD COLUMN IF NOT EXISTS alarm_policy JSONB NOT NULL
        DEFAULT '{"ratePerDay": 150, "peak10min": 10, "staleHours": 24}'::jsonb;

-- Setpoints de ejemplo (docs/architecture.md 12.4) ----------------------------------------------------------------------
-- Se fusionan en metadata.setpoints sin pisar un valor ya editado ni el resto de metadata. Sólo si la planta es
-- del cliente esperado (si alguien la reasignó, no se toca un cliente ajeno).
UPDATE assets a
   SET metadata = a.metadata || jsonb_build_object(
           'setpoints', jsonb_build_object(s.metric, s.sp) || CASE
               WHEN jsonb_typeof(a.metadata -> 'setpoints') = 'object' THEN a.metadata -> 'setpoints'
               ELSE '{}'::jsonb END)
  FROM (VALUES
        ('demo',    'tk-%',    'level',    60::double precision),
        ('demo',    'clima-%', 'temp',     20),
        ('demo',    'pres-01', 'pressure', 6),
        ('tanques', 'tk-%',    'level',    60)
       ) AS s(plant, id_like, metric, sp)
 WHERE a.plant = s.plant AND a.id LIKE s.id_like
   AND NOT (CASE WHEN jsonb_typeof(a.metadata -> 'setpoints') = 'object' THEN a.metadata -> 'setpoints' ELSE '{}'::jsonb END ? s.metric)
   AND EXISTS (SELECT 1 FROM plants p
                WHERE p.id = a.plant
                  AND p.org_id = CASE a.plant WHEN 'demo' THEN 'campos-demo' ELSE 'cliente-tanques' END);

-- Reglas de ejemplo de los tipos nuevos (ids fijos: idempotente) ----------------------------------------------------------
--   DEV: nivel de tk-01 a más de 25 puntos de su setpoint (60 %) durante 30 s.
--   ROC: nivel de los tanques de `tanques` cambiando más de 8 %/min (ventana de 60 s, cualquier sentido).
INSERT INTO alarm_rules (id, plant, asset, metric, operator, threshold, severity, for_seconds, hysteresis,
                         kind, roc_window_seconds, roc_direction, off_delay_seconds, description, consequence, response)
SELECT v.id::uuid, v.plant, v.asset, v.metric, 'gt', v.threshold, 'warning', v.for_seconds, v.hysteresis,
       v.kind, v.roc_window, 'any', v.off_delay, v.description, v.consequence, v.response
  FROM (VALUES
    ('00000000-0000-4000-8000-000000000031', 'demo', 'tk-01', 'level', 25::double precision, 30, 2::double precision,
     'DEV', 60, 10,
     'Nivel del tanque 01 desviado del setpoint',
     'El tanque se aparta del nivel de trabajo: riesgo de rebalse o de falta de producto.',
     'Revisar el llenado/vaciado en curso y las válvulas del tanque; confirmar el setpoint con producción.'),
    ('00000000-0000-4000-8000-000000000032', 'tanques', 'tk-*', 'level', 8::double precision, 0, 1::double precision,
     'ROC', 60, 0,
     'Variación rápida del nivel',
     'Posible fuga, rotura o llenado descontrolado.',
     'Verificar el tanque en campo y cerrar la válvula de entrada o salida si corresponde.')
  ) AS v(id, plant, asset, metric, threshold, for_seconds, hysteresis, kind, roc_window, off_delay,
         description, consequence, response)
 WHERE EXISTS (
        SELECT 1 FROM plants p
         WHERE p.id = v.plant AND p.org_id = CASE v.plant WHEN 'demo' THEN 'campos-demo' ELSE 'cliente-tanques' END)
ON CONFLICT (id) DO NOTHING;

COMMIT;
