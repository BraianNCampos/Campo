// Package tsdb escribe el histórico de telemetría en TimescaleDB por lotes.
package tsdb

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Row es una fila de la hypertable telemetry (una por métrica).
type Row struct {
	Time    time.Time
	Plant   string
	Asset   string
	Metric  string
	Value   float64
	Quality int16
}

// Writer persiste un lote de filas de forma atómica.
type Writer interface {
	WriteRows(ctx context.Context, rows []Row) error
}

// ErrPermanent marca errores que no se arreglan reintentando (datos rechazados).
var ErrPermanent = errors.New("permanent write error")

var columns = []string{"time", "plant", "asset", "metric", "value", "quality"}

type PGWriter struct {
	pool *pgxpool.Pool
}

// NewPGWriter no abre conexiones: el pool conecta de forma perezosa, así que
// una base caída al arrancar no impide levantar el servicio.
func NewPGWriter(ctx context.Context, url string) (*PGWriter, error) {
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		return nil, err
	}
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, err
	}
	return &PGWriter{pool: pool}, nil
}

func (w *PGWriter) WriteRows(ctx context.Context, rows []Row) error {
	_, err := w.pool.CopyFrom(ctx, pgx.Identifier{"telemetry"}, columns,
		pgx.CopyFromSlice(len(rows), func(i int) ([]any, error) {
			r := &rows[i]
			return []any{r.Time, r.Plant, r.Asset, r.Metric, r.Value, r.Quality}, nil
		}))
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		// Clases 22 (data exception), 23 (integridad) y 42 (sintaxis/esquema): reintentar no ayuda.
		switch pgErr.Code[:2] {
		case "22", "23", "42":
			return errors.Join(ErrPermanent, err)
		}
	}
	return err
}

func (w *PGWriter) Close() { w.pool.Close() }

func isPermanent(err error) bool { return errors.Is(err, ErrPermanent) }
