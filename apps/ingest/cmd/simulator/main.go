// Simulador de telemetría para la planta de ejemplo `demo`.
//
// Publica en campo/v1/{plant}/{asset}/telemetry:
//   - tanques  tk-NN:    level (%), temp (°C)
//   - bombas   pump-NN:  rpm, current (A)
//   - válvulas valve-NN: position (%)
//
// Cada activo emite a -rate Hz con ruido y dinámica propia (llenado/vaciado,
// arranques/paros, consignas de válvula). De vez en cuando provoca excursiones
// que cruzan umbrales típicos de alarma:
//
//	level  > 90 ó < 10     temp > 35     current > 18     position > 95
//
// Carga: p. ej. 5000 msg/s = -tanks 2000 -pumps 2000 -valves 1000 -rate 1 -conns 4
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log/slog"
	"math"
	"math/rand/v2"
	"os"
	"os/signal"
	"strconv"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	mqtt "github.com/eclipse/paho.mqtt.golang"
)

type options struct {
	broker     string
	plant      string
	tanks      int
	pumps      int
	valves     int
	rate       float64
	conns      int
	qos        int
	duration   time.Duration
	excursion  time.Duration
	seed       uint64
	statsEvery time.Duration
}

func envOr[T any](key string, def T, parse func(string) (T, error)) T {
	if v := os.Getenv(key); v != "" {
		if p, err := parse(v); err == nil {
			return p
		}
	}
	return def
}

func main() {
	var o options
	str := func(s string) (string, error) { return s, nil }
	flag.StringVar(&o.broker, "broker", envOr("MQTT_BROKER_URL", "tcp://localhost:1883", str), "URL del broker MQTT (env MQTT_BROKER_URL)")
	flag.StringVar(&o.plant, "plant", envOr("SIM_PLANT", "demo", str), "id de planta (env SIM_PLANT)")
	flag.IntVar(&o.tanks, "tanks", envOr("SIM_TANKS", 4, strconv.Atoi), "cantidad de tanques (env SIM_TANKS)")
	flag.IntVar(&o.pumps, "pumps", envOr("SIM_PUMPS", 2, strconv.Atoi), "cantidad de bombas (env SIM_PUMPS)")
	flag.IntVar(&o.valves, "valves", envOr("SIM_VALVES", 2, strconv.Atoi), "cantidad de válvulas (env SIM_VALVES)")
	flag.Float64Var(&o.rate, "rate", envOr("SIM_RATE_HZ", 1.0, func(s string) (float64, error) { return strconv.ParseFloat(s, 64) }), "mensajes por segundo por activo (env SIM_RATE_HZ)")
	flag.IntVar(&o.conns, "conns", envOr("SIM_CONNS", 1, strconv.Atoi), "conexiones MQTT en paralelo (env SIM_CONNS)")
	flag.IntVar(&o.qos, "qos", envOr("SIM_QOS", 0, strconv.Atoi), "QoS de publicación 0|1|2 (env SIM_QOS)")
	flag.DurationVar(&o.duration, "duration", envOr("SIM_DURATION", 0, time.ParseDuration), "duración; 0 = hasta SIGINT (env SIM_DURATION)")
	flag.DurationVar(&o.excursion, "excursion-every", envOr("SIM_EXCURSION_EVERY", 5*time.Minute, time.ParseDuration), "media entre excursiones por activo; 0 las desactiva (env SIM_EXCURSION_EVERY)")
	flag.Uint64Var(&o.seed, "seed", uint64(time.Now().UnixNano()), "semilla del generador aleatorio")
	flag.DurationVar(&o.statsEvery, "stats", 5*time.Second, "intervalo del resumen de throughput")
	flag.Parse()

	if o.rate <= 0 || o.conns < 1 || o.qos < 0 || o.qos > 2 || o.tanks+o.pumps+o.valves < 1 {
		fmt.Fprintln(os.Stderr, "parámetros inválidos: rate>0, conns>=1, qos 0..2 y al menos un activo")
		os.Exit(2)
	}
	log := slog.New(slog.NewTextHandler(os.Stderr, nil))

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if o.duration > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, o.duration)
		defer cancel()
	}
	run(ctx, o, log)
}

type asset struct {
	id   string
	step func(dt float64) map[string]float64
}

func buildAssets(o options) []asset {
	var out []asset
	n := 0
	next := func() *rand.Rand { n++; return rand.New(rand.NewPCG(o.seed, uint64(n))) }
	meanExc := o.excursion.Seconds()
	for i := 1; i <= o.tanks; i++ {
		t := newTank(next(), meanExc)
		out = append(out, asset{fmt.Sprintf("tk-%02d", i), t.step})
	}
	for i := 1; i <= o.pumps; i++ {
		p := newPump(next(), meanExc)
		out = append(out, asset{fmt.Sprintf("pump-%02d", i), p.step})
	}
	for i := 1; i <= o.valves; i++ {
		v := newValve(next(), meanExc)
		out = append(out, asset{fmt.Sprintf("valve-%02d", i), v.step})
	}
	return out
}

type payload struct {
	TS      int64              `json:"ts"`
	Values  map[string]float64 `json:"values"`
	Quality string             `json:"quality"`
}

func run(ctx context.Context, o options, log *slog.Logger) {
	assets := buildAssets(o)
	clients := make([]mqtt.Client, o.conns)
	for i := range clients {
		opts := mqtt.NewClientOptions().
			AddBroker(o.broker).
			SetClientID(fmt.Sprintf("campo-sim-%d-%d-%d", os.Getpid(), time.Now().UnixMilli()%100000, i)).
			SetAutoReconnect(true).
			SetConnectRetry(true).
			SetConnectRetryInterval(2 * time.Second).
			SetCleanSession(true)
		clients[i] = mqtt.NewClient(opts)
		clients[i].Connect()
	}
	for _, c := range clients {
		for !c.IsConnectionOpen() {
			select {
			case <-ctx.Done():
				return
			case <-time.After(100 * time.Millisecond):
			}
		}
	}
	log.Info("simulador iniciado", "plant", o.plant, "assets", len(assets), "rate_hz", o.rate,
		"conns", o.conns, "target_msg_per_s", float64(len(assets))*o.rate)

	var sent, failed atomic.Int64
	period := time.Duration(float64(time.Second) / o.rate)
	var wg sync.WaitGroup
	for i, a := range assets {
		wg.Add(1)
		go func() {
			defer wg.Done()
			client := clients[i%len(clients)]
			topic := fmt.Sprintf("campo/v1/%s/%s/telemetry", o.plant, a.id)
			rng := rand.New(rand.NewPCG(o.seed^0x9e3779b97f4a7c15, uint64(i)))

			// Fase aleatoria para repartir la carga dentro del periodo.
			select {
			case <-ctx.Done():
				return
			case <-time.After(time.Duration(rng.Float64() * float64(period))):
			}
			tick := time.NewTicker(period)
			defer tick.Stop()
			for {
				quality := "good"
				switch r := rng.Float64(); {
				case r < 0.001:
					quality = "bad"
				case r < 0.003:
					quality = "uncertain"
				}
				body, _ := json.Marshal(payload{TS: time.Now().UnixMilli(), Values: a.step(1 / o.rate), Quality: quality})

				tok := client.Publish(topic, byte(o.qos), false, body)
				if !tok.WaitTimeout(5*time.Second) || tok.Error() != nil {
					failed.Add(1)
				} else {
					sent.Add(1)
				}

				select {
				case <-ctx.Done():
					return
				case <-tick.C:
				}
			}
		}()
	}

	go func() {
		t := time.NewTicker(o.statsEvery)
		defer t.Stop()
		var last int64
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				s := sent.Load()
				log.Info("throughput", "msg_per_s", math.Round(float64(s-last)/o.statsEvery.Seconds()), "sent", s, "failed", failed.Load())
				last = s
			}
		}
	}()

	<-ctx.Done()
	wg.Wait()
	for _, c := range clients {
		c.Disconnect(500)
	}
	log.Info("simulador detenido", "sent", sent.Load(), "failed", failed.Load())
}
