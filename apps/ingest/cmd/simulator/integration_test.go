package main

import (
	"context"
	"io"
	"log/slog"
	"net"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	mqtt "github.com/eclipse/paho.mqtt.golang"
	mochi "github.com/mochi-mqtt/server/v2"
	"github.com/mochi-mqtt/server/v2/hooks/auth"
	"github.com/mochi-mqtt/server/v2/listeners"
	"github.com/mochi-mqtt/server/v2/packets"

	"github.com/braianncampos/campo/apps/ingest/internal/parser"
)

func quietLogger() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

// authHook replica la política de §8.2: usuarios con contraseña; `ingest` sólo lee y cada
// planta (usuario = id de planta) sólo publica en campo/v1/{usuario}/+/telemetry.
// Anota qué usuarios se autenticaron.
type authHook struct {
	mochi.HookBase
	users map[string]string
	mu    sync.Mutex
	seen  map[string]bool
}

func (h *authHook) ID() string { return "sim-test-auth" }
func (h *authHook) Provides(b byte) bool {
	return b == mochi.OnConnectAuthenticate || b == mochi.OnACLCheck
}

func (h *authHook) OnConnectAuthenticate(cl *mochi.Client, pk packets.Packet) bool {
	user := string(cl.Properties.Username)
	pw, ok := h.users[user]
	ok = ok && pw == string(pk.Connect.Password)
	if ok {
		h.mu.Lock()
		h.seen[user] = true
		h.mu.Unlock()
	}
	return ok
}

func (h *authHook) OnACLCheck(cl *mochi.Client, topic string, write bool) bool {
	user := string(cl.Properties.Username)
	if user == "ingest" {
		return !write
	}
	return write && strings.HasPrefix(topic, "campo/v1/"+user+"/") && strings.HasSuffix(topic, "/telemetry") &&
		strings.Count(topic, "/") == 4
}

func (h *authHook) authenticated() []string {
	h.mu.Lock()
	defer h.mu.Unlock()
	var out []string
	for u := range h.seen {
		out = append(out, u)
	}
	sort.Strings(out)
	return out
}

func startBroker(t *testing.T, hook mochi.Hook) (url string) {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := l.Addr().String()
	l.Close()
	s := mochi.New(&mochi.Options{Logger: quietLogger()})
	if err := s.AddHook(hook, nil); err != nil {
		t.Fatal(err)
	}
	if err := s.AddListener(listeners.NewTCP(listeners.Config{ID: "t", Address: addr})); err != nil {
		t.Fatal(err)
	}
	go s.Serve()
	t.Cleanup(func() { s.Close() })
	return "tcp://" + addr
}

// collector se suscribe a campo/v1/+/+/telemetry y pasa cada mensaje por el parser de la ingesta.
type collector struct {
	mu       sync.Mutex
	last     map[string]parser.Reading // "planta/activo" -> última lectura válida
	dropped  []parser.Reason
	badTopic int
}

func subscribe(t *testing.T, broker, user, pass string) *collector {
	t.Helper()
	c := &collector{last: map[string]parser.Reading{}}
	opts := mqtt.NewClientOptions().AddBroker(broker).SetClientID("collector-" + t.Name()).SetCleanSession(true)
	if user != "" {
		opts.SetUsername(user).SetPassword(pass)
	}
	cl := mqtt.NewClient(opts)
	if tok := cl.Connect(); !tok.WaitTimeout(5*time.Second) || tok.Error() != nil {
		t.Fatalf("collector no conecta: %v", tok.Error())
	}
	t.Cleanup(func() { cl.Disconnect(100) })
	tok := cl.Subscribe("campo/v1/+/+/telemetry", 0, func(_ mqtt.Client, m mqtt.Message) {
		r, reason := parser.Parse(m.Topic(), m.Payload(), time.Now())
		c.mu.Lock()
		defer c.mu.Unlock()
		if reason != parser.ReasonNone {
			c.dropped = append(c.dropped, reason)
			return
		}
		if m.Topic() != "campo/v1/"+r.Plant+"/"+r.Asset+"/telemetry" {
			c.badTopic++
		}
		c.last[r.Plant+"/"+r.Asset] = r
	})
	if !tok.WaitTimeout(5*time.Second) || tok.Error() != nil {
		t.Fatalf("suscripción: %v", tok.Error())
	}
	return c
}

func (c *collector) keys() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make([]string, 0, len(c.last))
	for k := range c.last {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func expectedKeys() []string {
	var out []string
	for plant, as := range wantAssets {
		for _, a := range as {
			out = append(out, plant+"/"+a)
		}
	}
	sort.Strings(out)
	return out
}

// startSim lanza run() y devuelve una función que la detiene y espera a que termine.
func startSim(t *testing.T, o options) (stop func()) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- run(ctx, o, quietLogger()) }()
	var once sync.Once
	stop = func() {
		once.Do(func() {
			cancel()
			select {
			case err := <-done:
				if err != nil {
					t.Errorf("run: %v", err)
				}
			case <-time.After(10 * time.Second):
				t.Error("el simulador no se detuvo")
			}
		})
	}
	t.Cleanup(stop)
	return stop
}

func simOptions(t *testing.T, broker, passwords string) options {
	t.Helper()
	o := options{broker: broker, passwords: passwords, tanks: 4, pumps: 2, valves: 2,
		rate: 50, conns: 1, excursion: 5 * time.Minute, seed: 7, statsEvery: time.Hour}
	if err := o.resolve("demo,tanques", "", func(string) string { return "" }); err != nil {
		t.Fatal(err)
	}
	return o
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timeout esperando %s", what)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func checkCollected(t *testing.T, c *collector) {
	t.Helper()
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.dropped) != 0 || c.badTopic != 0 {
		t.Errorf("el parser de la ingesta descartó mensajes: %v (tópicos incoherentes: %d)", c.dropped, c.badTopic)
	}
	for key, r := range c.last {
		_, asset, _ := strings.Cut(key, "/")
		var got []string
		for m, v := range r.Values {
			got = append(got, m)
			if !finite(v) {
				t.Errorf("%s: %s no finito", key, m)
			}
		}
		sort.Strings(got)
		if !equalStrings(got, wantMetrics[asset]) {
			t.Errorf("%s: métricas %v, se esperaban %v", key, got, wantMetrics[asset])
		}
		if r.Discarded != 0 {
			t.Errorf("%s: %d valores descartados", key, r.Discarded)
		}
	}
}

func TestIntegrationBothPlantsPublishParsableTelemetry(t *testing.T) {
	broker := startBroker(t, new(auth.AllowHook))
	col := subscribe(t, broker, "", "")
	stop := startSim(t, simOptions(t, broker, ""))

	want := expectedKeys()
	waitFor(t, "telemetría de todos los activos de ambas plantas", func() bool { return equalStrings(col.keys(), want) })
	stop()
	checkCollected(t, col)
}

func TestIntegrationEachPlantUsesItsOwnCredentials(t *testing.T) {
	hook := &authHook{users: map[string]string{"ingest": "pi", "demo": "pd", "tanques": "pt"}, seen: map[string]bool{}}
	broker := startBroker(t, hook)
	col := subscribe(t, broker, "ingest", "pi")
	stop := startSim(t, simOptions(t, broker, "demo=pd,tanques=pt"))

	// El ACL sólo deja pasar a campo/v1/{usuario}/...: si una planta publicara con las
	// credenciales de la otra, sus mensajes no llegarían y este wait vencería.
	want := expectedKeys()
	waitFor(t, "telemetría de ambas plantas con ACL por usuario", func() bool { return equalStrings(col.keys(), want) })
	stop()
	checkCollected(t, col)
	if got := hook.authenticated(); !equalStrings(got, []string{"demo", "ingest", "tanques"}) {
		t.Errorf("usuarios autenticados %v, se esperaban demo, ingest y tanques (una conexión por planta)", got)
	}
}

func TestIntegrationWrongPasswordPublishesNothing(t *testing.T) {
	hook := &authHook{users: map[string]string{"ingest": "pi", "demo": "pd", "tanques": "pt"}, seen: map[string]bool{}}
	broker := startBroker(t, hook)
	col := subscribe(t, broker, "ingest", "pi")

	o := simOptions(t, broker, "demo=pd,tanques=pt")
	o.creds["tanques"] = credential{username: "tanques", password: "mala"} // el broker la rechaza
	ctx, cancel := context.WithTimeout(context.Background(), 1500*time.Millisecond)
	defer cancel()
	// run espera a que conecten TODAS las plantas antes de publicar: con una rechazada no sale nada.
	if err := run(ctx, o, quietLogger()); err != nil {
		t.Fatal(err)
	}
	if k := col.keys(); len(k) != 0 {
		t.Errorf("no debía publicarse nada con una credencial rechazada, llegó %v", k)
	}
}
