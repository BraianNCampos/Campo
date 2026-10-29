// Servicio de ingesta de Campo: MQTT -> Redis (en vivo) y TimescaleDB (histórico).
package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"github.com/braianncampos/campo/apps/ingest/internal/app"
	"github.com/braianncampos/campo/apps/ingest/internal/config"
)

func main() {
	cfg, err := config.Load(os.Getenv)
	if err != nil {
		slog.Error("configuración inválida", "err", err)
		os.Exit(2)
	}
	log := newLogger(cfg)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	a, err := app.New(ctx, cfg, log)
	if err != nil {
		log.Error("no se pudo iniciar", "err", err)
		os.Exit(1)
	}
	a.Start()

	<-ctx.Done()
	stop() // una segunda señal vuelve al comportamiento por defecto (terminar)

	sctx, cancel := context.WithTimeout(context.Background(), cfg.ShutdownTimeout)
	defer cancel()
	if err := a.Shutdown(sctx); err != nil {
		log.Error("cierre con errores", "err", err)
		os.Exit(1)
	}
}

func newLogger(cfg config.Config) *slog.Logger {
	var level slog.Level
	if err := level.UnmarshalText([]byte(cfg.LogLevel)); err != nil {
		level = slog.LevelInfo
	}
	opts := &slog.HandlerOptions{Level: level}
	if cfg.LogFormat == "text" {
		return slog.New(slog.NewTextHandler(os.Stderr, opts))
	}
	return slog.New(slog.NewJSONHandler(os.Stderr, opts))
}
