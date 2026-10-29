package main

import (
	"math"
	"math/rand/v2"
)

// excursion modela un evento anómalo con duración acotada.
type excursion struct {
	rng       *rand.Rand
	meanEvery float64 // segundos entre excursiones; <= 0 desactiva
	kind      int     // 0 = ninguna; el significado lo define cada modelo
	remaining float64
}

// maybeStart inicia una excursión (con probabilidad dt/meanEvery) eligiendo uno de n tipos.
func (e *excursion) maybeStart(dt float64, kinds int) {
	if e.kind != 0 || e.meanEvery <= 0 || e.rng.Float64() >= dt/e.meanEvery {
		return
	}
	e.kind = 1 + e.rng.IntN(kinds)
	e.remaining = 20 + e.rng.Float64()*20
}

// tick avanza el reloj de la excursión actual.
func (e *excursion) tick(dt float64) {
	if e.kind == 0 {
		return
	}
	if e.remaining -= dt; e.remaining <= 0 {
		e.kind = 0
	}
}

func clamp(v, lo, hi float64) float64             { return math.Max(lo, math.Min(hi, v)) }
func noise(rng *rand.Rand, sigma float64) float64 { return rng.NormFloat64() * sigma }
func round2(v float64) float64                    { return math.Round(v*100) / 100 }

// lag acerca cur a target con una constante de tiempo de 1/k segundos.
func lag(cur, target, k, dt float64) float64 { return cur + (target-cur)*math.Min(1, k*dt) }

// ---- Tanque: rampas de llenado/vaciado entre 20 % y 85 % ----

type tank struct {
	rng     *rand.Rand
	exc     excursion
	level   float64
	dir     float64
	tempOff float64
	phase   float64
	t       float64
}

const (
	excOverflow = 1 // level -> 98 %
	excEmpty    = 2 // level -> 3 %
	excOverTemp = 3 // temp +25 °C
)

func newTank(rng *rand.Rand, meanExc float64) *tank {
	dir := 1.0
	if rng.IntN(2) == 0 {
		dir = -1
	}
	return &tank{
		rng: rng, exc: excursion{rng: rng, meanEvery: meanExc},
		level: 25 + rng.Float64()*55, dir: dir, phase: rng.Float64() * 2 * math.Pi,
	}
}

func (k *tank) step(dt float64) map[string]float64 {
	k.t += dt
	k.exc.maybeStart(dt, 3)

	switch k.exc.kind {
	case excOverflow:
		k.level = math.Min(k.level+2.5*dt, 98)
	case excEmpty:
		k.level = math.Max(k.level-2.5*dt, 3)
	default:
		k.level += k.dir * 0.4 * dt // ~0,4 %/s: un ciclo completo dura minutos
		if k.level >= 85 {
			k.dir = -1
		} else if k.level <= 20 {
			k.dir = 1
		}
	}
	target := 0.0
	if k.exc.kind == excOverTemp {
		target = 25
	}
	k.tempOff = lag(k.tempOff, target, 0.15, dt)
	k.exc.tick(dt)

	temp := 18 + 3*math.Sin(2*math.Pi*k.t/600+k.phase) + k.tempOff + noise(k.rng, 0.1)
	return map[string]float64{
		"level": round2(clamp(k.level+noise(k.rng, 0.1), 0, 100)),
		"temp":  round2(temp),
	}
}

// ---- Bomba: arranques/paros, rpm con inercia, corriente proporcional ----

type pump struct {
	rng     *rand.Rand
	exc     excursion
	running bool
	offFor  float64
	rpm     float64
}

const excOverCurrent = 1 // corriente ~1,8x con caída de rpm

func newPump(rng *rand.Rand, meanExc float64) *pump {
	return &pump{rng: rng, exc: excursion{rng: rng, meanEvery: meanExc}, running: true, rpm: 1450}
}

func (p *pump) step(dt float64) map[string]float64 {
	if p.running && p.rng.Float64() < dt/240 { // paro programado aprox. cada 4 min
		p.running, p.offFor = false, 10+p.rng.Float64()*20
	} else if !p.running {
		if p.offFor -= dt; p.offFor <= 0 {
			p.running = true
		}
	}
	p.exc.maybeStart(dt, 1)

	target, load := 0.0, 1.0
	if p.running {
		target = 1450
		if p.exc.kind == excOverCurrent {
			load, target = 1.8, 1450*0.85
		}
	}
	p.rpm = lag(p.rpm, target, 0.5, dt)
	p.exc.tick(dt)

	rpm := math.Max(0, p.rpm+noise(p.rng, 3))
	current := math.Max(0, 11*(p.rpm/1450)*load+noise(p.rng, 0.15))
	if !p.running && p.rpm < 5 {
		rpm, current = 0, 0
	}
	return map[string]float64{"rpm": round2(rpm), "current": round2(current)}
}

// ---- Válvula: sigue una consigna a 10 %/s ----

type valve struct {
	rng      *rand.Rand
	exc      excursion
	pos      float64
	setpoint float64
	hold     float64
}

const excStuckOpen = 1 // consigna forzada al 100 %

func newValve(rng *rand.Rand, meanExc float64) *valve {
	v := &valve{rng: rng, exc: excursion{rng: rng, meanEvery: meanExc}}
	v.pos = float64(rng.IntN(5)) * 25
	v.setpoint = v.pos
	return v
}

func (v *valve) step(dt float64) map[string]float64 {
	v.exc.maybeStart(dt, 1)
	if v.hold -= dt; v.hold <= 0 {
		v.setpoint = float64(v.rng.IntN(5)) * 25 // 0, 25, 50, 75 ó 100 %
		if v.setpoint > 90 {
			v.setpoint = 90 // la operación normal no cruza el umbral de 95 %
		}
		v.hold = 20 + v.rng.Float64()*40
	}
	sp := v.setpoint
	if v.exc.kind == excStuckOpen {
		sp = 100
	}
	if d := sp - v.pos; math.Abs(d) <= 10*dt {
		v.pos = sp
	} else {
		v.pos += math.Copysign(10*dt, d)
	}
	v.exc.tick(dt)
	return map[string]float64{"position": round2(clamp(v.pos+noise(v.rng, 0.05), 0, 100))}
}
