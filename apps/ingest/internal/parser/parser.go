// Package parser valida tópicos y payloads MQTT según el contrato de
// docs/architecture.md (sección 1). No tiene dependencias del resto del servicio.
package parser

import (
	"bytes"
	"encoding/json"
	"math"
	"strconv"
	"strings"
	"time"
)

const (
	// MaxPayloadBytes acota el trabajo por mensaje; los payloads reales son < 1 KiB.
	MaxPayloadBytes = 64 * 1024
	// MaxClockSkew es la desviación máxima aceptada de `ts` respecto al reloj del servidor.
	MaxClockSkew = 24 * time.Hour
)

// Reason explica por qué se descartó un mensaje; es la etiqueta de ingest_dropped_total.
type Reason string

const (
	ReasonNone         Reason = ""
	ReasonBadTopic     Reason = "bad_topic"
	ReasonTooLarge     Reason = "payload_too_large"
	ReasonBadJSON      Reason = "bad_json"
	ReasonBadQuality   Reason = "bad_quality"
	ReasonNoValues     Reason = "no_valid_values"
	ReasonLiveQueue    Reason = "live_queue_full"
	ReasonShuttingDown Reason = "shutting_down"
)

// Quality coincide con la columna SMALLINT de telemetry.
type Quality int16

const (
	Good Quality = iota
	Uncertain
	Bad
)

func (q Quality) String() string {
	switch q {
	case Uncertain:
		return "uncertain"
	case Bad:
		return "bad"
	default:
		return "good"
	}
}

// Reading es una lectura ya validada de un activo.
type Reading struct {
	Plant     string
	Asset     string
	TS        int64 // epoch ms
	Values    map[string]float64
	Quality   Quality
	Discarded int // valores no numéricos o no finitos descartados
}

// ValidID implementa ^[a-z0-9][a-z0-9_-]{0,63}$ sin regexp (ruta caliente).
func ValidID(s string) bool {
	if len(s) == 0 || len(s) > 64 {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c >= 'a' && c <= 'z', c >= '0' && c <= '9':
		case (c == '_' || c == '-') && i > 0:
		default:
			return false
		}
	}
	return true
}

// ParseTopic extrae plant y asset de campo/v1/{plant}/{asset}/telemetry.
func ParseTopic(topic string) (plant, asset string, ok bool) {
	rest, found := strings.CutPrefix(topic, "campo/v1/")
	if !found {
		return "", "", false
	}
	rest, found = strings.CutSuffix(rest, "/telemetry")
	if !found {
		return "", "", false
	}
	plant, asset, found = strings.Cut(rest, "/")
	if !found || !ValidID(plant) || !ValidID(asset) {
		return "", "", false
	}
	return plant, asset, true
}

type rawPayload struct {
	TS      json.RawMessage            `json:"ts"`
	Values  map[string]json.RawMessage `json:"values"`
	Quality json.RawMessage            `json:"quality"`
}

// Parse valida tópico y payload. Devuelve ReasonNone si la lectura es válida.
// `now` es la hora de recepción, usada cuando `ts` falta o está fuera de rango.
func Parse(topic string, payload []byte, now time.Time) (Reading, Reason) {
	plant, asset, ok := ParseTopic(topic)
	if !ok {
		return Reading{}, ReasonBadTopic
	}
	if len(payload) > MaxPayloadBytes {
		return Reading{}, ReasonTooLarge
	}

	var raw rawPayload
	if err := json.Unmarshal(payload, &raw); err != nil {
		return Reading{}, ReasonBadJSON
	}

	r := Reading{Plant: plant, Asset: asset, TS: sanitizeTS(raw.TS, now)}

	q, ok := parseQuality(raw.Quality)
	if !ok {
		return Reading{}, ReasonBadQuality
	}
	r.Quality = q

	r.Values = make(map[string]float64, len(raw.Values))
	for k, v := range raw.Values {
		f, ok := number(v)
		if !ok {
			r.Discarded++
			continue
		}
		r.Values[k] = f
	}
	if len(r.Values) == 0 {
		return Reading{}, ReasonNoValues
	}
	return r, ReasonNone
}

// sanitizeTS devuelve el ts del payload o la hora de recepción si falta,
// no es un número finito o se desvía más de ±24 h.
func sanitizeTS(raw json.RawMessage, now time.Time) int64 {
	nowMs := now.UnixMilli()
	f, ok := number(raw)
	if !ok {
		return nowMs
	}
	if math.Abs(f-float64(nowMs)) > float64(MaxClockSkew.Milliseconds()) {
		return nowMs
	}
	return int64(f)
}

// number interpreta un valor JSON como número finito; los strings, booleanos,
// null, objetos, NaN e Infinity se rechazan.
func number(raw json.RawMessage) (float64, bool) {
	if len(raw) == 0 {
		return 0, false
	}
	if c := raw[0]; c != '-' && (c < '0' || c > '9') {
		return 0, false
	}
	f, err := strconv.ParseFloat(string(raw), 64)
	if err != nil || math.IsInf(f, 0) || math.IsNaN(f) {
		return 0, false
	}
	return f, true
}

func isNull(raw json.RawMessage) bool { return bytes.Equal(raw, []byte("null")) }

// parseQuality: ausente o null = good; cualquier otro valor distinto de los
// tres permitidos hace inválido el mensaje.
func parseQuality(raw json.RawMessage) (Quality, bool) {
	if len(raw) == 0 || isNull(raw) {
		return Good, true
	}
	var s string
	if json.Unmarshal(raw, &s) != nil {
		return Good, false
	}
	switch s {
	case "good":
		return Good, true
	case "uncertain":
		return Uncertain, true
	case "bad":
		return Bad, true
	}
	return Good, false
}
