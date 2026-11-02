package main

import (
	"encoding/json"
	"fmt"
	"math"
	"testing"
	"time"
)

var t0 = time.Date(2026, 11, 2, 12, 0, 0, 0, time.UTC)

func mkCmd(id, name string, target *float64, ts time.Time) command {
	c := command{ID: id, Command: name, TS: json.RawMessage(fmt.Sprint(ts.UnixMilli())), By: "u1"}
	if target != nil {
		c.Target = json.RawMessage(fmt.Sprint(*target))
	}
	return c
}

func f(v float64) *float64 { return &v }

// statuses resume los acks como "id:status[:reason]".
func statuses(acks []ack) []string {
	out := make([]string, len(acks))
	for i, a := range acks {
		out[i] = a.ID + ":" + a.Status
		if a.Reason != "" {
			out[i] += ":" + a.Reason
		}
	}
	return out
}

func wantAcks(t *testing.T, got []ack, want ...string) {
	t.Helper()
	if g := statuses(got); !equalStrings(g, want) {
		t.Errorf("acks = %v, se esperaba %v", g, want)
	}
}

// run avanza el modelo hasta que cond se cumple o pasan maxSec segundos simulados; devuelve los acks y los segundos.
func runUntil(m model, maxSec float64, cond func() bool) (acks []ack, secs float64) {
	for secs < maxSec && !cond() {
		m.step(0.5)
		secs += 0.5
		acks = append(acks, pendingAcks(m)...)
	}
	return acks, secs
}

func newTestTank() *tank {
	k := newTank(newRNG(1, 1), 0) // sin excursiones
	k.level, k.dir = 40, 1
	return k
}

func TestTankFillMovesLevelToTargetAndAcks(t *testing.T) {
	k := newTestTank()
	wantAcks(t, handleCommand(k, mkCmd("o1", "fill", f(70), t0), t0), "o1:accepted", "o1:running")

	v := k.step(1)
	if v["sts"] != 1 || v["mode"] != 1 || v["level_sp"] != 70 {
		t.Errorf("durante el llenado: sts=%v mode=%v level_sp=%v", v["sts"], v["mode"], v["level_sp"])
	}
	prev := v["level"]
	acks, secs := runUntil(k, 120, func() bool { return k.ord == nil })
	wantAcks(t, acks, "o1:done")
	if math.Abs(k.level-70) > 1e-9 {
		t.Errorf("level = %v, se esperaba 70", k.level)
	}
	if want := 30 / tankFillRate; math.Abs(secs-want) > 2 { // 1 s ya consumido arriba
		t.Errorf("tardó %.1f s, se esperaban ~%.1f s", secs, want)
	}
	if prev <= 40 {
		t.Errorf("el nivel no subió: %v", prev)
	}
	// Quieto en el objetivo con sts=0 y el SP en el objetivo, luego retoma el vaivén.
	v = k.step(1)
	if v["sts"] != 0 || v["level_sp"] != 70 || v["mode"] != 1 || math.Abs(v["level"]-70) > 1 {
		t.Errorf("tras terminar: %v", v)
	}
	for i := 0; i < int(tankHoldAfter)+2; i++ {
		v = k.step(1)
	}
	if v["mode"] != 0 || v["sts"] != 0 || math.Abs(v["level_sp"]-round2(k.level)) > 0.01 {
		t.Errorf("tras el hold debía volver al vaivén autónomo: %v", v)
	}
}

func TestTankDrainStsAndDirection(t *testing.T) {
	k := newTestTank()
	wantAcks(t, handleCommand(k, mkCmd("d1", "drain", f(10), t0), t0), "d1:accepted", "d1:running")
	before := k.level
	v := k.step(1)
	if v["sts"] != 2 || k.level >= before {
		t.Errorf("vaciando: sts=%v level %v -> %v", v["sts"], before, k.level)
	}
	acks, _ := runUntil(k, 120, func() bool { return k.ord == nil })
	wantAcks(t, acks, "d1:done")
	if k.level != 10 {
		t.Errorf("level = %v", k.level)
	}
}

func TestTankRejections(t *testing.T) {
	k := newTestTank()
	cases := []struct {
		name string
		cmd  command
		want string
	}{
		{"fill sin target", mkCmd("a", "fill", nil, t0), "a:rejected:invalid_target"},
		{"fill target 0", mkCmd("b", "fill", f(0), t0), "b:rejected:invalid_target"},
		{"fill target 100", mkCmd("c", "fill", f(100), t0), "c:rejected:invalid_target"},
		{"fill target no numérico", command{ID: "d", Command: "fill", Target: json.RawMessage(`"70"`), TS: json.RawMessage(fmt.Sprint(t0.UnixMilli()))}, "d:rejected:invalid_target"},
		{"fill por debajo del nivel", mkCmd("e", "fill", f(30), t0), "e:rejected:already_at_target"},
		{"drain por encima del nivel", mkCmd("f", "drain", f(60), t0), "f:rejected:already_at_target"},
		{"comando desconocido", mkCmd("g", "explode", nil, t0), "g:rejected:unsupported_command"},
		{"comando de bomba en un tanque", mkCmd("h", "start", nil, t0), "h:rejected:unsupported_command"},
		{"sin comando", mkCmd("i", "", nil, t0), "i:rejected:bad_request"},
		{"sin ts", command{ID: "j", Command: "fill", Target: json.RawMessage("70")}, "j:rejected:bad_request"},
	}
	for _, c := range cases {
		wantAcks(t, handleCommand(k, c.cmd, t0), c.want)
		if k.ord != nil {
			t.Fatalf("%s: no debía iniciar nada", c.name)
		}
	}
	if k.level != 40 {
		t.Errorf("las rechazadas no deben mover el nivel: %v", k.level)
	}
}

func TestStaleCommandsAreRejectedAndHaveNoEffect(t *testing.T) {
	k := newTestTank()
	wantAcks(t, handleCommand(k, mkCmd("old", "fill", f(70), t0.Add(-31*time.Second)), t0), "old:rejected:stale")
	if k.ord != nil {
		t.Fatal("una orden vieja no debe ejecutarse")
	}
	// En el límite (30 s) todavía vale; las futuras (reloj adelantado) también.
	wantAcks(t, handleCommand(k, mkCmd("edge", "fill", f(70), t0.Add(-30*time.Second)), t0), "edge:accepted", "edge:running")
	k2 := newTestTank()
	wantAcks(t, handleCommand(k2, mkCmd("fut", "fill", f(70), t0.Add(5*time.Second)), t0), "fut:accepted", "fut:running")
}

func TestStopAlwaysWorksAndFailsTheRunningOrder(t *testing.T) {
	k := newTestTank()
	handleCommand(k, mkCmd("o1", "fill", f(90), t0), t0)
	for i := 0; i < 4; i++ {
		k.step(1)
	}
	stopped := k.level
	wantAcks(t, handleCommand(k, mkCmd("s1", "stop", nil, t0), t0), "s1:accepted", "s1:running", "o1:failed:stopped", "s1:done")
	for i := 0; i < 10; i++ {
		v := k.step(1)
		if v["sts"] != 0 {
			t.Fatalf("tras stop sts debía ser 0: %v", v)
		}
	}
	if k.level != stopped {
		t.Errorf("el stop no frenó: %v -> %v", stopped, k.level)
	}
	// stop sin nada en curso también se acepta.
	wantAcks(t, handleCommand(k, mkCmd("s2", "stop", nil, t0), t0), "s2:accepted", "s2:running", "s2:done")
	// y se puede ordenar de nuevo enseguida.
	wantAcks(t, handleCommand(k, mkCmd("o2", "drain", f(5), t0), t0), "o2:accepted", "o2:running")
}

func TestBusyAndDuplicateDelivery(t *testing.T) {
	k := newTestTank()
	wantAcks(t, handleCommand(k, mkCmd("o1", "fill", f(70), t0), t0), "o1:accepted", "o1:running")
	wantAcks(t, handleCommand(k, mkCmd("o2", "fill", f(80), t0), t0), "o2:rejected:busy")
	// Reentrega QoS 1 del mismo id: sin acks ni efecto.
	if got := handleCommand(k, mkCmd("o1", "fill", f(70), t0), t0); len(got) != 0 {
		t.Errorf("duplicado respondió %v", statuses(got))
	}
	if k.ord == nil || k.ord.id != "o1" {
		t.Error("el duplicado alteró la orden en curso")
	}
}

func TestSiloIsSlowerThanTank(t *testing.T) {
	tk, sl := newTestTank(), newSilo(newRNG(1, 1), 0)
	sl.level, sl.dir = 40, 1
	handleCommand(tk, mkCmd("a", "fill", f(70), t0), t0)
	handleCommand(sl, mkCmd("a", "fill", f(70), t0), t0)
	_, tTank := runUntil(tk, 600, func() bool { return tk.ord == nil })
	_, tSilo := runUntil(sl, 600, func() bool { return sl.ord == nil })
	if tSilo <= tTank*1.5 {
		t.Errorf("el silo (%.0f s) debía ser bastante más lento que el tanque (%.0f s)", tSilo, tTank)
	}
	// Peor caso razonable para una demo: punta a punta en un par de minutos como mucho.
	if worst := 98 / siloFillRate; worst > 150 {
		t.Errorf("el silo tardaría %.0f s de punta a punta", worst)
	}
}

func TestCmdSpeedScalesFillRate(t *testing.T) {
	fast := newTestTank()
	fast.speed = 10
	handleCommand(fast, mkCmd("a", "fill", f(70), t0), t0)
	_, secs := runUntil(fast, 600, func() bool { return fast.ord == nil })
	if secs > 3.5 {
		t.Errorf("con cmd-speed 10 tardó %.1f s", secs)
	}
	if got := (profile{cmdSpeed: 0}).speed(); got != 1 {
		t.Errorf("cmdSpeed 0 debe valer 1, vale %v", got)
	}
	if k := (profile{seed: 1, cmdSpeed: 7}).newSilo("silo-01"); k.speed != 7 {
		t.Errorf("el perfil no propaga cmd-speed: %v", k.speed)
	}
}

func TestAutonomousTankWithoutOrders(t *testing.T) {
	k := newTestTank()
	for i := 0; i < 300; i++ {
		v := k.step(1)
		if v["sts"] != 0 || v["mode"] != 0 || math.Abs(v["level_sp"]-round2(k.level)) > 0.01 {
			t.Fatalf("sin órdenes el SP sigue al nivel y sts/mode son 0: %v", v)
		}
	}
}

func TestPumpStartStop(t *testing.T) {
	p := newPump(newRNG(2, 2), 0)
	wantAcks(t, handleCommand(p, mkCmd("p1", "stop", nil, t0), t0), "p1:accepted", "p1:running")
	acks, _ := runUntil(p, 60, func() bool { return p.ord == nil })
	wantAcks(t, acks, "p1:done")
	v := p.step(1)
	if v["sts"] != 0 || v["rpm"] != 0 || v["current"] != 0 {
		t.Errorf("bomba parada: %v", v)
	}
	// Una orden a mitad de camino se interrumpe con failed.
	wantAcks(t, handleCommand(p, mkCmd("p2", "start", nil, t0), t0), "p2:accepted", "p2:running")
	p.step(1)
	wantAcks(t, handleCommand(p, mkCmd("p3", "start", nil, t0), t0), "p3:rejected:busy")
	acks, _ = runUntil(p, 60, func() bool { return p.ord == nil })
	wantAcks(t, acks, "p2:done")
	if v := p.step(1); v["sts"] != 3 || v["rpm"] < 1200 {
		t.Errorf("bomba en marcha: %v", v)
	}
	// El start protege de los paros programados (aunque pasen horas simuladas).
	for i := 0; i < int(pumpManualHold)-10; i++ {
		if v := p.step(1); v["sts"] != 3 {
			t.Fatalf("paro programado durante el hold en t=%d", i)
		}
	}
	wantAcks(t, handleCommand(p, mkCmd("p4", "stop", nil, t0), t0), "p4:accepted", "p4:running")
	wantAcks(t, handleCommand(p, mkCmd("p5", "fill", f(50), t0), t0), "p5:rejected:unsupported_command")
	wantAcks(t, handleCommand(p, mkCmd("p6", "stop", nil, t0), t0), "p6:accepted", "p6:running", "p4:failed:stopped")
}

func TestValveCommands(t *testing.T) {
	v := newValve(newRNG(3, 3), 0)
	v.pos, v.setpoint = 20, 20

	wantAcks(t, handleCommand(v, mkCmd("v1", "open", nil, t0), t0), "v1:accepted", "v1:running")
	acks, secs := runUntil(v, 60, func() bool { return v.ord == nil })
	wantAcks(t, acks, "v1:done")
	if v.pos != 100 || secs < 7 || secs > 10 { // 80 % a 10 %/s
		t.Errorf("open: pos=%v en %.1f s", v.pos, secs)
	}
	wantAcks(t, handleCommand(v, mkCmd("v2", "set_position", f(55), t0), t0), "v2:accepted", "v2:running")
	acks, _ = runUntil(v, 60, func() bool { return v.ord == nil })
	wantAcks(t, acks, "v2:done")
	if v.pos != 55 {
		t.Errorf("set_position: %v", v.pos)
	}
	// La consigna manual se mantiene (no vuelve a las aleatorias durante el hold).
	for i := 0; i < int(valveManualHold)-20; i++ {
		if out := v.step(1); math.Abs(out["position"]-55) > 1 {
			t.Fatalf("la válvula se movió sola durante el hold: %v", out)
		}
	}
	wantAcks(t, handleCommand(v, mkCmd("v3", "close", nil, t0), t0), "v3:accepted", "v3:running")
	// stop a mitad de camino la congela y falla la orden.
	for i := 0; i < 2; i++ {
		v.step(1)
	}
	mid := v.pos
	wantAcks(t, handleCommand(v, mkCmd("v4", "stop", nil, t0), t0), "v4:accepted", "v4:running", "v3:failed:stopped", "v4:done")
	v.step(1)
	if math.Abs(v.pos-mid) > 1e-9 || mid <= 0 || mid >= 55 {
		t.Errorf("stop no congeló la válvula: %v (mid %v)", v.pos, mid)
	}
	for _, bad := range []*float64{nil, f(-1), f(101)} {
		wantAcks(t, handleCommand(v, mkCmd(fmt.Sprint("b", bad), "set_position", bad, t0), t0), fmt.Sprint("b", bad)+":rejected:invalid_target")
	}
}

func TestConveyorAndUncontrollableAssetsRejectCommands(t *testing.T) {
	c := newConveyor(newRNG(4, 4), 1, 1200, 240)
	wantAcks(t, handleCommand(c, mkCmd("c1", "start", nil, t0), t0), "c1:rejected:unsupported_command")
	wantAcks(t, handleCommand(newGas(newRNG(1, 1)), mkCmd("c2", "stop", nil, t0), t0), "c2:rejected:unsupported_command")
	if acks := pendingAcks(c); len(acks) != 0 {
		t.Errorf("acks pendientes inesperados: %v", acks)
	}
}

func TestConveyorAndSiloTelemetry(t *testing.T) {
	c := newConveyor(newRNG(4, 4), 1, 100000, 240) // arranca en marcha y no se detiene
	var last map[string]float64
	for i := 0; i < 60; i++ {
		last = c.step(1)
	}
	if last["state"] != 1 || last["sts"] != 3 || last["rpm"] < 1400 || last["current"] < 6 {
		t.Errorf("cinta en marcha: %v", last)
	}
	s := simulate(t, newSilo(newRNG(5, 5), 60), 20000, 1)
	if lo, hi := minMax(s["level"]); hi <= 90 || lo >= 10 {
		t.Errorf("las excursiones del silo no cruzaron 90/10: %.1f..%.1f", lo, hi)
	}
}

func TestCmdRouteAndDispatch(t *testing.T) {
	for topic, want := range map[string]string{
		"campo/v1/demo/tk-01/cmd":       "demo/tk-01",
		"campo/v1/demo/tk-01/cmd/ack":   "",
		"campo/v1/demo/tk-01/telemetry": "",
		"campo/v1/demo/cmd":             "",
		"campo/v1/demo/a/b/cmd":         "",
		"x/demo/tk-01/cmd":              "",
	} {
		pl, as, ok := cmdRoute(topic)
		if got := pl + "/" + as; (want == "") == ok || (ok && got != want) {
			t.Errorf("cmdRoute(%q) = %q, %v", topic, got, ok)
		}
	}
	r := newCommandRouter()
	ch := make(chan command, 1)
	r.register("demo", "tk-01", ch)
	body := []byte(fmt.Sprintf(`{"id":"x","command":"fill","target":70,"ts":%d,"by":"u"}`, t0.UnixMilli()))
	if _, ok := r.dispatch("campo/v1/demo/tk-01/cmd", body); !ok || (<-ch).ID != "x" {
		t.Fatal("no se entregó la orden")
	}
	if _, ok := r.dispatch("campo/v1/demo/otro/cmd", body); ok {
		t.Error("activo desconocido debe descartarse")
	}
	if _, ok := r.dispatch("campo/v1/demo/tk-01/cmd", []byte(`{no json`)); ok {
		t.Error("JSON inválido debe descartarse")
	}
	if _, ok := r.dispatch("campo/v1/demo/tk-01/cmd", []byte(`{"command":"fill"}`)); ok {
		t.Error("sin id debe descartarse")
	}
	r.dispatch("campo/v1/demo/tk-01/cmd", body) // llena el canal (cap 1)
	if _, ok := r.dispatch("campo/v1/demo/tk-01/cmd", body); ok {
		t.Error("con la cola llena no debe bloquear ni entregar")
	}
	// Un target con tipo inesperado llega al activo para rechazarlo con motivo (no se pierde en silencio).
	<-ch
	if _, ok := r.dispatch("campo/v1/demo/tk-01/cmd", []byte(`{"id":"y","command":"fill","target":"70","ts":1}`)); !ok {
		t.Error("target no numérico debe llegar al activo")
	}
}

func TestAckPayloadJSON(t *testing.T) {
	b, _ := json.Marshal(ack{ID: "o1", Status: statusRejected, Reason: reasonStale}.payload(t0))
	want := fmt.Sprintf(`{"id":"o1","status":"rejected","reason":"stale","ts":%d}`, t0.UnixMilli())
	if string(b) != want {
		t.Errorf("payload = %s", b)
	}
	b, _ = json.Marshal(ack{ID: "o1", Status: statusDone}.payload(t0))
	if want := fmt.Sprintf(`{"id":"o1","status":"done","ts":%d}`, t0.UnixMilli()); string(b) != want {
		t.Errorf("payload = %s", b)
	}
}
