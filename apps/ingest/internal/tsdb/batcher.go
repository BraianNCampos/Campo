package tsdb

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"github.com/braianncampos/campo/apps/ingest/internal/metrics"
	"github.com/braianncampos/campo/apps/ingest/internal/parser"
)

type BatcherConfig struct {
	QueueSize     int
	BatchSize     int           // filas; el lote se escribe al alcanzarlo
	FlushInterval time.Duration // o al vencer este intervalo, lo que ocurra primero
	MaxRetries    int           // reintentos tras el primer intento
	RetryBase     time.Duration // backoff inicial, se duplica hasta MaxBackoff
	MaxBackoff    time.Duration
}

// Batcher acumula lecturas y las escribe en lotes. Submit nunca bloquea: si la
// cola está llena (base lenta o caída) descarta y cuenta, para que el
// histórico jamás frene la ruta en vivo.
type Batcher struct {
	cfg BatcherConfig
	w   Writer
	m   *metrics.Metrics
	log *slog.Logger

	in     chan parser.Reading
	mu     sync.RWMutex // protege el cierre de `in` frente a Submit
	closed bool

	runCtx    context.Context
	cancelRun context.CancelFunc
	done      chan struct{}
}

func NewBatcher(w Writer, cfg BatcherConfig, m *metrics.Metrics, log *slog.Logger) *Batcher {
	if cfg.MaxBackoff <= 0 {
		cfg.MaxBackoff = 5 * time.Second
	}
	ctx, cancel := context.WithCancel(context.Background())
	return &Batcher{
		cfg: cfg, w: w, m: m, log: log,
		in:        make(chan parser.Reading, cfg.QueueSize),
		runCtx:    ctx,
		cancelRun: cancel,
		done:      make(chan struct{}),
	}
}

func (b *Batcher) QueueLen() int { return len(b.in) }

func (b *Batcher) Start() { go b.run() }

// Submit encola una lectura sin bloquear. Devuelve false si se descartó.
func (b *Batcher) Submit(r parser.Reading) bool {
	b.mu.RLock()
	defer b.mu.RUnlock()
	if b.closed {
		b.m.RowsDropped.WithLabelValues("shutting_down").Add(float64(len(r.Values)))
		return false
	}
	select {
	case b.in <- r:
		return true
	default:
		b.m.RowsDropped.WithLabelValues("queue_full").Add(float64(len(r.Values)))
		return false
	}
}

// Stop deja de aceptar lecturas, escribe lo pendiente y espera. Si ctx vence
// antes, aborta los reintentos en curso y descarta lo que quede.
func (b *Batcher) Stop(ctx context.Context) {
	b.mu.Lock()
	if !b.closed {
		b.closed = true
		close(b.in)
	}
	b.mu.Unlock()

	select {
	case <-b.done:
	case <-ctx.Done():
		b.cancelRun()
		<-b.done
	}
	b.cancelRun()
}

func (b *Batcher) run() {
	defer close(b.done)
	rows := make([]Row, 0, b.cfg.BatchSize+16)
	ticker := time.NewTicker(b.cfg.FlushInterval)
	defer ticker.Stop()

	for {
		select {
		case r, ok := <-b.in:
			if !ok {
				b.flush(&rows)
				return
			}
			rows = appendRows(rows, r)
			if len(rows) >= b.cfg.BatchSize {
				b.flush(&rows)
			}
		case <-ticker.C:
			b.flush(&rows)
		}
	}
}

func appendRows(rows []Row, r parser.Reading) []Row {
	t := time.UnixMilli(r.TS).UTC()
	for metric, v := range r.Values {
		rows = append(rows, Row{Time: t, Plant: r.Plant, Asset: r.Asset, Metric: metric, Value: v, Quality: int16(r.Quality)})
	}
	return rows
}

// flush escribe el lote con reintentos y backoff exponencial. Mientras
// reintenta no consume la cola, que absorbe el pico hasta llenarse; a partir de
// ahí Submit descarta.
func (b *Batcher) flush(rows *[]Row) {
	batch := *rows
	*rows = batch[:0]
	if len(batch) == 0 {
		return
	}

	backoff := b.cfg.RetryBase
	var err error
	for attempt := 0; ; attempt++ {
		start := time.Now()
		if err = b.w.WriteRows(b.runCtx, batch); err == nil {
			b.m.BatchDuration.Observe(time.Since(start).Seconds())
			b.m.RowsWritten.Add(float64(len(batch)))
			return
		}
		b.m.BatchErrors.Inc()
		b.log.Warn("fallo al escribir lote en TimescaleDB", "rows", len(batch), "attempt", attempt+1, "err", err)

		if attempt >= b.cfg.MaxRetries || b.runCtx.Err() != nil || isPermanent(err) {
			break
		}
		select {
		case <-time.After(backoff):
		case <-b.runCtx.Done():
		}
		backoff = min(backoff*2, b.cfg.MaxBackoff)
	}
	b.m.RowsDropped.WithLabelValues("write_failed").Add(float64(len(batch)))
	b.log.Error("lote descartado", "rows", len(batch), "err", err)
}
