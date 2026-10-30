package main

import (
	"math"
	"math/rand/v2"
	"time"
)

// Modelos de los módulos de §11.2 (clima, energía, gas, máquinas, presión, caudal).
// Son puros: todo el estado vive en el struct, la aleatoriedad en el *rand.Rand con
// semilla que se les inyecta y el tiempo avanza sólo con step(dt) (nunca leen el reloj).

func round3(v float64) float64 { return math.Round(v*1000) / 1000 }

// drift es un proceso AR(1) de media cero: una deriva lenta y acotada en la práctica.
type drift struct{ v float64 }

// next avanza dt segundos con constante de tiempo tau y desviación estacionaria sigma.
func (d *drift) next(rng *rand.Rand, dt, tau, sigma float64) float64 {
	a := math.Exp(-dt / tau)
	d.v = d.v*a + sigma*math.Sqrt(1-a*a)*rng.NormFloat64()
	return d.v
}

// ---- Clima: temp con ciclo diario, humidity anticorrelacionada ----

type climate struct {
	rng       *rand.Rand
	now       time.Time // reloj simulado (hora local de la planta = la del proceso)
	mean, amp float64   // °C: media diaria y semiamplitud del ciclo
	slow      drift
}

func newClimate(rng *rand.Rand, start time.Time, mean, amp float64) *climate {
	return &climate{rng: rng, now: start, mean: mean, amp: amp}
}

// step: mínimo hacia las 03:00 y máximo hacia las 15:00.
func (c *climate) step(dt float64) map[string]float64 {
	c.now = c.now.Add(time.Duration(dt * float64(time.Second)))
	h := float64(c.now.Hour()) + float64(c.now.Minute())/60 + float64(c.now.Second())/3600
	temp := c.mean + c.amp*math.Sin(2*math.Pi*(h-9)/24) + c.slow.next(c.rng, dt, 600, 0.5) + noise(c.rng, 0.08)
	hum := 60 - 2.2*(temp-20) + noise(c.rng, 0.4)
	return map[string]float64{
		"temp":     round2(temp),
		"humidity": round2(clamp(hum, 35, 80)),
	}
}

// ---- Energía: kw con perfil propio, kwh contador integrado, pf ----

type energyProfile struct {
	lo, hi    float64 // límites duros de kw
	mid, amp  float64 // centro y semiamplitud de la oscilación lenta
	period    float64 // s
	sigma     float64 // ruido de kw
	pf        float64 // factor de potencia típico
	peaks     bool    // picos ocasionales (calderas)
	peakKW    float64
	startKWh  float64
	startSpan float64
}

var (
	profLinea1      = energyProfile{lo: 120, hi: 180, mid: 150, amp: 22, period: 1200, sigma: 2.5, pf: 0.95, startKWh: 150000, startSpan: 300000}
	profCompresores = energyProfile{lo: 80, hi: 110, mid: 95, amp: 9, period: 420, sigma: 1.8, pf: 0.91, startKWh: 80000, startSpan: 200000}
	profClima       = energyProfile{lo: 50, hi: 70, mid: 60, amp: 6, period: 1800, sigma: 1, pf: 0.92, startKWh: 40000, startSpan: 100000}
	profCalderas    = energyProfile{lo: 60, hi: 95, mid: 70, amp: 5, period: 900, sigma: 1.5, pf: 0.96, peaks: true, peakKW: 22, startKWh: 60000, startSpan: 150000}
)

type energy struct {
	rng      *rand.Rand
	p        energyProfile
	t, phase float64
	slow     drift
	pfDrift  drift
	peakFor  float64 // s que le quedan al pico en curso
	peakOff  float64
	kwh      float64
}

func newEnergy(rng *rand.Rand, p energyProfile) *energy {
	return &energy{
		rng: rng, p: p, phase: rng.Float64() * 2 * math.Pi,
		kwh: math.Round(p.startKWh + rng.Float64()*p.startSpan),
	}
}

func (e *energy) step(dt float64) map[string]float64 {
	e.t += dt
	if e.p.peaks {
		if e.peakFor > 0 {
			e.peakFor -= dt
		} else if e.rng.Float64() < dt/240 { // un pico cada ~4 min
			e.peakFor = 15 + e.rng.Float64()*25
		}
		target := 0.0
		if e.peakFor > 0 {
			target = e.p.peakKW
		}
		e.peakOff = lag(e.peakOff, target, 0.3, dt)
	}
	kw := e.p.mid + e.p.amp*math.Sin(2*math.Pi*e.t/e.p.period+e.phase) +
		e.slow.next(e.rng, dt, 300, e.p.sigma) + e.peakOff + noise(e.rng, e.p.sigma)
	kw = clamp(kw, e.p.lo, e.p.hi)
	e.kwh += kw * dt / 3600 // kW · s → kWh; nunca decrece porque kw ≥ lo > 0 y dt ≥ 0
	pf := e.p.pf + 0.025*math.Sin(2*math.Pi*e.t/1500+e.phase) + e.pfDrift.next(e.rng, dt, 200, 0.006)
	return map[string]float64{
		"kw":  round2(kw),
		"kwh": round3(e.kwh),
		"pf":  round3(clamp(pf, 0.88, 0.98)),
	}
}

// ---- Gas: caudal a escalones, total integrado ----

type gas struct {
	rng      *rand.Rand
	flow     float64
	setpoint float64
	hold     float64
	total    float64
}

var gasLevels = [...]float64{0, 3, 8, 12, 18, 24, 28}

func newGas(rng *rand.Rand) *gas {
	g := &gas{rng: rng, total: math.Round(1000 + rng.Float64()*9000)}
	g.setpoint = gasLevels[rng.IntN(len(gasLevels))]
	g.flow = g.setpoint
	return g
}

func (g *gas) step(dt float64) map[string]float64 {
	if g.hold -= dt; g.hold <= 0 {
		g.setpoint = gasLevels[g.rng.IntN(len(gasLevels))]
		g.hold = 60 + g.rng.Float64()*180
	}
	g.flow = lag(g.flow, g.setpoint, 0.4, dt)
	flow := clamp(g.flow+noise(g.rng, 0.15), 0, 30)
	g.total += flow * dt / 3600 // m³/h · s → m³
	return map[string]float64{"flow": round2(flow), "total": round3(g.total)}
}

// ---- Máquina: state 0/1 estable durante minutos entre cambios ----

type machine struct {
	rng       *rand.Rand
	on        bool
	remaining float64 // s hasta el próximo cambio
	meanOn    float64 // s, media de la parte aleatoria de cada marcha
	meanOff   float64
}

const (
	machineMinOn  = 300.0 // s: una marcha dura al menos 5 min
	machineMinOff = 120.0 // s: una parada dura al menos 2 min
)

// newMachine arranca en marcha con probabilidad onProb; el primer tramo es una fracción de uno completo.
func newMachine(rng *rand.Rand, onProb, meanOn, meanOff float64) *machine {
	m := &machine{rng: rng, on: rng.Float64() < onProb, meanOn: meanOn, meanOff: meanOff}
	m.remaining = m.dwell() * (0.2 + 0.8*rng.Float64())
	return m
}

func (m *machine) dwell() float64 {
	if m.on {
		return machineMinOn + m.rng.ExpFloat64()*m.meanOn
	}
	return machineMinOff + m.rng.ExpFloat64()*m.meanOff
}

func (m *machine) step(dt float64) map[string]float64 {
	if m.remaining -= dt; m.remaining <= 0 {
		m.on = !m.on
		m.remaining = m.dwell()
	}
	state := 0.0
	if m.on {
		state = 1
	}
	return map[string]float64{"state": state}
}

// ---- Presión: oscilación 4–7 bar y excursiones > 8 ----

type pressure struct {
	rng   *rand.Rand
	exc   excursion
	t     float64
	phase float64
	slow  drift
	off   float64
}

const excOverPressure = 1 // presión +3,3 bar

func newPressure(rng *rand.Rand, meanExc float64) *pressure {
	return &pressure{rng: rng, exc: excursion{rng: rng, meanEvery: meanExc}, phase: rng.Float64() * 2 * math.Pi}
}

func (p *pressure) step(dt float64) map[string]float64 {
	p.t += dt
	p.exc.maybeStart(dt, 1)
	target := 0.0
	if p.exc.kind == excOverPressure {
		target = 3.3
	}
	p.off = lag(p.off, target, 0.4, dt)
	p.exc.tick(dt)

	nominal := 5.5 + 0.9*math.Sin(2*math.Pi*p.t/180+p.phase) + clamp(p.slow.next(p.rng, dt, 240, 0.1), -0.2, 0.2)
	return map[string]float64{"pressure": round2(clamp(nominal+p.off+noise(p.rng, 0.04), 4, 9.5))}
}

// ---- Caudal: 5–40 m³/h con ruido ----

type flowMeter struct {
	rng   *rand.Rand
	t     float64
	phase float64
	slow  drift
}

func newFlowMeter(rng *rand.Rand) *flowMeter {
	return &flowMeter{rng: rng, phase: rng.Float64() * 2 * math.Pi}
}

func (f *flowMeter) step(dt float64) map[string]float64 {
	f.t += dt
	v := 22 + 10*math.Sin(2*math.Pi*f.t/900+f.phase) + f.slow.next(f.rng, dt, 120, 2) + noise(f.rng, 0.8)
	return map[string]float64{"flow": round2(clamp(v, 5, 40))}
}
