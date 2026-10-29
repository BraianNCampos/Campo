package main

import (
	"math"
	"math/rand/v2"
	"testing"
)

func TestModelsStayInRangeAndExcursionsCrossThresholds(t *testing.T) {
	rng := rand.New(rand.NewPCG(1, 2))
	const dt = 1.0
	tk, pm, vl := newTank(rng, 60), newPump(rng, 60), newValve(rng, 60) // excursiones ~cada minuto

	var maxLevel, minLevel, maxTemp, maxCurrent, maxPos = 0.0, 100.0, 0.0, 0.0, 0.0
	for i := 0; i < 20000; i++ {
		a, b, c := tk.step(dt), pm.step(dt), vl.step(dt)
		for _, v := range []float64{a["level"], a["temp"], b["rpm"], b["current"], c["position"]} {
			if math.IsNaN(v) || math.IsInf(v, 0) {
				t.Fatalf("valor no finito en iteración %d", i)
			}
		}
		if a["level"] < 0 || a["level"] > 100 || c["position"] < 0 || c["position"] > 100 || b["rpm"] < 0 || b["current"] < 0 {
			t.Fatalf("fuera de rango: %v %v %v", a, b, c)
		}
		maxLevel, minLevel = math.Max(maxLevel, a["level"]), math.Min(minLevel, a["level"])
		maxTemp, maxCurrent, maxPos = math.Max(maxTemp, a["temp"]), math.Max(maxCurrent, b["current"]), math.Max(maxPos, c["position"])
	}
	if maxLevel <= 90 || minLevel >= 10 || maxTemp <= 35 || maxCurrent <= 18 || maxPos <= 95 {
		t.Errorf("las excursiones no cruzaron umbrales: level %.1f..%.1f temp %.1f current %.1f pos %.1f",
			minLevel, maxLevel, maxTemp, maxCurrent, maxPos)
	}
}

func TestNoExcursionsStayNominal(t *testing.T) {
	rng := rand.New(rand.NewPCG(3, 4))
	tk, pm, vl := newTank(rng, 0), newPump(rng, 0), newValve(rng, 0)
	for i := 0; i < 20000; i++ {
		a, b, c := tk.step(1), pm.step(1), vl.step(1)
		if a["level"] > 90 || a["level"] < 10 || a["temp"] > 30 || b["current"] > 18 || c["position"] > 95 {
			t.Fatalf("cruzó umbral sin excursión en %d: %v %v %v", i, a, b, c)
		}
	}
}
