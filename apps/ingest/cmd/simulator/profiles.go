package main

import (
	"fmt"
	"hash/fnv"
	"math/rand/v2"
	"time"
)

// model es un generador de valores: dado el estado previo (el propio struct) y dt
// segundos devuelve el siguiente mapa métrica -> valor.
type model interface {
	step(dt float64) map[string]float64
}

type asset struct {
	id    string
	model model
}

// profile reúne lo que una planta necesita para construir sus activos.
type profile struct {
	seed      uint64
	meanExc   float64   // segundos entre excursiones; <= 0 las desactiva
	start     time.Time // hora de arranque del reloj simulado (ciclo diario del clima)
	tanks     int       // -tanks / -pumps / -valves: escalan el perfil heredado
	pumps     int
	valves    int
	plantName string
}

// rngFor da a cada activo un generador propio y estable (no depende del orden ni de otras plantas).
func (p profile) rngFor(id string) *rand.Rand {
	h := fnv.New64a()
	h.Write([]byte(p.plantName + "/" + id))
	return rand.New(rand.NewPCG(p.seed, h.Sum64()))
}

// legacy genera tk-NN, pump-NN y valve-NN (los 8 activos históricos con los valores por defecto).
func (p profile) legacy() []asset {
	var out []asset
	for i := 1; i <= p.tanks; i++ {
		id := fmt.Sprintf("tk-%02d", i)
		out = append(out, asset{id, newTank(p.rngFor(id), p.meanExc)})
	}
	for i := 1; i <= p.pumps; i++ {
		id := fmt.Sprintf("pump-%02d", i)
		out = append(out, asset{id, newPump(p.rngFor(id), p.meanExc)})
	}
	for i := 1; i <= p.valves; i++ {
		id := fmt.Sprintf("valve-%02d", i)
		out = append(out, asset{id, newValve(p.rngFor(id), p.meanExc)})
	}
	return out
}

// buildAssets devuelve los activos que publica una planta:
//
//	demo     heredados (escalables) + clima, energía, gas, máquinas, presión y caudal (§11.3)
//	tanques  tk-a, tk-b
//	otra     sólo los heredados (compatibilidad con -plant <id> de versiones anteriores)
func buildAssets(plant string, p profile) []asset {
	p.plantName = plant
	switch plant {
	case "tanques":
		return []asset{
			{"tk-a", newTank(p.rngFor("tk-a"), p.meanExc)},
			{"tk-b", newTank(p.rngFor("tk-b"), p.meanExc)},
		}
	case "demo":
		out := p.legacy()
		return append(out,
			asset{"clima-01", newClimate(p.rngFor("clima-01"), p.start, 21, 4.5)},
			asset{"clima-02", newClimate(p.rngFor("clima-02"), p.start, 19, 3.5)},
			asset{"en-linea1", newEnergy(p.rngFor("en-linea1"), profLinea1)},
			asset{"en-compresores", newEnergy(p.rngFor("en-compresores"), profCompresores)},
			asset{"en-clima", newEnergy(p.rngFor("en-clima"), profClima)},
			asset{"en-calderas", newEnergy(p.rngFor("en-calderas"), profCalderas)},
			asset{"gas-01", newGas(p.rngFor("gas-01"))},
			asset{"maq-01", newMachine(p.rngFor("maq-01"), 0.85, 1500, 300)},
			asset{"maq-02", newMachine(p.rngFor("maq-02"), 0.7, 900, 400)},
			asset{"maq-03", newMachine(p.rngFor("maq-03"), 0.5, 600, 600)},
			asset{"pres-01", newPressure(p.rngFor("pres-01"), p.meanExc)},
			asset{"cau-01", newFlowMeter(p.rngFor("cau-01"))},
		)
	default:
		return p.legacy()
	}
}
