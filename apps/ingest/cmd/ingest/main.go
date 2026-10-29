// Servicio de ingesta de Campo: MQTT -> Redis (en vivo) y TimescaleDB (histórico).
package main

import (
	"context"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/braianncampos/campo/apps/ingest/internal/app"
	"github.com/braianncampos/campo/apps/ingest/internal/config"
)

func main() {
	// `ingest healthcheck`: sonda para HEALTHCHECK de Docker (la imagen distroless no trae curl/wget).
	if len(os.Args) > 1 && os.Args[1] == "healthcheck" {
		os.Exit(healthcheck(os.Getenv("HTTP_ADDR")))
	}
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

// healthcheck consulta /readyz en el propio proceso (loopback). Devuelve el código de salida.
func healthcheck(httpAddr string) int {
	if httpAddr == "" {
		httpAddr = ":8080"
	}
	host, port, err := net.SplitHostPort(httpAddr)
	if err != nil {
		return 2
	}
	if host == "" || host == "0.0.0.0" || host == "::" || strings.HasPrefix(host, "[") {
		host = "127.0.0.1"
	}
	c := http.Client{Timeout: 3 * time.Second}
	resp, err := c.Get("http://" + net.JoinHostPort(host, port) + "/readyz")
	if err != nil {
		return 1
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return 1
	}
	return 0
}
