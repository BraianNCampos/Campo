// Package metrics define las métricas Prometheus del servicio.
package metrics

import (
	"net/http"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

type Metrics struct {
	Registry *prometheus.Registry

	Received        prometheus.Counter
	Dropped         *prometheus.CounterVec // mensajes descartados, por razón
	ValuesDiscarded prometheus.Counter     // valores individuales no numéricos
	RedisLatency    prometheus.Histogram   // recepción MQTT -> escrito en Redis
	RedisErrors     prometheus.Counter
	RowsWritten     prometheus.Counter
	RowsDropped     *prometheus.CounterVec // filas históricas perdidas, por razón
	BatchErrors     prometheus.Counter     // intentos de COPY fallidos
	BatchDuration   prometheus.Histogram
}

func New() *Metrics {
	reg := prometheus.NewRegistry()
	reg.MustRegister(collectors.NewGoCollector(), collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}))

	m := &Metrics{
		Registry: reg,
		Received: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "ingest_messages_received_total", Help: "Mensajes MQTT recibidos.",
		}),
		Dropped: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "ingest_dropped_total", Help: "Mensajes descartados, por razón.",
		}, []string{"reason"}),
		ValuesDiscarded: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "ingest_values_discarded_total", Help: "Valores no numéricos o no finitos descartados dentro de mensajes válidos.",
		}),
		RedisLatency: prometheus.NewHistogram(prometheus.HistogramOpts{
			Name: "ingest_redis_latency_seconds", Help: "Latencia desde la recepción MQTT hasta la escritura en Redis.",
			Buckets: []float64{.0005, .001, .0025, .005, .01, .025, .05, .1, .25, .5, 1, 2.5},
		}),
		RedisErrors: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "ingest_redis_errors_total", Help: "Lotes que fallaron al escribir en Redis.",
		}),
		RowsWritten: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "ingest_rows_written_total", Help: "Filas escritas en TimescaleDB.",
		}),
		RowsDropped: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "ingest_history_rows_dropped_total", Help: "Filas históricas perdidas, por razón.",
		}, []string{"reason"}),
		BatchErrors: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "ingest_batch_errors_total", Help: "Intentos fallidos de escritura de lotes en TimescaleDB.",
		}),
		BatchDuration: prometheus.NewHistogram(prometheus.HistogramOpts{
			Name: "ingest_batch_write_seconds", Help: "Duración de escrituras exitosas de lotes.",
			Buckets: prometheus.ExponentialBuckets(0.005, 2, 12),
		}),
	}
	reg.MustRegister(m.Received, m.Dropped, m.ValuesDiscarded, m.RedisLatency, m.RedisErrors,
		m.RowsWritten, m.RowsDropped, m.BatchErrors, m.BatchDuration)
	return m
}

// RegisterQueue expone la longitud de una cola como ingest_queue_length{queue=name}.
func (m *Metrics) RegisterQueue(name string, length func() int) {
	m.Registry.MustRegister(prometheus.NewGaugeFunc(prometheus.GaugeOpts{
		Name: "ingest_queue_length", Help: "Elementos pendientes en la cola.",
		ConstLabels: prometheus.Labels{"queue": name},
	}, func() float64 { return float64(length()) }))
}

func (m *Metrics) Handler() http.Handler {
	return promhttp.HandlerFor(m.Registry, promhttp.HandlerOpts{})
}
