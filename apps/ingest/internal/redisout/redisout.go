// Package redisout publica el estado actual y los eventos en tiempo real en Redis.
package redisout

import (
	"context"
	"encoding/json"
	"strconv"

	"github.com/redis/go-redis/v9"

	"github.com/braianncampos/campo/apps/ingest/internal/parser"
)

type Writer struct {
	rdb redis.Cmdable
}

func New(rdb redis.Cmdable) *Writer { return &Writer{rdb: rdb} }

// Write hace HSET campo:state:{plant} + PUBLISH campo:events:{plant} por lectura,
// todo en un único viaje de red (pipeline).
func (w *Writer) Write(ctx context.Context, readings []parser.Reading) error {
	pipe := w.rdb.Pipeline()
	for i := range readings {
		r := &readings[i]
		state, err := json.Marshal(stateJSON{TS: r.TS, Values: r.Values, Quality: r.Quality.String()})
		if err != nil {
			continue // imposible con números finitos; no frenamos al resto del lote
		}
		pipe.HSet(ctx, "campo:state:"+r.Plant, r.Asset, state)
		pipe.Publish(ctx, "campo:events:"+r.Plant, Event(r, state))
	}
	_, err := pipe.Exec(ctx)
	return err
}

type stateJSON struct {
	TS      int64              `json:"ts"`
	Values  map[string]float64 `json:"values"`
	Quality string             `json:"quality"`
}

// Event construye el TelemetryEvent reutilizando el JSON del estado
// (TelemetryEvent = AssetState + type/plant/asset). plant y asset ya fueron
// validados contra el regex de IDs, así que no necesitan escape.
func Event(r *parser.Reading, state []byte) []byte {
	b := make([]byte, 0, len(state)+len(r.Plant)+len(r.Asset)+48)
	b = append(b, `{"type":"telemetry","plant":`...)
	b = strconv.AppendQuote(b, r.Plant)
	b = append(b, `,"asset":`...)
	b = strconv.AppendQuote(b, r.Asset)
	b = append(b, ',')
	return append(b, state[1:]...)
}
