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

// ---- Tanque / silo: vaivén autónomo entre 20 % y 85 % y llenado/vaciado por orden ----
//
// Sin orden el nivel deriva solo (fondo del proceso) con sts=0 y mode=0 (manual) y level_sp acompaña al
// nivel (sin desviación). Con una orden fill/drain el nivel se mueve de verdad hacia el objetivo
// (level_sp = objetivo, mode=1, sts=1 llenando / 2 vaciando); al llegar se queda en el objetivo
// tankHoldAfter segundos y luego retoma el vaivén. Un silo es un tanque más lento.

const (
	tankFillRate  = 1.5 // %/s con orden (de 20 % a 85 % en ~45 s)
	siloFillRate  = 0.7 // %/s: ~2 min de punta a punta
	tankHoldAfter = 90.0
)

type tank struct {
	ctl
	rng     *rand.Rand
	exc     excursion
	level   float64
	dir     float64
	tempOff float64
	phase   float64
	t       float64

	driftRate float64 // %/s del vaivén autónomo
	excRate   float64 // %/s durante excursiones de nivel
	fillRate  float64 // %/s con orden, antes de speed
	speed     float64 // multiplicador de fillRate (-cmd-speed)

	ord     *levelOrder
	holdFor float64 // s restantes quieto en el objetivo tras terminar una orden
	holdSP  float64
}

type levelOrder struct {
	id     string
	dir    float64 // +1 llenar, -1 vaciar
	target float64
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
		driftRate: 0.4, excRate: 2.5, fillRate: tankFillRate, speed: 1,
	}
}

// newSilo es un tanque más lento (misma dinámica, cuatro veces menos deriva).
func newSilo(rng *rand.Rand, meanExc float64) *tank {
	k := newTank(rng, meanExc)
	k.driftRate, k.excRate, k.fillRate = 0.15, 1.5, siloFillRate
	return k
}

func (k *tank) step(dt float64) map[string]float64 {
	k.t += dt
	k.exc.maybeStart(dt, 3)

	switch {
	case k.ord != nil:
		k.stepOrder(dt)
	case k.holdFor > 0:
		k.holdFor -= dt
	default:
		k.stepAuto(dt)
	}
	target := 0.0
	if k.exc.kind == excOverTemp {
		target = 25
	}
	k.tempOff = lag(k.tempOff, target, 0.15, dt)
	k.exc.tick(dt)

	sp, mode, sts := round2(k.level), 0.0, 0.0
	switch {
	case k.ord != nil:
		sp, mode, sts = k.ord.target, 1, 1
		if k.ord.dir < 0 {
			sts = 2
		}
	case k.holdFor > 0:
		sp, mode = k.holdSP, 1
	}
	temp := 18 + 3*math.Sin(2*math.Pi*k.t/600+k.phase) + k.tempOff + noise(k.rng, 0.1)
	return map[string]float64{
		"level":    round2(clamp(k.level+noise(k.rng, 0.1), 0, 100)),
		"temp":     round2(temp),
		"level_sp": sp,
		"mode":     mode,
		"sts":      sts,
	}
}

func (k *tank) stepAuto(dt float64) {
	switch k.exc.kind {
	case excOverflow:
		k.level = math.Min(k.level+k.excRate*dt, 98)
	case excEmpty:
		k.level = math.Max(k.level-k.excRate*dt, 3)
	default:
		k.level += k.dir * k.driftRate * dt // un ciclo completo dura minutos
		if k.level >= 85 {
			k.dir = -1
		} else if k.level <= 20 {
			k.dir = 1
		}
	}
}

func (k *tank) stepOrder(dt float64) {
	o, move := k.ord, k.fillRate*k.speed*dt
	if o.dir > 0 {
		k.level = math.Min(k.level+move, o.target)
	} else {
		k.level = math.Max(k.level-move, o.target)
	}
	if k.level == o.target {
		k.emit(o.id, statusDone, "")
		k.ord, k.holdFor, k.holdSP = nil, tankHoldAfter, o.target
	}
}

func (k *tank) apply(c command) {
	switch c.Command {
	case "fill", "drain":
		t, ok := c.target()
		dir := 1.0
		if c.Command == "drain" {
			dir = -1
		}
		switch {
		case !ok || t < 1 || t > 99:
			k.emit(c.ID, statusRejected, reasonBadTarget)
		case k.ord != nil:
			k.emit(c.ID, statusRejected, reasonBusy)
		case (t-k.level)*dir < 0.05: // fill sólo si nivel < objetivo, drain sólo si nivel > objetivo
			k.emit(c.ID, statusRejected, reasonAtTarget)
		default:
			k.ord, k.holdFor = &levelOrder{id: c.ID, dir: dir, target: t}, 0
			k.emit(c.ID, statusAccepted, "")
			k.emit(c.ID, statusRunning, "")
		}
	case "stop":
		k.emit(c.ID, statusAccepted, "")
		k.emit(c.ID, statusRunning, "")
		if k.ord != nil {
			k.emit(k.ord.id, statusFailed, reasonStopped)
		}
		// Queda quieto donde está (sts=0); pasado tankHoldAfter retoma el vaivén.
		k.ord, k.holdFor, k.holdSP = nil, tankHoldAfter, round2(k.level)
		k.emit(c.ID, statusDone, "")
	default:
		k.emit(c.ID, statusRejected, reasonUnsupported)
	}
}

// ---- Bomba: arranques/paros, rpm con inercia, corriente proporcional ----
//
// start/stop por orden: la orden termina (done) cuando las rpm alcanzan ≥1200 o caen a <5. Tras una
// orden la bomba no vuelve sola a su ciclo autónomo de paros/arranques durante pumpManualHold.

const (
	pumpManualHold = 300.0 // s sin paro programado tras un start; también lo que tarda en rearrancar tras un stop
	pumpStopHold   = 600.0
)

type pump struct {
	ctl
	rng       *rand.Rand
	exc       excursion
	running   bool
	offFor    float64
	rpm       float64
	noStopFor float64
	ord       *pumpOrder
}

type pumpOrder struct {
	id    string
	start bool
}

const excOverCurrent = 1 // corriente ~1,8x con caída de rpm

func newPump(rng *rand.Rand, meanExc float64) *pump {
	return &pump{rng: rng, exc: excursion{rng: rng, meanEvery: meanExc}, running: true, rpm: 1450}
}

func (p *pump) step(dt float64) map[string]float64 {
	if p.noStopFor > 0 {
		p.noStopFor -= dt
	}
	if p.running && p.noStopFor <= 0 && p.rng.Float64() < dt/240 { // paro programado aprox. cada 4 min
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

	if o := p.ord; o != nil && ((o.start && p.running && p.rpm >= 1200) || (!o.start && !p.running && p.rpm < 5)) {
		p.emit(o.id, statusDone, "")
		p.ord = nil
	}

	rpm := math.Max(0, p.rpm+noise(p.rng, 3))
	current := math.Max(0, 11*(p.rpm/1450)*load+noise(p.rng, 0.15))
	if !p.running && p.rpm < 5 {
		rpm, current = 0, 0
	}
	sts := 0.0
	if p.running {
		sts = 3
	}
	return map[string]float64{"rpm": round2(rpm), "current": round2(current), "sts": sts}
}

func (p *pump) apply(c command) {
	switch c.Command {
	case "start":
		if p.ord != nil {
			p.emit(c.ID, statusRejected, reasonBusy)
			return
		}
		p.running, p.offFor, p.noStopFor = true, 0, pumpManualHold
		p.ord = &pumpOrder{id: c.ID, start: true}
	case "stop":
		p.emit(c.ID, statusAccepted, "")
		p.emit(c.ID, statusRunning, "")
		if p.ord != nil {
			p.emit(p.ord.id, statusFailed, reasonStopped)
		}
		p.running, p.offFor, p.noStopFor = false, pumpStopHold, 0
		p.ord = &pumpOrder{id: c.ID}
		return
	default:
		p.emit(c.ID, statusRejected, reasonUnsupported)
		return
	}
	p.emit(c.ID, statusAccepted, "")
	p.emit(c.ID, statusRunning, "")
}

// ---- Válvula: sigue una consigna a 10 %/s ----
//
// open/close/set_position fijan la consigna (100, 0 o target) y la mantienen valveManualHold segundos
// antes de volver a las consignas aleatorias; stop la congela donde está.

const valveManualHold = 300.0

type valve struct {
	ctl
	rng      *rand.Rand
	exc      excursion
	pos      float64
	setpoint float64
	hold     float64
	ord      *valveOrder
}

type valveOrder struct {
	id     string
	target float64
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
	if o := v.ord; o != nil && v.pos == o.target {
		v.emit(o.id, statusDone, "")
		v.ord = nil
	}
	return map[string]float64{"position": round2(clamp(v.pos+noise(v.rng, 0.05), 0, 100))}
}

func (v *valve) apply(c command) {
	var target float64
	switch c.Command {
	case "open":
		target = 100
	case "close":
		target = 0
	case "set_position":
		t, ok := c.target()
		if !ok || t < 0 || t > 100 {
			v.emit(c.ID, statusRejected, reasonBadTarget)
			return
		}
		target = t
	case "stop":
		v.emit(c.ID, statusAccepted, "")
		v.emit(c.ID, statusRunning, "")
		if v.ord != nil {
			v.emit(v.ord.id, statusFailed, reasonStopped)
		}
		v.ord, v.setpoint, v.hold = nil, v.pos, valveManualHold
		v.emit(c.ID, statusDone, "")
		return
	default:
		v.emit(c.ID, statusRejected, reasonUnsupported)
		return
	}
	if v.ord != nil {
		v.emit(c.ID, statusRejected, reasonBusy)
		return
	}
	v.ord, v.setpoint, v.hold = &valveOrder{id: c.ID, target: target}, target, valveManualHold
	v.emit(c.ID, statusAccepted, "")
	v.emit(c.ID, statusRunning, "")
}
