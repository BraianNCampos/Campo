// Package app ensambla los componentes del servicio y controla su ciclo de vida.
package app

import (
	"context"
	"errors"
	"fmt"
	"log/slog"

	"github.com/redis/go-redis/v9"

	"github.com/braianncampos/campo/apps/ingest/internal/config"
	"github.com/braianncampos/campo/apps/ingest/internal/httpserver"
	"github.com/braianncampos/campo/apps/ingest/internal/metrics"
	"github.com/braianncampos/campo/apps/ingest/internal/mqttin"
	"github.com/braianncampos/campo/apps/ingest/internal/mqttsec"
	"github.com/braianncampos/campo/apps/ingest/internal/pipeline"
	"github.com/braianncampos/campo/apps/ingest/internal/redisout"
	"github.com/braianncampos/campo/apps/ingest/internal/tsdb"
)

type App struct {
	cfg  config.Config
	log  *slog.Logger
	m    *metrics.Metrics
	rdb  *redis.Client
	pg   *tsdb.PGWriter // nil si el writer fue inyectado o no hay histórico
	bat  *tsdb.Batcher  // nil si el histórico está deshabilitado
	pipe *pipeline.Pipeline
	mqtt *mqttin.Client
	http *httpserver.Server
}

type Option func(*options)

type options struct{ history tsdb.Writer }

// WithHistoryWriter reemplaza el destino del histórico (tests); ignora DATABASE_URL.
func WithHistoryWriter(w tsdb.Writer) Option { return func(o *options) { o.history = w } }

// New construye los componentes. Ninguno exige que MQTT, Redis o Postgres
// estén arriba todavía: las conexiones se establecen y reintentan en segundo plano.
func New(ctx context.Context, cfg config.Config, log *slog.Logger, opts ...Option) (*App, error) {
	var o options
	for _, opt := range opts {
		opt(&o)
	}
	a := &App{cfg: cfg, log: log, m: metrics.New()}

	// Fallar pronto (antes de abrir Redis/Postgres) si la configuración TLS de MQTT es inválida.
	if err := mqttsec.Validate(cfg.MQTTBrokerURL, cfg.MQTTCAFile); err != nil {
		return nil, err
	}
	if _, err := mqttsec.TLSConfig(cfg.MQTTCAFile); err != nil {
		return nil, err
	}

	ropts, err := redis.ParseURL(cfg.RedisURL)
	if err != nil {
		return nil, fmt.Errorf("REDIS_URL: %w", err)
	}
	ropts.ReadTimeout, ropts.WriteTimeout = cfg.RedisTimeout, cfg.RedisTimeout
	ropts.MaxRetries = 0 // la capa superior ya descarta y cuenta; no multiplicar la espera
	a.rdb = redis.NewClient(ropts)

	hw := o.history
	if hw == nil && cfg.DatabaseURL != "" {
		a.pg, err = tsdb.NewPGWriter(context.WithoutCancel(ctx), cfg.DatabaseURL)
		if err != nil {
			return nil, fmt.Errorf("DATABASE_URL: %w", err)
		}
		hw = a.pg
	}
	var hist pipeline.HistorySink
	if hw != nil {
		a.bat = tsdb.NewBatcher(hw, tsdb.BatcherConfig{
			QueueSize:     cfg.HistoryQueueSize,
			BatchSize:     cfg.BatchSize,
			FlushInterval: cfg.FlushInterval,
			MaxRetries:    cfg.HistoryRetries,
			RetryBase:     cfg.HistoryRetryBase,
		}, a.m, log)
		a.m.RegisterQueue("history", a.bat.QueueLen)
		hist = a.bat
	} else {
		log.Warn("histórico deshabilitado (DATABASE_URL vacío)")
	}

	a.pipe = pipeline.New(pipeline.Config{
		Workers:      cfg.Workers,
		QueueSize:    cfg.LiveQueueSize,
		RedisTimeout: cfg.RedisTimeout,
	}, redisout.New(a.rdb), hist, a.m, log)
	a.m.RegisterQueue("live", a.pipe.QueueLen)

	a.mqtt, err = mqttin.New(mqttin.Config{
		BrokerURL: cfg.MQTTBrokerURL, Topic: cfg.MQTTTopic, ClientID: cfg.MQTTClientID,
		Username: cfg.MQTTUsername, Password: cfg.MQTTPassword, CAFile: cfg.MQTTCAFile,
		QoS: cfg.MQTTQoS, CleanSession: cfg.MQTTCleanSession,
	}, a.pipe.Submit, log)
	if err != nil {
		return nil, err
	}

	a.http, err = httpserver.New(cfg.HTTPAddr, a.m.Handler(), map[string]httpserver.Check{
		"mqtt":  func(context.Context) error { return a.mqtt.Ready() },
		"redis": func(ctx context.Context) error { return a.rdb.Ping(ctx).Err() },
	})
	if err != nil {
		return nil, err
	}
	return a, nil
}

// HTTPAddr devuelve la dirección real del servidor HTTP.
func (a *App) HTTPAddr() string { return a.http.Addr() }

// Start arranca workers, batcher, HTTP y la conexión MQTT sin bloquear.
func (a *App) Start() {
	if a.bat != nil {
		a.bat.Start()
	}
	a.pipe.Start()
	go func() {
		if err := a.http.Serve(); err != nil {
			a.log.Error("servidor HTTP terminó", "err", err)
		}
	}()
	a.mqtt.Start()
	a.log.Info("ingest iniciado", "http", a.http.Addr(), "workers", a.cfg.Workers, "topic", a.cfg.MQTTTopic)
}

// Shutdown cierra en orden: deja de recibir (MQTT), vacía la cola en vivo,
// hace flush final del histórico y por último cierra conexiones y HTTP.
func (a *App) Shutdown(ctx context.Context) error {
	a.log.Info("cierre ordenado iniciado")
	var errs []error

	a.mqtt.Stop()
	if !a.pipe.Stop(ctx) {
		errs = append(errs, errors.New("la cola en vivo no se vació a tiempo"))
	}
	if a.bat != nil {
		a.bat.Stop(ctx)
	}
	if err := a.http.Shutdown(ctx); err != nil {
		errs = append(errs, err)
	}
	if err := a.rdb.Close(); err != nil {
		errs = append(errs, err)
	}
	if a.pg != nil {
		a.pg.Close()
	}
	a.log.Info("cierre ordenado completo")
	return errors.Join(errs...)
}
