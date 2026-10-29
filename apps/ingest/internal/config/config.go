// Package config carga la configuración del servicio desde variables de entorno.
package config

import (
	"fmt"
	"runtime"
	"strconv"
	"time"

	"github.com/braianncampos/campo/apps/ingest/internal/mqttsec"
)

type Config struct {
	MQTTBrokerURL    string
	MQTTTopic        string
	MQTTClientID     string
	MQTTUsername     string
	MQTTPassword     string // nunca se registra en logs
	MQTTCAFile       string // CA propia (PEM) para verificar el broker TLS
	MQTTQoS          byte
	MQTTCleanSession bool

	RedisURL    string
	DatabaseURL string // vacío = histórico deshabilitado

	Workers          int           // workers de la ruta en vivo
	LiveQueueSize    int           // mensajes pendientes antes de descartar
	HistoryQueueSize int           // lecturas pendientes para el batcher
	BatchSize        int           // filas por COPY
	FlushInterval    time.Duration // flush del batcher aunque el lote no esté lleno
	HistoryRetries   int           // reintentos por lote antes de descartarlo
	HistoryRetryBase time.Duration // backoff inicial (se duplica hasta 5 s)
	HistoryTimeout   time.Duration // timeout de cada COPY
	RedisTimeout     time.Duration // timeout de cada lote hacia Redis

	HTTPAddr        string
	ShutdownTimeout time.Duration
	LogLevel        string
	LogFormat       string // json | text
}

// String devuelve la configuración con los secretos ocultos (contraseña MQTT y
// credenciales de las URL de Redis/Postgres/broker), por si se imprime con %v / %+v.
func (c Config) String() string {
	type plain Config // sin métodos: evita recursión
	r := plain(c)
	if r.MQTTPassword != "" {
		r.MQTTPassword = "xxxxx"
	}
	r.MQTTBrokerURL = mqttsec.Redact(r.MQTTBrokerURL)
	r.RedisURL = mqttsec.Redact(r.RedisURL)
	r.DatabaseURL = mqttsec.Redact(r.DatabaseURL)
	return fmt.Sprintf("%+v", r)
}

// Load lee la configuración usando getenv (os.Getenv en producción).
func Load(getenv func(string) string) (Config, error) {
	l := loader{getenv: getenv}
	c := Config{
		MQTTBrokerURL:    l.str("MQTT_BROKER_URL", "tcp://localhost:1883"),
		MQTTTopic:        l.str("MQTT_TOPIC", "campo/v1/+/+/telemetry"),
		MQTTClientID:     l.str("MQTT_CLIENT_ID", "campo-ingest"),
		MQTTUsername:     l.str("MQTT_USERNAME", ""),
		MQTTPassword:     l.str("MQTT_PASSWORD", ""),
		MQTTCAFile:       l.str("MQTT_CA_FILE", ""),
		MQTTQoS:          byte(l.integer("MQTT_QOS", 1)),
		MQTTCleanSession: l.boolean("MQTT_CLEAN_SESSION", false),

		RedisURL:    l.str("REDIS_URL", "redis://localhost:6379/0"),
		DatabaseURL: l.str("DATABASE_URL", "postgres://campo:campo_dev@localhost:5432/campo?sslmode=disable"),

		Workers:          l.integer("INGEST_WORKERS", max(2, runtime.NumCPU()*2)),
		LiveQueueSize:    l.integer("LIVE_QUEUE_SIZE", 50000),
		HistoryQueueSize: l.integer("HISTORY_QUEUE_SIZE", 100000),
		BatchSize:        l.integer("BATCH_SIZE", 5000),
		FlushInterval:    l.duration("FLUSH_INTERVAL", time.Second),
		HistoryRetries:   l.integer("HISTORY_MAX_RETRIES", 10),
		HistoryRetryBase: l.duration("HISTORY_RETRY_BASE", 200*time.Millisecond),
		HistoryTimeout:   l.duration("HISTORY_WRITE_TIMEOUT", 10*time.Second),
		RedisTimeout:     l.duration("REDIS_TIMEOUT", 2*time.Second),

		HTTPAddr:        l.str("HTTP_ADDR", ":8080"),
		ShutdownTimeout: l.duration("SHUTDOWN_TIMEOUT", 20*time.Second),
		LogLevel:        l.str("LOG_LEVEL", "info"),
		LogFormat:       l.str("LOG_FORMAT", "json"),
	}
	if l.err != nil {
		return Config{}, l.err
	}
	return c, c.validate()
}

func (c Config) validate() error {
	switch {
	case c.MQTTQoS > 2:
		return fmt.Errorf("MQTT_QOS debe ser 0, 1 o 2")
	case mqttsec.Validate(c.MQTTBrokerURL, c.MQTTCAFile) != nil:
		return mqttsec.Validate(c.MQTTBrokerURL, c.MQTTCAFile)
	case c.Workers < 1:
		return fmt.Errorf("INGEST_WORKERS debe ser >= 1")
	case c.LiveQueueSize < 1 || c.HistoryQueueSize < 1:
		return fmt.Errorf("los tamaños de cola deben ser >= 1")
	case c.BatchSize < 1:
		return fmt.Errorf("BATCH_SIZE debe ser >= 1")
	case c.FlushInterval <= 0 || c.HistoryTimeout <= 0 || c.RedisTimeout <= 0 || c.HistoryRetryBase <= 0:
		return fmt.Errorf("las duraciones deben ser > 0")
	case c.HistoryRetries < 0:
		return fmt.Errorf("HISTORY_MAX_RETRIES debe ser >= 0")
	case c.LogFormat != "json" && c.LogFormat != "text":
		return fmt.Errorf("LOG_FORMAT debe ser json o text")
	}
	return nil
}

// loader acumula el primer error de parseo para no repetir if err != nil por variable.
type loader struct {
	getenv func(string) string
	err    error
}

func (l *loader) str(key, def string) string {
	if v := l.getenv(key); v != "" {
		return v
	}
	return def
}

func (l *loader) integer(key string, def int) int {
	v := l.getenv(key)
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil && l.err == nil {
		l.err = fmt.Errorf("%s: %q no es un entero", key, v)
	}
	return n
}

func (l *loader) boolean(key string, def bool) bool {
	v := l.getenv(key)
	if v == "" {
		return def
	}
	b, err := strconv.ParseBool(v)
	if err != nil && l.err == nil {
		l.err = fmt.Errorf("%s: %q no es un booleano", key, v)
	}
	return b
}

func (l *loader) duration(key string, def time.Duration) time.Duration {
	v := l.getenv(key)
	if v == "" {
		return def
	}
	d, err := time.ParseDuration(v)
	if err != nil && l.err == nil {
		l.err = fmt.Errorf("%s: %q no es una duración (ej. 500ms, 2s)", key, v)
	}
	return d
}
