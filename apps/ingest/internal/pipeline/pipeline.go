// Package pipeline conecta el handler MQTT con las rutas de salida:
//
//	Submit (no bloquea) -> cola acotada -> workers -> parse -> histórico (Batcher, no bloquea)
//	                                                         \-> Redis (pipeline)
//
// La ruta en vivo tiene prioridad: el histórico se encola primero y sin
// bloquear, de modo que una base lenta nunca retrasa a Redis, y un Redis caído
// nunca pierde histórico.
package pipeline

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"github.com/braianncampos/campo/apps/ingest/internal/metrics"
	"github.com/braianncampos/campo/apps/ingest/internal/parser"
)

// LiveWriter publica lecturas en la ruta en vivo (Redis).
type LiveWriter interface {
	Write(ctx context.Context, readings []parser.Reading) error
}

// HistorySink recibe lecturas para el histórico; Submit no debe bloquear.
type HistorySink interface {
	Submit(r parser.Reading) bool
}

type Config struct {
	Workers      int
	QueueSize    int
	RedisTimeout time.Duration
	// MaxWriteBatch limita cuántos mensajes un worker agrupa en un solo pipeline de Redis.
	MaxWriteBatch int
}

type message struct {
	topic   string
	payload []byte
	at      time.Time
}

type Pipeline struct {
	cfg  Config
	live LiveWriter
	hist HistorySink // puede ser nil (histórico deshabilitado)
	m    *metrics.Metrics
	log  *slog.Logger

	in     chan message
	mu     sync.RWMutex // protege el cierre de `in` frente a Submit
	closed bool
	wg     sync.WaitGroup
}

func New(cfg Config, live LiveWriter, hist HistorySink, m *metrics.Metrics, log *slog.Logger) *Pipeline {
	if cfg.MaxWriteBatch <= 0 {
		cfg.MaxWriteBatch = 128
	}
	return &Pipeline{cfg: cfg, live: live, hist: hist, m: m, log: log, in: make(chan message, cfg.QueueSize)}
}

func (p *Pipeline) QueueLen() int { return len(p.in) }

func (p *Pipeline) Start() {
	for i := 0; i < p.cfg.Workers; i++ {
		p.wg.Add(1)
		go p.worker()
	}
}

// Submit lo llama el handler MQTT: solo encola. Nunca bloquea; si la cola está
// llena descarta el mensaje y lo cuenta.
func (p *Pipeline) Submit(topic string, payload []byte) {
	p.m.Received.Inc()
	msg := message{topic: topic, payload: payload, at: time.Now()}

	p.mu.RLock()
	defer p.mu.RUnlock()
	if p.closed {
		p.m.Dropped.WithLabelValues(string(parser.ReasonShuttingDown)).Inc()
		return
	}
	select {
	case p.in <- msg:
	default:
		p.m.Dropped.WithLabelValues(string(parser.ReasonLiveQueue)).Inc()
	}
}

// Stop cierra la entrada y espera a que los workers vacíen la cola. Si ctx
// vence antes devuelve false (los workers siguen su curso en segundo plano).
func (p *Pipeline) Stop(ctx context.Context) bool {
	p.mu.Lock()
	if !p.closed {
		p.closed = true
		close(p.in)
	}
	p.mu.Unlock()

	done := make(chan struct{})
	go func() { p.wg.Wait(); close(done) }()
	select {
	case <-done:
		return true
	case <-ctx.Done():
		return false
	}
}

func (p *Pipeline) worker() {
	defer p.wg.Done()
	msgs := make([]message, 0, p.cfg.MaxWriteBatch)
	readings := make([]parser.Reading, 0, p.cfg.MaxWriteBatch)
	ats := make([]time.Time, 0, p.cfg.MaxWriteBatch)

	for first := range p.in {
		msgs = append(msgs[:0], first)
	drain:
		for len(msgs) < p.cfg.MaxWriteBatch {
			select {
			case m, ok := <-p.in:
				if !ok {
					break drain
				}
				msgs = append(msgs, m)
			default:
				break drain
			}
		}

		readings, ats = readings[:0], ats[:0]
		for _, m := range msgs {
			r, reason := parser.Parse(m.topic, m.payload, m.at)
			if reason != parser.ReasonNone {
				p.m.Dropped.WithLabelValues(string(reason)).Inc()
				continue
			}
			if r.Discarded > 0 {
				p.m.ValuesDiscarded.Add(float64(r.Discarded))
			}
			if p.hist != nil {
				p.hist.Submit(r)
			}
			readings = append(readings, r)
			ats = append(ats, m.at)
		}
		if len(readings) > 0 {
			p.writeLive(readings, ats)
		}
	}
}

func (p *Pipeline) writeLive(readings []parser.Reading, ats []time.Time) {
	ctx, cancel := context.WithTimeout(context.Background(), p.cfg.RedisTimeout)
	defer cancel()
	if err := p.live.Write(ctx, readings); err != nil {
		p.m.RedisErrors.Inc()
		p.log.Warn("fallo al escribir en Redis", "readings", len(readings), "err", err)
		return
	}
	now := time.Now()
	for _, at := range ats {
		p.m.RedisLatency.Observe(now.Sub(at).Seconds())
	}
}
