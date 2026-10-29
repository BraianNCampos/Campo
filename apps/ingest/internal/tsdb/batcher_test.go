package tsdb

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus/testutil"

	"github.com/braianncampos/campo/apps/ingest/internal/metrics"
	"github.com/braianncampos/campo/apps/ingest/internal/parser"
)

var quiet = slog.New(slog.NewTextHandler(io.Discard, nil))

// fakeWriter registra los lotes y permite simular fallos o bloqueos.
type fakeWriter struct {
	mu       sync.Mutex
	batches  [][]Row
	attempts atomic.Int32
	failN    int32         // falla los primeros failN intentos
	failErr  error         // error a devolver (default: genérico)
	gate     chan struct{} // si no es nil, WriteRows espera a que se cierre
	written  chan int      // recibe el tamaño de cada lote exitoso
}

func newFakeWriter() *fakeWriter { return &fakeWriter{written: make(chan int, 1024)} }

func (f *fakeWriter) WriteRows(ctx context.Context, rows []Row) error {
	n := f.attempts.Add(1)
	if f.gate != nil {
		select {
		case <-f.gate:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	if n <= f.failN || f.failN < 0 {
		if f.failErr != nil {
			return f.failErr
		}
		return errors.New("db caída")
	}
	f.mu.Lock()
	f.batches = append(f.batches, append([]Row(nil), rows...))
	f.mu.Unlock()
	f.written <- len(rows)
	return nil
}

func (f *fakeWriter) totalRows() (n int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, b := range f.batches {
		n += len(b)
	}
	return
}

func reading(asset string, metrics ...string) parser.Reading {
	v := make(map[string]float64, len(metrics))
	for i, m := range metrics {
		v[m] = float64(i)
	}
	return parser.Reading{Plant: "demo", Asset: asset, TS: 1730213000000, Values: v, Quality: parser.Uncertain}
}

func waitRows(t *testing.T, f *fakeWriter, want int) {
	t.Helper()
	timeout := time.After(3 * time.Second)
	for {
		select {
		case <-f.written:
			if f.totalRows() >= want {
				return
			}
		case <-timeout:
			t.Fatalf("timeout: filas escritas %d, esperadas %d", f.totalRows(), want)
		}
	}
}

func newBatcher(w Writer, cfg BatcherConfig) (*Batcher, *metrics.Metrics) {
	if cfg.QueueSize == 0 {
		cfg.QueueSize = 100
	}
	if cfg.RetryBase == 0 {
		cfg.RetryBase = time.Millisecond
	}
	m := metrics.New()
	b := NewBatcher(w, cfg, m, quiet)
	b.Start()
	return b, m
}

func TestBatcherFlushBySize(t *testing.T) {
	w := newFakeWriter()
	b, m := newBatcher(w, BatcherConfig{BatchSize: 6, FlushInterval: time.Hour})
	defer b.Stop(context.Background())

	for i := 0; i < 3; i++ { // 3 lecturas x 2 métricas = 6 filas
		b.Submit(reading("tk-01", "level", "temp"))
	}
	waitRows(t, w, 6)

	w.mu.Lock()
	defer w.mu.Unlock()
	if len(w.batches) != 1 || len(w.batches[0]) != 6 {
		t.Fatalf("lotes = %d, quería 1 de 6 filas", len(w.batches))
	}
	row := w.batches[0][0]
	if row.Plant != "demo" || row.Asset != "tk-01" || row.Quality != int16(parser.Uncertain) ||
		!row.Time.Equal(time.UnixMilli(1730213000000)) {
		t.Errorf("fila inesperada: %+v", row)
	}
	if got := testutil.ToFloat64(m.RowsWritten); got != 6 {
		t.Errorf("rows_written = %v", got)
	}
}

func TestBatcherFlushByInterval(t *testing.T) {
	w := newFakeWriter()
	b, _ := newBatcher(w, BatcherConfig{BatchSize: 1000, FlushInterval: 20 * time.Millisecond})
	defer b.Stop(context.Background())

	b.Submit(reading("tk-01", "level"))
	waitRows(t, w, 1)
}

func TestBatcherRetriesThenSucceeds(t *testing.T) {
	w := newFakeWriter()
	w.failN = 2
	b, m := newBatcher(w, BatcherConfig{BatchSize: 1, FlushInterval: time.Hour, MaxRetries: 5})
	defer b.Stop(context.Background())

	b.Submit(reading("tk-01", "level"))
	waitRows(t, w, 1)

	if got := w.attempts.Load(); got != 3 {
		t.Errorf("intentos = %d, quería 3", got)
	}
	if got := testutil.ToFloat64(m.BatchErrors); got != 2 {
		t.Errorf("batch_errors = %v, quería 2", got)
	}
	if got := testutil.ToFloat64(m.RowsDropped.WithLabelValues("write_failed")); got != 0 {
		t.Errorf("no debía descartar filas, descartó %v", got)
	}
}

func TestBatcherDropsAfterMaxRetries(t *testing.T) {
	w := newFakeWriter()
	w.failN = -1 // siempre falla
	b, m := newBatcher(w, BatcherConfig{BatchSize: 1, FlushInterval: time.Hour, MaxRetries: 2})
	b.Submit(reading("tk-01", "level", "temp"))
	b.Stop(context.Background())

	if got := w.attempts.Load(); got != 3 {
		t.Errorf("intentos = %d, quería 1 + 2 reintentos", got)
	}
	if got := testutil.ToFloat64(m.RowsDropped.WithLabelValues("write_failed")); got != 2 {
		t.Errorf("filas descartadas = %v, quería 2", got)
	}
}

func TestBatcherPermanentErrorIsNotRetried(t *testing.T) {
	w := newFakeWriter()
	w.failN, w.failErr = -1, errors.Join(ErrPermanent, errors.New("violación de constraint"))
	b, m := newBatcher(w, BatcherConfig{BatchSize: 1, FlushInterval: time.Hour, MaxRetries: 5})
	b.Submit(reading("tk-01", "level"))
	b.Stop(context.Background())

	if got := w.attempts.Load(); got != 1 {
		t.Errorf("intentos = %d, quería 1", got)
	}
	if got := testutil.ToFloat64(m.RowsDropped.WithLabelValues("write_failed")); got != 1 {
		t.Errorf("filas descartadas = %v", got)
	}
}

func TestBatcherDropsWhenQueueFullWithoutBlocking(t *testing.T) {
	w := newFakeWriter()
	w.gate = make(chan struct{}) // la "base" no responde
	b, m := newBatcher(w, BatcherConfig{QueueSize: 2, BatchSize: 1, FlushInterval: time.Hour})

	// Espera a que el batcher tome la primera lectura y quede bloqueado escribiendo.
	b.Submit(reading("a", "m"))
	for w.attempts.Load() == 0 {
		time.Sleep(time.Millisecond)
	}

	start := time.Now()
	accepted := 0
	for i := 0; i < 50; i++ {
		if b.Submit(reading("a", "m1", "m2")) {
			accepted++
		}
	}
	if d := time.Since(start); d > 500*time.Millisecond {
		t.Errorf("Submit bloqueó %v", d)
	}
	if accepted != 2 {
		t.Errorf("aceptadas = %d, quería 2 (tamaño de la cola)", accepted)
	}
	if got := testutil.ToFloat64(m.RowsDropped.WithLabelValues("queue_full")); got != 48*2 {
		t.Errorf("filas descartadas = %v, quería %d", got, 48*2)
	}

	close(w.gate) // la base se recupera: lo aceptado se escribe, nada más
	b.Stop(context.Background())
	if got := w.totalRows(); got != 1+2*2 {
		t.Errorf("filas escritas = %d, quería 5", got)
	}
}

func TestBatcherStopFlushesPending(t *testing.T) {
	w := newFakeWriter()
	b, _ := newBatcher(w, BatcherConfig{BatchSize: 1000, FlushInterval: time.Hour})
	for i := 0; i < 10; i++ {
		b.Submit(reading("a", "m"))
	}
	b.Stop(context.Background())

	if got := w.totalRows(); got != 10 {
		t.Fatalf("filas escritas = %d, quería 10", got)
	}
	if b.Submit(reading("a", "m")) {
		t.Error("Submit tras Stop debía rechazar")
	}
}

func TestBatcherStopDeadlineAbortsRetries(t *testing.T) {
	w := newFakeWriter()
	w.failN = -1
	b, m := newBatcher(w, BatcherConfig{BatchSize: 1, FlushInterval: time.Hour, MaxRetries: 100, RetryBase: time.Hour, MaxBackoff: time.Hour})
	b.Submit(reading("a", "m"))
	for w.attempts.Load() == 0 {
		time.Sleep(time.Millisecond)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	done := make(chan struct{})
	go func() { b.Stop(ctx); close(done) }()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("Stop no respetó el plazo")
	}
	if got := testutil.ToFloat64(m.RowsDropped.WithLabelValues("write_failed")); got != 1 {
		t.Errorf("filas descartadas = %v, quería 1", got)
	}
}
