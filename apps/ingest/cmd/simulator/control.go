package main

import (
	"encoding/json"
	"math"
	"strings"
	"sync"
	"time"
)

// Control de llenado (§14.3 puntos 5-6 y §14.4 de docs/architecture.md).
//
// La API publica órdenes en campo/v1/{planta}/{activo}/cmd con {id, command, target?, ts, by}; el simulador
// (el "equipo") responde en .../cmd/ack con {id, status, reason?, ts}:
//
//	accepted -> running -> done        (camino feliz; "running" sale en cuanto empieza a actuar)
//	rejected (reason)                  (la orden no aplica; no cambia nada)
//	failed   (reason)                  (la orden en curso se interrumpió, p. ej. por un stop)
//
// La lógica es pura (sin MQTT ni reloj propio): handleCommand valida y delega en el modelo; los modelos
// controlables (tanque/silo, bomba, válvula) acumulan los acks —los inmediatos y los que genera step al
// completar— y el bucle del activo los recoge con takeAcks y los publica en orden.

const (
	// maxCmdAge: las órdenes más viejas que esto se ignoran (rejected/stale), §14.3 punto 5.
	maxCmdAge = 30 * time.Second
	// maxSeenIDs: ids recientes recordados por activo para ignorar reentregas QoS 1 duplicadas.
	maxSeenIDs = 16

	statusAccepted = "accepted"
	statusRunning  = "running"
	statusDone     = "done"
	statusRejected = "rejected"
	statusFailed   = "failed"

	// Motivos de rechazo/fallo (ack.reason).
	reasonStale       = "stale"
	reasonBadRequest  = "bad_request"
	reasonUnsupported = "unsupported_command"
	reasonBadTarget   = "invalid_target"
	reasonAtTarget    = "already_at_target"
	reasonBusy        = "busy"
	reasonStopped     = "stopped"
)

// command es la orden recibida. target y ts llegan como JSON crudo para poder rechazar con motivo
// (en vez de descartar en silencio) cuando tienen un tipo inesperado.
type command struct {
	ID      string          `json:"id"`
	Command string          `json:"command"`
	Target  json.RawMessage `json:"target,omitempty"`
	TS      json.RawMessage `json:"ts"`
	By      string          `json:"by,omitempty"`
}

// ack es una respuesta pendiente de publicar; el ts lo pone quien publica.
type ack struct {
	ID     string
	Status string
	Reason string
}

// ackPayload es el JSON de campo/v1/{planta}/{activo}/cmd/ack.
type ackPayload struct {
	ID     string `json:"id"`
	Status string `json:"status"`
	Reason string `json:"reason,omitempty"`
	TS     int64  `json:"ts"`
}

func (a ack) payload(now time.Time) ackPayload {
	return ackPayload{ID: a.ID, Status: a.Status, Reason: a.Reason, TS: now.UnixMilli()}
}

func jsonNumber(raw json.RawMessage) (float64, bool) {
	if len(raw) == 0 {
		return 0, false
	}
	var f float64
	if json.Unmarshal(raw, &f) != nil || math.IsNaN(f) || math.IsInf(f, 0) {
		return 0, false
	}
	return f, true
}

// target devuelve el objetivo numérico de la orden, si lo trae y es un número finito.
func (c command) target() (float64, bool) { return jsonNumber(c.Target) }

// ctl es el estado común de los modelos controlables: cola de acks y ids recientes.
type ctl struct {
	out  []ack
	seen []string
}

func (c *ctl) control() *ctl { return c }

func (c *ctl) emit(id, status, reason string) {
	c.out = append(c.out, ack{ID: id, Status: status, Reason: reason})
}

// takeAcks devuelve (y vacía) los acks acumulados, en el orden en que se generaron.
func (c *ctl) takeAcks() []ack {
	if len(c.out) == 0 {
		return nil
	}
	out := c.out
	c.out = nil
	return out
}

// duplicate registra el id y dice si ya se había visto (reentrega de un QoS 1).
func (c *ctl) duplicate(id string) bool {
	for _, s := range c.seen {
		if s == id {
			return true
		}
	}
	if len(c.seen) >= maxSeenIDs {
		c.seen = c.seen[1:]
	}
	c.seen = append(c.seen, id)
	return false
}

// controllable es un modelo que acepta órdenes.
type controllable interface {
	model
	control() *ctl
	// apply ejecuta una orden ya validada (id, ts vigente, comando no vacío) y emite sus acks.
	apply(c command)
}

// handleCommand valida la orden contra el reloj `now` y la aplica al modelo. Devuelve los acks en orden
// (incluye los que step haya dejado pendientes). Una reentrega del mismo id no produce acks.
func handleCommand(m model, c command, now time.Time) []ack {
	cm, ok := m.(controllable)
	if !ok {
		return []ack{{ID: c.ID, Status: statusRejected, Reason: reasonUnsupported}}
	}
	st := cm.control()
	if st.duplicate(c.ID) {
		return st.takeAcks()
	}
	ts, tsOK := jsonNumber(c.TS)
	switch {
	case !tsOK || ts <= 0 || strings.TrimSpace(c.Command) == "":
		st.emit(c.ID, statusRejected, reasonBadRequest)
	case now.UnixMilli()-int64(ts) > maxCmdAge.Milliseconds():
		st.emit(c.ID, statusRejected, reasonStale)
	default:
		cm.apply(c)
	}
	return st.takeAcks()
}

// pendingAcks recoge los acks que dejó step en un modelo controlable (nil si no lo es).
func pendingAcks(m model) []ack {
	if cm, ok := m.(controllable); ok {
		return cm.control().takeAcks()
	}
	return nil
}

// commandRouter reparte las órdenes recibidas por MQTT a la goroutine de cada activo.
type commandRouter struct {
	mu     sync.RWMutex
	routes map[string]chan command // "planta/activo"
}

func newCommandRouter() *commandRouter { return &commandRouter{routes: map[string]chan command{}} }

func (r *commandRouter) register(plant, asset string, ch chan command) {
	r.mu.Lock()
	r.routes[plant+"/"+asset] = ch
	r.mu.Unlock()
}

// cmdRoute extrae planta y activo de campo/v1/{planta}/{activo}/cmd.
func cmdRoute(topic string) (plant, asset string, ok bool) {
	rest, found := strings.CutPrefix(topic, "campo/v1/")
	if !found {
		return "", "", false
	}
	rest, found = strings.CutSuffix(rest, "/cmd")
	if !found {
		return "", "", false
	}
	plant, asset, found = strings.Cut(rest, "/")
	if !found || plant == "" || asset == "" || strings.Contains(asset, "/") {
		return "", "", false
	}
	return plant, asset, true
}

// dispatch decodifica la orden y la encola para su activo sin bloquear (se llama desde el callback
// MQTT). Devuelve false si se descartó: tópico o JSON inválido, sin id, activo desconocido o cola llena.
func (r *commandRouter) dispatch(topic string, payload []byte) (command, bool) {
	plant, asset, ok := cmdRoute(topic)
	if !ok {
		return command{}, false
	}
	var c command
	if json.Unmarshal(payload, &c) != nil || c.ID == "" || len(c.ID) > 128 {
		return command{}, false // sin id no hay a quién responder
	}
	r.mu.RLock()
	ch := r.routes[plant+"/"+asset]
	r.mu.RUnlock()
	if ch == nil {
		return c, false
	}
	select {
	case ch <- c:
		return c, true
	default:
		return c, false
	}
}
