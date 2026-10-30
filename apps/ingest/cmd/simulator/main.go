// Simulador de telemetría de Campo 2.0 (§11.3 de docs/architecture.md).
//
// Publica en campo/v1/{plant}/{asset}/telemetry. Plantas (-plants, por defecto demo,tanques):
//
//	demo     tk-01..04 (tank), pump-01..02 (pump), valve-01..02 (valve), clima-01..02 (climate),
//	         en-linea1, en-compresores, en-clima, en-calderas (energy), gas-01 (gas),
//	         maq-01..03 (machine), pres-01 (pressure), cau-01 (flow)
//	tanques  tk-a, tk-b (tank)
//	otra     (-plant <id>, compatibilidad) sólo tk/pump/valve escalables con -tanks/-pumps/-valves
//
// Cada activo emite a -rate Hz con ruido y dinámica propia. De vez en cuando provoca
// excursiones que cruzan umbrales típicos de alarma:
//
//	level  > 90 ó < 10     temp > 35 (tanques)     current > 18     position > 95     pressure > 8
//
// Carga: p. ej. 5000 msg/s = -plants demo -tanks 2000 -pumps 2000 -valves 1000 -rate 1 -conns 4
package main

import (
	"context"
	"encoding/json"
	"errors"
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

	"github.com/braianncampos/campo/apps/ingest/internal/mqttsec"
)

type options struct {
	broker     string
	username   string // -username: usuario MQTT cuando hay una sola planta
	password   string // nunca se registra; preferir MQTT_PASSWORD a -password (los flags se ven en `ps`)
	passwords  string // "planta=contraseña,..." (crudo); preferir MQTT_SIM_PASSWORDS
	caFile     string // CA propia para verificar el broker TLS
	plants     []string
	creds      map[string]credential // resuelto por planta (ver resolveCredentials)
	tanks      int
	pumps      int
	valves     int
	rate       float64
	conns      int // conexiones MQTT por planta
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
	var plantsFlag, plantFlag string
	str := func(s string) (string, error) { return s, nil }
	flag.StringVar(&o.broker, "broker", envOr("MQTT_BROKER_URL", "tcp://localhost:1883", str), "URL del broker MQTT (env MQTT_BROKER_URL)")
	flag.StringVar(&o.username, "username", envOr("MQTT_USERNAME", "", str), "usuario MQTT con UNA sola planta; en el broker seguro = id de planta (env MQTT_USERNAME)")
	// Los valores por defecto de las contraseñas NO se pasan a flag (aparecerían en -h); se leen del entorno tras Parse.
	flag.StringVar(&o.password, "password", "", "contraseña MQTT con UNA sola planta (mejor por env MQTT_PASSWORD: los argumentos son visibles en `ps`)")
	flag.StringVar(&o.passwords, "passwords", "", "contraseñas por planta, p. ej. demo=xxx,tanques=yyy (mejor por env MQTT_SIM_PASSWORDS); cada planta publica con su usuario = su id")
	flag.StringVar(&o.caFile, "ca-file", envOr("MQTT_CA_FILE", "", str), "CA (PEM) con la que verificar el broker ssl:// (env MQTT_CA_FILE)")
	flag.StringVar(&plantsFlag, "plants", "", "plantas a simular, separadas por comas (env SIM_PLANTS; por defecto "+defaultPlants+")")
	flag.StringVar(&plantFlag, "plant", "", "alias de -plants para una sola planta (env SIM_PLANT); -plants manda sobre -plant y un flag sobre el entorno")
	flag.IntVar(&o.tanks, "tanks", envOr("SIM_TANKS", 4, strconv.Atoi), "cantidad de tanques tk-NN de la planta demo (env SIM_TANKS)")
	flag.IntVar(&o.pumps, "pumps", envOr("SIM_PUMPS", 2, strconv.Atoi), "cantidad de bombas pump-NN de la planta demo (env SIM_PUMPS)")
	flag.IntVar(&o.valves, "valves", envOr("SIM_VALVES", 2, strconv.Atoi), "cantidad de válvulas valve-NN de la planta demo (env SIM_VALVES)")
	flag.Float64Var(&o.rate, "rate", envOr("SIM_RATE_HZ", 1.0, func(s string) (float64, error) { return strconv.ParseFloat(s, 64) }), "mensajes por segundo por activo (env SIM_RATE_HZ)")
	flag.IntVar(&o.conns, "conns", envOr("SIM_CONNS", 1, strconv.Atoi), "conexiones MQTT en paralelo por planta (env SIM_CONNS)")
	flag.IntVar(&o.qos, "qos", envOr("SIM_QOS", 0, strconv.Atoi), "QoS de publicación 0|1|2 (env SIM_QOS)")
	flag.DurationVar(&o.duration, "duration", envOr("SIM_DURATION", 0, time.ParseDuration), "duración; 0 = hasta SIGINT (env SIM_DURATION)")
	flag.DurationVar(&o.excursion, "excursion-every", envOr("SIM_EXCURSION_EVERY", 5*time.Minute, time.ParseDuration), "media entre excursiones por activo; 0 las desactiva (env SIM_EXCURSION_EVERY)")
	flag.Uint64Var(&o.seed, "seed", uint64(time.Now().UnixNano()), "semilla del generador aleatorio")
	flag.DurationVar(&o.statsEvery, "stats", 5*time.Second, "intervalo del resumen de throughput")
	flag.Parse()

	if err := o.resolve(plantsFlag, plantFlag, os.Getenv); err != nil {
		fmt.Fprintln(os.Stderr, "parámetros inválidos:", err)
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
	if err := run(ctx, o, log); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(2)
	}
}

// resolve completa y valida las opciones tras flag.Parse: plantas, credenciales por planta
// y coherencia general. getenv se inyecta para poder probarlo.
func (o *options) resolve(plantsFlag, plantFlag string, getenv func(string) string) error {
	if o.rate <= 0 || o.conns < 1 || o.qos < 0 || o.qos > 2 || o.tanks < 0 || o.pumps < 0 || o.valves < 0 {
		return errors.New("rate>0, conns>=1, qos 0..2 y cantidades >= 0")
	}
	plants, err := parsePlants(pickPlants(plantsFlag, plantFlag, getenv("SIM_PLANTS"), getenv("SIM_PLANT")))
	if err != nil {
		return err
	}
	o.plants = plants
	if o.password == "" {
		o.password = getenv("MQTT_PASSWORD")
	}
	raw := o.passwords
	if raw == "" {
		raw = getenv("MQTT_SIM_PASSWORDS")
	}
	passwords, err := parsePasswords(raw)
	if err != nil {
		return err
	}
	if o.creds, err = resolveCredentials(plants, o.username, o.password, passwords); err != nil {
		return err
	}
	if err := mqttsec.Validate(o.broker, o.caFile); err != nil {
		return err
	}
	for _, p := range plants {
		if len(buildAssets(p, o.profile(time.Now()))) == 0 {
			return fmt.Errorf("la planta %q no tendría ningún activo (-tanks/-pumps/-valves)", p)
		}
	}
	return nil
}

func (o options) profile(start time.Time) profile {
	return profile{seed: o.seed, meanExc: o.excursion.Seconds(), start: start, tanks: o.tanks, pumps: o.pumps, valves: o.valves}
}

type payload struct {
	TS      int64              `json:"ts"`
	Values  map[string]float64 `json:"values"`
	Quality string             `json:"quality"`
}

// clientOptions construye las opciones paho de una conexión con las credenciales de UNA planta
// y TLS (TLS >= 1.2, verificación siempre activa; con -ca-file sólo se confía en esa CA).
func clientOptions(o options, cred credential, clientID string) (*mqtt.ClientOptions, error) {
	tlsCfg, err := mqttsec.TLSConfig(o.caFile)
	if err != nil {
		return nil, err
	}
	return mqtt.NewClientOptions().
		AddBroker(o.broker).
		SetClientID(clientID).
		SetUsername(cred.username).
		SetPassword(cred.password).
		SetTLSConfig(tlsCfg).
		SetAutoReconnect(true).
		SetConnectRetry(true).
		SetConnectRetryInterval(2 * time.Second).
		SetCleanSession(true), nil
}

// publisher es un activo ligado a la conexión de su planta.
type publisher struct {
	plant  string
	asset  asset
	client mqtt.Client
}

// run conecta una o varias conexiones por planta (cada una con SUS credenciales), publica
// hasta que ctx termine y devuelve error sólo por configuración inválida.
func run(ctx context.Context, o options, log *slog.Logger) error {
	start := time.Now()
	var clients []mqtt.Client
	var pubs []publisher
	for _, plant := range o.plants {
		cred, ok := o.creds[plant]
		if !ok { // resolve() lo garantiza; esto evita publicar nunca con credenciales ajenas
			return fmt.Errorf("sin credenciales resueltas para la planta %q", plant)
		}
		if mqttsec.WarnCleartextCreds(o.broker, cred.username) {
			log.Warn("credenciales MQTT enviadas SIN TLS; usa ssl://host:8883", "broker", mqttsec.Redact(o.broker), "plant", plant)
		}
		pc := make([]mqtt.Client, o.conns)
		for i := range pc {
			opts, err := clientOptions(o, cred, fmt.Sprintf("campo-sim-%d-%d-%s-%d", os.Getpid(), time.Now().UnixMilli()%100000, plant, i))
			if err != nil {
				return fmt.Errorf("configuración TLS inválida: %w", err)
			}
			pc[i] = mqtt.NewClient(opts)
			pc[i].Connect()
		}
		clients = append(clients, pc...)
		for i, a := range buildAssets(plant, o.profile(start)) {
			pubs = append(pubs, publisher{plant: plant, asset: a, client: pc[i%len(pc)]})
		}
	}
	defer func() {
		for _, c := range clients {
			c.Disconnect(500)
		}
	}()

	waitStart := time.Now()
	warned := false
	for _, c := range clients {
		for !c.IsConnectionOpen() {
			select {
			case <-ctx.Done():
				return nil
			case <-time.After(100 * time.Millisecond):
			}
			if !warned && time.Since(waitStart) > 10*time.Second {
				warned = true
				log.Warn("sin conexión con el broker tras 10 s: revisa URL, credenciales (-username/-passwords) y CA (-ca-file)",
					"broker", mqttsec.Redact(o.broker), "plants", o.plants)
			}
		}
	}
	users := make([]string, 0, len(o.plants))
	for _, p := range o.plants {
		users = append(users, o.creds[p].username)
	}
	log.Info("simulador iniciado", "plants", o.plants, "usernames", users, "tls", mqttsec.IsTLSURL(o.broker), "assets", len(pubs),
		"rate_hz", o.rate, "conns", len(clients), "target_msg_per_s", float64(len(pubs))*o.rate)

	var sent, failed atomic.Int64
	period := time.Duration(float64(time.Second) / o.rate)
	var wg sync.WaitGroup
	for i, p := range pubs {
		wg.Add(1)
		go func() {
			defer wg.Done()
			topic := fmt.Sprintf("campo/v1/%s/%s/telemetry", p.plant, p.asset.id)
			rng := rand.New(rand.NewPCG(o.seed^0x9e3779b97f4a7c15, uint64(i)))

			// Fase aleatoria para repartir la carga dentro del periodo.
			select {
			case <-ctx.Done():
				return
			case <-time.After(time.Duration(rng.Float64() * float64(period))):
			}
			tick := time.NewTicker(period)
			defer tick.Stop()
			last := time.Now().Add(-period)
			for {
				quality := "good"
				switch r := rng.Float64(); {
				case r < 0.001:
					quality = "bad"
				case r < 0.003:
					quality = "uncertain"
				}
				now := time.Now()
				// dt real (acotado) para que los contadores integren el tiempo transcurrido
				// aunque algún tick se pierda por un publish lento.
				dt := math.Min(now.Sub(last).Seconds(), 10*period.Seconds())
				last = now
				body, _ := json.Marshal(payload{TS: now.UnixMilli(), Values: p.asset.model.step(dt), Quality: quality})

				tok := p.client.Publish(topic, byte(o.qos), false, body)
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
	log.Info("simulador detenido", "sent", sent.Load(), "failed", failed.Load())
	return nil
}
