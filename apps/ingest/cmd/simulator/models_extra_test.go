package main

import (
	"math"
	"math/rand/v2"
	"sort"
	"testing"
	"time"
)

func newRNG(a, b uint64) *rand.Rand { return rand.New(rand.NewPCG(a, b)) }

func finite(v float64) bool { return !math.IsNaN(v) && !math.IsInf(v, 0) }

// run avanza el modelo n pasos de dt segundos (reloj falso: nadie lee time.Now) y
// devuelve la serie de cada métrica. Comprueba la finitud de todo valor.
func simulate(t *testing.T, m model, n int, dt float64) map[string][]float64 {
	t.Helper()
	out := map[string][]float64{}
	for i := 0; i < n; i++ {
		for k, v := range m.step(dt) {
			if !finite(v) {
				t.Fatalf("%s no finito en el paso %d: %v", k, i, v)
			}
			out[k] = append(out[k], v)
		}
	}
	return out
}

func minMax(xs []float64) (lo, hi float64) {
	lo, hi = math.Inf(1), math.Inf(-1)
	for _, x := range xs {
		lo, hi = math.Min(lo, x), math.Max(hi, x)
	}
	return
}

func assertRange(t *testing.T, name string, xs []float64, lo, hi float64) {
	t.Helper()
	if a, b := minMax(xs); a < lo || b > hi {
		t.Errorf("%s fuera de [%v, %v]: observado [%v, %v]", name, lo, hi, a, b)
	}
}

func assertMonotone(t *testing.T, name string, xs []float64) {
	t.Helper()
	for i := 1; i < len(xs); i++ {
		if xs[i] < xs[i-1] {
			t.Fatalf("%s decrece en %d: %v -> %v", name, i, xs[i-1], xs[i])
		}
	}
}

func correlation(a, b []float64) float64 {
	var ma, mb float64
	for i := range a {
		ma += a[i]
		mb += b[i]
	}
	ma, mb = ma/float64(len(a)), mb/float64(len(b))
	var sab, saa, sbb float64
	for i := range a {
		sab += (a[i] - ma) * (b[i] - mb)
		saa += (a[i] - ma) * (a[i] - ma)
		sbb += (b[i] - mb) * (b[i] - mb)
	}
	return sab / math.Sqrt(saa*sbb)
}

// integral suma rate·dt/3600 (kW·s → kWh, m³/h·s → m³).
func integral(rate []float64, dt float64) float64 {
	var s float64
	for _, r := range rate {
		s += r * dt / 3600
	}
	return s
}

const twoHours = 7200

func TestClimateRangesCorrelationAndDailyCycle(t *testing.T) {
	midnight := time.Date(2026, 3, 10, 0, 0, 0, 0, time.Local)
	for _, c := range []struct {
		name      string
		mean, amp float64
	}{{"clima-01", 21, 4.5}, {"clima-02", 19, 3.5}} {
		// 2 h a 1 s: rangos y finitud.
		s := simulate(t, newClimate(newRNG(1, 2), midnight, c.mean, c.amp), twoHours, 1)
		assertRange(t, c.name+" temp", s["temp"], 5, 30)
		assertRange(t, c.name+" humidity", s["humidity"], 35, 80)

		// 3 días a 30 s: ciclo diario y anticorrelación.
		const dt = 30.0
		n := 3 * 86400 / int(dt)
		s = simulate(t, newClimate(newRNG(3, 4), midnight, c.mean, c.amp), n, dt)
		assertRange(t, c.name+" temp 3d", s["temp"], 5, 30)
		assertRange(t, c.name+" humidity 3d", s["humidity"], 35, 80)
		if r := correlation(s["temp"], s["humidity"]); r > -0.8 {
			t.Errorf("%s: correlación temp/humedad %.2f, se esperaba < -0.8", c.name, r)
		}
		var night, afternoon float64
		var nn, na int
		for i, v := range s["temp"] {
			h := float64(i) * dt / 3600
			switch h = math.Mod(h, 24); {
			case h < 6:
				night, nn = night+v, nn+1
			case h >= 12 && h < 18:
				afternoon, na = afternoon+v, na+1
			}
		}
		if d := afternoon/float64(na) - night/float64(nn); d < 3 {
			t.Errorf("%s: la tarde sólo es %.2f °C más cálida que la madrugada", c.name, d)
		}
	}
}

func TestEnergyProfilesCountersAndPF(t *testing.T) {
	for _, c := range []struct {
		name   string
		p      energyProfile
		lo, hi float64
	}{
		{"en-linea1", profLinea1, 120, 180},
		{"en-compresores", profCompresores, 80, 110},
		{"en-clima", profClima, 50, 70},
		{"en-calderas", profCalderas, 60, 95},
	} {
		const dt = 1.0
		m := newEnergy(newRNG(5, 6), c.p)
		start := m.kwh
		s := simulate(t, m, twoHours, dt)
		assertRange(t, c.name+" kw", s["kw"], c.lo, c.hi)
		assertRange(t, c.name+" pf", s["pf"], 0.88, 0.98)
		assertMonotone(t, c.name+" kwh", s["kwh"])
		if start < 1000 {
			t.Errorf("%s: contador inicial poco plausible: %v", c.name, start)
		}
		// El contador integra kw en el tiempo (kwh += kw·dt/3600).
		got, want := s["kwh"][len(s["kwh"])-1]-start, integral(s["kw"], dt)
		if math.Abs(got-want) > 0.01*want {
			t.Errorf("%s: kwh avanzó %.3f, la integral de kw es %.3f", c.name, got, want)
		}
		if lo, hi := minMax(s["kw"]); hi-lo < 3 {
			t.Errorf("%s: kw casi constante (%v..%v)", c.name, lo, hi)
		}
	}
}

func TestEnergyBoilerHasPeaks(t *testing.T) {
	s := simulate(t, newEnergy(newRNG(7, 8), profCalderas), 4*twoHours/2, 1)
	if _, hi := minMax(s["kw"]); hi < 85 {
		t.Errorf("calderas sin picos: máximo %.1f kW", hi)
	}
}

func TestEnergyCounterWithLargeAndZeroDT(t *testing.T) {
	m := newEnergy(newRNG(9, 9), profLinea1)
	prev := m.step(0)["kwh"]
	for _, dt := range []float64{0, 0.5, 1, 30, 600} {
		cur := m.step(dt)["kwh"]
		if cur < prev {
			t.Fatalf("kwh decrece con dt=%v: %v -> %v", dt, prev, cur)
		}
		prev = cur
	}
}

func TestGasStepsAndTotal(t *testing.T) {
	const dt = 1.0
	m := newGas(newRNG(10, 11))
	start := m.total
	s := simulate(t, m, 4*twoHours, dt)
	assertRange(t, "gas flow", s["flow"], 0, 30)
	assertMonotone(t, "gas total", s["total"])
	got, want := s["total"][len(s["total"])-1]-start, integral(s["flow"], dt)
	if math.Abs(got-want) > 0.01*want {
		t.Errorf("total avanzó %.3f m³, la integral de flow es %.3f", got, want)
	}
	levels := map[int]bool{}
	for _, f := range s["flow"] {
		levels[int(math.Round(f/6))] = true
	}
	if len(levels) < 3 {
		t.Errorf("flow sin escalones: sólo %d bandas", len(levels))
	}
}

func TestMachineStateIsStable(t *testing.T) {
	for i, p := range []struct{ onProb, meanOn, meanOff float64 }{{0.85, 1500, 300}, {0.7, 900, 400}, {0.5, 600, 600}} {
		const dt = 1.0
		// 24 h: debe haber cambios, y 2 h: pocos.
		s := simulate(t, newMachine(newRNG(12, uint64(i)), p.onProb, p.meanOn, p.meanOff), 24*3600, dt)["state"]
		var changes int
		var last int
		var dwell []int // duración de cada tramo completo (se descarta el primero, parcial)
		for j := 1; j < len(s); j++ {
			if s[j] != 0 && s[j] != 1 {
				t.Fatalf("state fuera de {0,1}: %v", s[j])
			}
			if s[j] != s[j-1] {
				if changes > 0 {
					dwell = append(dwell, j-last)
				}
				changes++
				last = j
			}
		}
		if changes < 2 {
			t.Errorf("maq %d: sólo %d cambios en 24 h", i+1, changes)
		}
		for _, d := range dwell {
			if d < 120 {
				t.Errorf("maq %d: tramo de %d s, se esperaban minutos", i+1, d)
			}
		}
		var in2h int
		for j := 1; j < twoHours; j++ {
			if s[j] != s[j-1] {
				in2h++
			}
		}
		if in2h > 20 {
			t.Errorf("maq %d: %d cambios en 2 h, demasiados", i+1, in2h)
		}
	}
}

func TestPressureRangeAndExcursions(t *testing.T) {
	s := simulate(t, newPressure(newRNG(13, 14), 0), 4*twoHours, 1)
	assertRange(t, "pressure sin excursiones", s["pressure"], 4, 7)
	if lo, hi := minMax(s["pressure"]); hi-lo < 1 {
		t.Errorf("sin oscilación: %v..%v", lo, hi)
	}

	s = simulate(t, newPressure(newRNG(15, 16), 60), 4*twoHours, 1)
	lo, hi := minMax(s["pressure"])
	if hi <= 8 {
		t.Errorf("las excursiones no cruzaron 8 bar: máximo %.2f", hi)
	}
	if lo < 4 || hi > 9.5 {
		t.Errorf("fuera de límites duros: %v..%v", lo, hi)
	}
	// Ocasional: la mayor parte del tiempo está en régimen normal.
	over := 0
	for _, v := range s["pressure"] {
		if v > 7 {
			over++
		}
	}
	if over > len(s["pressure"])/2 {
		t.Errorf("la presión pasa %d/%d muestras sobre 7 bar", over, len(s["pressure"]))
	}
}

func TestFlowMeterRange(t *testing.T) {
	s := simulate(t, newFlowMeter(newRNG(17, 18)), 4*twoHours, 1)
	assertRange(t, "cau-01 flow", s["flow"], 5, 40)
	if lo, hi := minMax(s["flow"]); hi-lo < 5 {
		t.Errorf("caudal casi constante: %v..%v", lo, hi)
	}
}

func TestModelsAreDeterministicPerSeed(t *testing.T) {
	a := simulate(t, newGas(newRNG(1, 1)), 500, 1)
	b := simulate(t, newGas(newRNG(1, 1)), 500, 1)
	c := simulate(t, newGas(newRNG(1, 2)), 500, 1)
	if !equalSeries(a["total"], b["total"]) {
		t.Error("misma semilla, distinta salida")
	}
	if equalSeries(a["total"], c["total"]) {
		t.Error("semillas distintas, misma salida")
	}
}

func equalSeries(a, b []float64) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// ---- Perfiles por planta ----

var wantMetrics = map[string][]string{
	"tk-01": {"level", "temp"}, "tk-02": {"level", "temp"}, "tk-03": {"level", "temp"}, "tk-04": {"level", "temp"},
	"pump-01": {"current", "rpm"}, "pump-02": {"current", "rpm"},
	"valve-01": {"position"}, "valve-02": {"position"},
	"clima-01": {"humidity", "temp"}, "clima-02": {"humidity", "temp"},
	"en-linea1": {"kw", "kwh", "pf"}, "en-compresores": {"kw", "kwh", "pf"}, "en-clima": {"kw", "kwh", "pf"}, "en-calderas": {"kw", "kwh", "pf"},
	"gas-01": {"flow", "total"},
	"maq-01": {"state"}, "maq-02": {"state"}, "maq-03": {"state"},
	"pres-01": {"pressure"},
	"cau-01":  {"flow"},
	"tk-a":    {"level", "temp"}, "tk-b": {"level", "temp"},
}

var wantAssets = map[string][]string{
	"demo": {"tk-01", "tk-02", "tk-03", "tk-04", "pump-01", "pump-02", "valve-01", "valve-02",
		"clima-01", "clima-02", "en-linea1", "en-compresores", "en-clima", "en-calderas",
		"gas-01", "maq-01", "maq-02", "maq-03", "pres-01", "cau-01"},
	"tanques": {"tk-a", "tk-b"},
}

func testProfile(meanExc float64) profile {
	return profile{seed: 42, meanExc: meanExc, start: time.Date(2026, 3, 10, 0, 0, 0, 0, time.Local), tanks: 4, pumps: 2, valves: 2}
}

func ids(as []asset) []string {
	out := make([]string, len(as))
	for i, a := range as {
		out[i] = a.id
	}
	return out
}

func TestAssetIDsPerPlant(t *testing.T) {
	for plant, want := range wantAssets {
		got := ids(buildAssets(plant, testProfile(300)))
		if !equalStrings(got, want) {
			t.Errorf("%s: ids %v, se esperaban %v", plant, got, want)
		}
	}
	// Planta desconocida (compatibilidad con -plant): sólo los 8 heredados.
	if got := ids(buildAssets("otra", testProfile(300))); !equalStrings(got, wantAssets["demo"][:8]) {
		t.Errorf("otra: %v", got)
	}
	// La carga escala sólo los heredados de demo.
	p := testProfile(300)
	p.tanks, p.pumps, p.valves = 10, 0, 0
	if n := len(buildAssets("demo", p)); n != 10+12 {
		t.Errorf("demo escalada: %d activos, se esperaban 22", n)
	}
	if n := len(buildAssets("tanques", p)); n != 2 {
		t.Errorf("tanques no debe escalar con -tanks: %d", n)
	}
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func TestEveryAssetMetricsAndRanges(t *testing.T) {
	type bounds struct{ lo, hi float64 }
	ranges := map[string]bounds{
		"level": {0, 100}, "position": {0, 100}, "rpm": {0, 3000}, "current": {0, 40}, "temp": {0, 80},
		"humidity": {35, 80}, "kw": {50, 180}, "pf": {0.88, 0.98}, "flow": {0, 40}, "state": {0, 1}, "pressure": {4, 9.5},
	}
	for plant := range wantAssets {
		for _, a := range buildAssets(plant, testProfile(120)) {
			s := simulate(t, a.model, twoHours, 1)
			var keys []string
			for k, xs := range s {
				keys = append(keys, k)
				if b, ok := ranges[k]; ok {
					assertRange(t, plant+"/"+a.id+"/"+k, xs, b.lo, b.hi)
				}
				if k == "kwh" || k == "total" {
					assertMonotone(t, plant+"/"+a.id+"/"+k, xs)
				}
			}
			sort.Strings(keys)
			if !equalStrings(keys, wantMetrics[a.id]) {
				t.Errorf("%s/%s: métricas %v, se esperaban %v", plant, a.id, keys, wantMetrics[a.id])
			}
		}
	}
}

func TestProfileExcursionsCrossThresholds(t *testing.T) {
	for _, c := range []struct{ plant, id string }{{"demo", "tk-01"}, {"demo", "tk-02"}, {"tanques", "tk-a"}, {"tanques", "tk-b"}} {
		var m model
		for _, a := range buildAssets(c.plant, testProfile(60)) { // excursiones ~cada minuto
			if a.id == c.id {
				m = a.model
			}
		}
		s := simulate(t, m, 20000, 1)
		_, hiL := minMax(s["level"])
		loL, _ := minMax(s["level"])
		if hiL <= 90 || loL >= 10 {
			t.Errorf("%s/%s: level %.1f..%.1f no cruzó 90/10", c.plant, c.id, loL, hiL)
		}
		if _, hiT := minMax(s["temp"]); hiT <= 35 {
			t.Errorf("%s/%s: temp máx %.1f no cruzó 35", c.plant, c.id, hiT)
		}
	}
	// demo conserva el resto de excursiones heredadas y la de presión.
	got := map[string]float64{}
	for _, a := range buildAssets("demo", testProfile(60)) {
		switch a.id {
		case "pump-01":
			_, got["current"] = minMax(simulate(t, a.model, 20000, 1)["current"])
		case "valve-01":
			_, got["position"] = minMax(simulate(t, a.model, 20000, 1)["position"])
		case "pres-01":
			_, got["pressure"] = minMax(simulate(t, a.model, 20000, 1)["pressure"])
		}
	}
	if got["current"] <= 18 || got["position"] <= 95 || got["pressure"] <= 8 {
		t.Errorf("excursiones de demo sin cruzar umbrales: %v", got)
	}
}

func TestZeroExcursionsStayNominalInNewProfiles(t *testing.T) {
	for _, a := range buildAssets("demo", testProfile(0)) {
		s := simulate(t, a.model, twoHours, 1)
		if a.id == "pres-01" {
			assertRange(t, "pres-01", s["pressure"], 4, 7)
		}
	}
}
