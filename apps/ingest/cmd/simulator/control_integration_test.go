package main

import (
	"encoding/json"
	"fmt"
	"math"
	"sync"
	"testing"
	"time"

	mqtt "github.com/eclipse/paho.mqtt.golang"
)

// apiClient hace de la API: publica órdenes en campo/v1/{planta}/{activo}/cmd y reúne los acks.
type apiClient struct {
	t    *testing.T
	cl   mqtt.Client
	mu   sync.Mutex
	acks map[string][]ackPayload // id -> acks en orden de llegada
}

func newAPIClient(t *testing.T, broker, user, pass string) *apiClient {
	t.Helper()
	a := &apiClient{t: t, acks: map[string][]ackPayload{}}
	opts := mqtt.NewClientOptions().AddBroker(broker).SetClientID("api-" + t.Name()).SetCleanSession(true)
	if user != "" {
		opts.SetUsername(user).SetPassword(pass)
	}
	a.cl = mqtt.NewClient(opts)
	if tok := a.cl.Connect(); !tok.WaitTimeout(5*time.Second) || tok.Error() != nil {
		t.Fatalf("api no conecta: %v", tok.Error())
	}
	t.Cleanup(func() { a.cl.Disconnect(100) })
	tok := a.cl.Subscribe("campo/v1/+/+/cmd/ack", 1, func(_ mqtt.Client, m mqtt.Message) {
		var p ackPayload
		if err := json.Unmarshal(m.Payload(), &p); err != nil {
			t.Errorf("ack inválido %q: %v", m.Payload(), err)
			return
		}
		a.mu.Lock()
		a.acks[p.ID] = append(a.acks[p.ID], p)
		a.mu.Unlock()
	})
	if !tok.WaitTimeout(5*time.Second) || tok.Error() != nil {
		t.Fatalf("api no puede leer cmd/ack: %v", tok.Error())
	}
	return a
}

func (a *apiClient) statuses(id string) []string {
	a.mu.Lock()
	defer a.mu.Unlock()
	var out []string
	for _, p := range a.acks[id] {
		s := p.Status
		if p.Reason != "" {
			s += ":" + p.Reason
		}
		out = append(out, s)
	}
	return out
}

// send publica una orden y la reenvía (mismo id; el simulador ignora duplicados) hasta que llega el primer ack,
// para no depender de que la suscripción del simulador ya esté activa.
func (a *apiClient) send(plant, asset, id, command string, target *float64, ts time.Time) {
	a.t.Helper()
	body := map[string]any{"id": id, "command": command, "ts": ts.UnixMilli(), "by": "test"}
	if target != nil {
		body["target"] = *target
	}
	b, _ := json.Marshal(body)
	topic := fmt.Sprintf("campo/v1/%s/%s/cmd", plant, asset)
	deadline := time.Now().Add(20 * time.Second)
	for len(a.statuses(id)) == 0 {
		if time.Now().After(deadline) {
			a.t.Fatalf("la orden %s a %s no recibió ningún ack", id, topic)
		}
		if tok := a.cl.Publish(topic, 1, false, b); !tok.WaitTimeout(5*time.Second) || tok.Error() != nil {
			a.t.Fatalf("publicar orden: %v", tok.Error())
		}
		time.Sleep(150 * time.Millisecond)
	}
}

func (a *apiClient) waitStatuses(id string, want ...string) {
	a.t.Helper()
	waitFor(a.t, fmt.Sprintf("acks %v de %s", want, id), func() bool { return len(a.statuses(id)) >= len(want) })
	if got := a.statuses(id); !equalStrings(got, want) {
		a.t.Errorf("acks de %s = %v, se esperaba %v", id, got, want)
	}
}

func near(a, b, tol float64) bool { return math.Abs(a-b) <= tol }

// TestIntegrationCommandsEndToEnd: broker con el ACL de §14.4 (usuario api + usuarios de planta), simulador
// con credenciales por planta; publica órdenes como la API y comprueba acks y el efecto real en la telemetría.
func TestIntegrationCommandsEndToEnd(t *testing.T) {
	hook := &authHook{users: map[string]string{"ingest": "pi", "api": "pa", "demo": "pd", "tanques": "pt"}, seen: map[string]bool{}}
	broker := startBroker(t, hook)
	col := subscribe(t, broker, "ingest", "pi")
	api := newAPIClient(t, broker, "api", "pa")
	for _, k := range []string{"demo/tk-01", "demo/silo-01", "demo/pump-01", "demo/valve-01", "tanques/tk-a", "demo/tk-02"} {
		col.track(k)
	}

	o := simOptions(t, broker, "demo=pd,tanques=pt")
	o.cmdSpeed = 20 // 30 %/s en tanques: los llenados del test duran segundos
	startSim(t, o)
	waitFor(t, "telemetría inicial", func() bool { return equalStrings(col.keys(), expectedKeys()) })

	levelOf := func(key string) float64 { r, _ := col.lastOf(key); return r.Values["level"] }
	pick := func(key string) (cmd string, target float64, sts float64) {
		l := levelOf(key)
		if l < 50 {
			return "fill", math.Round(l + 20), 1
		}
		return "drain", math.Round(l - 20), 2
	}

	// Las métricas nuevas viajan con la telemetría de tanques y silos (reposo: sts 0, mode 0, SP = nivel).
	for _, key := range []string{"demo/tk-01", "demo/silo-01", "tanques/tk-a"} {
		r, _ := col.lastOf(key)
		if r.Values["sts"] != 0 || r.Values["mode"] != 0 || !near(r.Values["level_sp"], r.Values["level"], 0.5) {
			t.Errorf("%s en reposo: %v", key, r.Values)
		}
	}

	// Tanque, silo (planta demo) y tk-a (planta tanques): llenar/vaciar de verdad hasta el objetivo.
	for _, c := range []struct{ plant, asset string }{{"demo", "tk-01"}, {"demo", "silo-01"}, {"tanques", "tk-a"}} {
		key, id := c.plant+"/"+c.asset, "ord-"+c.plant+"-"+c.asset
		cmd, target, sts := pick(key)
		before := levelOf(key)
		api.send(c.plant, c.asset, id, cmd, &target, time.Now())
		api.waitStatuses(id, "accepted", "running", "done")
		// Cuando llega "done" el nivel ya está en el objetivo (el ack se publica tras el último paso).
		waitFor(t, key+" en el objetivo", func() bool { return near(levelOf(key), target, 1) })
		if near(before, target, 5) {
			t.Fatalf("%s: el test debía mover el nivel (antes %.1f, objetivo %.1f)", key, before, target)
		}
		var moving bool
		for _, r := range col.history(key) {
			if r.Values["sts"] == sts && r.Values["level_sp"] == target && r.Values["mode"] == 1 {
				moving = true
			}
		}
		if !moving {
			t.Errorf("%s: nunca se vio sts=%v con level_sp=%v y mode=1 en la telemetría", key, sts, target)
		}
		r, _ := col.lastOf(key)
		if r.Values["level_sp"] != target {
			t.Errorf("%s: level_sp = %v tras terminar, se esperaba %v", key, r.Values["level_sp"], target)
		}
	}

	// Orden vieja (>30 s): rechazada como stale y sin efecto.
	staleTarget := math.Min(90, levelOf("demo/tk-02")+25)
	api.send("demo", "tk-02", "old-1", "fill", &staleTarget, time.Now().Add(-45*time.Second))
	api.waitStatuses("old-1", "rejected:stale")
	time.Sleep(300 * time.Millisecond)
	if r, _ := col.lastOf("demo/tk-02"); r.Values["sts"] != 0 || r.Values["mode"] != 0 {
		t.Errorf("la orden stale tuvo efecto: %v", r.Values)
	}

	// Objetivo inválido, comando que no aplica al tipo y cinta (sin control).
	bad := 150.0
	api.send("demo", "tk-02", "bad-1", "fill", &bad, time.Now())
	api.waitStatuses("bad-1", "rejected:invalid_target")
	api.send("demo", "tk-02", "bad-2", "open", nil, time.Now())
	api.waitStatuses("bad-2", "rejected:unsupported_command")
	api.send("demo", "conv-01", "bad-3", "stop", nil, time.Now())
	api.waitStatuses("bad-3", "rejected:unsupported_command")

	// Bomba: stop -> sts 0 y rpm 0; start -> sts 3.
	api.send("demo", "pump-01", "pump-stop", "stop", nil, time.Now())
	api.waitStatuses("pump-stop", "accepted", "running", "done")
	waitFor(t, "bomba parada", func() bool { r, _ := col.lastOf("demo/pump-01"); return r.Values["sts"] == 0 && r.Values["rpm"] == 0 })
	api.send("demo", "pump-01", "pump-start", "start", nil, time.Now())
	api.waitStatuses("pump-start", "accepted", "running", "done")
	waitFor(t, "bomba en marcha", func() bool { r, _ := col.lastOf("demo/pump-01"); return r.Values["sts"] == 3 && r.Values["rpm"] > 1200 })

	// Válvula: set_position.
	pos := 40.0
	api.send("demo", "valve-01", "valve-pos", "set_position", &pos, time.Now())
	api.waitStatuses("valve-pos", "accepted", "running", "done")
	waitFor(t, "válvula en 40 %", func() bool { r, _ := col.lastOf("demo/valve-01"); return near(r.Values["position"], 40, 1) })
}

// El simulador sin permiso para leer cmd (ACL cerrado) no debe caerse: sigue publicando telemetría.
func TestIntegrationCommandsDeniedByACLDoNotBreakTelemetry(t *testing.T) {
	broker := startBroker(t, &authHook{users: map[string]string{"ingest": "pi", "demo": "pd", "tanques": "pt"}, seen: map[string]bool{}})
	col := subscribe(t, broker, "ingest", "pi")
	startSim(t, simOptions(t, broker, "demo=pd,tanques=pt"))
	waitFor(t, "telemetría", func() bool { return equalStrings(col.keys(), expectedKeys()) })
}
