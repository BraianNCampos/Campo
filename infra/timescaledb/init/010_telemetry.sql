-- Histórico de telemetría (una fila por métrica). Ejecutado al crear el volumen por primera vez.
CREATE EXTENSION IF NOT EXISTS timescaledb;

CREATE TABLE IF NOT EXISTS telemetry (
    time     TIMESTAMPTZ      NOT NULL,
    plant    TEXT             NOT NULL,
    asset    TEXT             NOT NULL,
    metric   TEXT             NOT NULL,
    value    DOUBLE PRECISION NOT NULL,
    quality  SMALLINT         NOT NULL DEFAULT 0   -- 0=good 1=uncertain 2=bad
);

SELECT create_hypertable('telemetry', 'time', chunk_time_interval => INTERVAL '1 day', if_not_exists => TRUE);

CREATE INDEX IF NOT EXISTS telemetry_series_idx ON telemetry (plant, asset, metric, time DESC);

-- Compresión de datos con más de 7 días, retención de 2 años.
ALTER TABLE telemetry SET (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'plant, asset, metric',
    timescaledb.compress_orderby   = 'time DESC'
);
SELECT add_compression_policy('telemetry', INTERVAL '7 days', if_not_exists => TRUE);
SELECT add_retention_policy('telemetry', INTERVAL '2 years', if_not_exists => TRUE);

-- Agregado continuo de 1 minuto para curvas históricas rápidas.
CREATE MATERIALIZED VIEW IF NOT EXISTS telemetry_1m
WITH (timescaledb.continuous) AS
SELECT time_bucket('1 minute', time) AS bucket,
       plant, asset, metric,
       avg(value) AS avg, min(value) AS min, max(value) AS max, count(*) AS samples
FROM telemetry
GROUP BY bucket, plant, asset, metric
WITH NO DATA;

SELECT add_continuous_aggregate_policy('telemetry_1m',
    start_offset => INTERVAL '2 hours',
    end_offset   => INTERVAL '1 minute',
    schedule_interval => INTERVAL '1 minute',
    if_not_exists => TRUE);
