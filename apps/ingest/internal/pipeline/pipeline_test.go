package pipeline

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

const topic = "campo/v1/demo/tk-01/telemetry"

type fakeLive struct {
	mu     sync.Mutex
	got    []parser.Reading
	gate   chan struct{} // si no es nil, Write espera a que se cierre
	err    error
	writes atomic.Int32
}

func (f *fakeLive) Write(ctx context.Context, rs []parser.Reading) error {
	f.writes.Add(1)
	if f.gate != nil {
		select {
		case <-f.gate:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	if f.err != nil {
		return f.err
	}
	f.mu.Lock()
	f.got = append(f.got, rs...)
	f.mu.Unlock()
	return nil
}

func (f *fakeLive) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.got)
}

type fakeHist struct {
	accept bool
	n      atomic.Int32
}

func (h *fakeHist) Submit(parser.Reading) bool { h.n.Add(1); return h.accept }

func newPipe(live LiveWriter, hist HistorySink, cfg Config) (*Pipeline, *metrics.Metrics) {
	if cfg.Workers == 0 {
		cfg.Workers = 2
	}
	if cfg.QueueSize == 0 {
		cfg.QueueSize = 100
	}
	if cfg.RedisTimeout == 0 {
		cfg.RedisTimeout = time.Second
	}
	m := metrics.New()
	p := New(cfg, live, hist, m, quiet)
	p.Start()
	return p, m
}

func stop(t *testing.T, p *Pipeline) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if !p.Stop(ctx) {
		t.Fatal("la cola no se vació a tiempo")
	}
}

func dropped(m *metrics.Metrics, reason parser.Reason) float64 {
	return testutil.ToFloat64(m.Dropped.WithLabelValues(string(reason)))
}

func TestPipelineDropsInvalidByReason(t *testing.T) {
	live, hist := &fakeLive{}, &fakeHist{accept: true}
	p, m := newPipe(live, hist, Config{})

	p.Submit(topic, []byte(`{"values":{"level":1}}`))
	p.Submit("campo/v1/DEMO/x/telemetry", []byte(`{"values":{"level":1}}`))
	p.Submit(topic, []byte(`{no es json`))
	p.Submit(topic, []byte(`{"values":{"a":"x"}}`))
	p.Submit(topic, []byte(`{"values":{"level":1,"b":"x"}}`))
	stop(t, p)

	if got := testutil.ToFloat64(m.Received); got != 5 {
		t.Errorf("received = %v", got)
	}
	if live.count() != 2 || hist.n.Load() != 2 {
		t.Errorf("live=%d hist=%d, quería 2 y 2", live.count(), hist.n.Load())
	}
	for reason, want := range map[parser.Reason]float64{parser.ReasonBadTopic: 1, parser.ReasonBadJSON: 1, parser.ReasonNoValues: 1} {
		if got := dropped(m, reason); got != want {
			t.Errorf("dropped{%s} = %v, quería %v", reason, got, want)
		}
	}
	if got := testutil.ToFloat64(m.ValuesDiscarded); got != 1 {
		t.Errorf("values_discarded = %v", got)
	}
	if testutil.CollectAndCount(m.RedisLatency) == 0 {
		t.Error("falta la métrica de latencia")
	}
}

func TestPipelineSubmitNeverBlocksWhenQueueFull(t *testing.T) {
	live := &fakeLive{gate: make(chan struct{})}
	p, m := newPipe(live, nil, Config{Workers: 1, QueueSize: 3, MaxWriteBatch: 1})

	p.Submit(topic, []byte(`{"values":{"a":1}}`)) // el worker la toma y se bloquea en Redis
	for live.writes.Load() == 0 {
		time.Sleep(time.Millisecond)
	}

	start := time.Now()
	for i := 0; i < 100; i++ {
		p.Submit(topic, []byte(`{"values":{"a":1}}`))
	}
	if d := time.Since(start); d > 500*time.Millisecond {
		t.Errorf("Submit bloqueó %v", d)
	}
	if got := dropped(m, parser.ReasonLiveQueue); got != 97 {
		t.Errorf("live_queue_full = %v, quería 97", got)
	}

	close(live.gate)
	stop(t, p)
	if live.count() != 4 {
		t.Errorf("escritas = %d, quería 4 (1 en vuelo + 3 en cola)", live.count())
	}
}

func TestPipelineFullHistoryDoesNotAffectLivePath(t *testing.T) {
	live, hist := &fakeLive{}, &fakeHist{accept: false} // histórico saturado
	p, _ := newPipe(live, hist, Config{})
	for i := 0; i < 50; i++ {
		p.Submit(topic, []byte(`{"values":{"a":1}}`))
	}
	stop(t, p)
	if live.count() != 50 {
		t.Errorf("la ruta en vivo escribió %d, quería 50", live.count())
	}
}

func TestPipelineRedisFailureStillFeedsHistory(t *testing.T) {
	live, hist := &fakeLive{err: errors.New("redis caído")}, &fakeHist{accept: true}
	p, m := newPipe(live, hist, Config{})
	p.Submit(topic, []byte(`{"values":{"a":1}}`))
	stop(t, p)

	if hist.n.Load() != 1 {
		t.Error("el histórico debía recibir la lectura aunque Redis falle")
	}
	if got := testutil.ToFloat64(m.RedisErrors); got < 1 {
		t.Errorf("redis_errors = %v", got)
	}
}

func TestPipelineStopDrainsQueue(t *testing.T) {
	live := &fakeLive{}
	p, _ := newPipe(live, nil, Config{Workers: 2, QueueSize: 5000})
	for i := 0; i < 5000; i++ {
		p.Submit(topic, []byte(`{"values":{"a":1}}`))
	}
	stop(t, p)
	if live.count() != 5000 {
		t.Fatalf("escritas = %d, quería 5000", live.count())
	}

	p.Submit(topic, []byte(`{"values":{"a":1}}`)) // tras Stop no debe entrar ni entrar en pánico
	if live.count() != 5000 {
		t.Error("se aceptó un mensaje después de Stop")
	}
}

func TestPipelineStopTimeout(t *testing.T) {
	live := &fakeLive{gate: make(chan struct{})}
	p, _ := newPipe(live, nil, Config{Workers: 1, RedisTimeout: time.Minute})
	p.Submit(topic, []byte(`{"values":{"a":1}}`))
	for live.writes.Load() == 0 {
		time.Sleep(time.Millisecond)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if p.Stop(ctx) {
		t.Error("Stop debía reportar que no terminó a tiempo")
	}
	close(live.gate)
}
