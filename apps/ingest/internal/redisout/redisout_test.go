package redisout

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"

	"github.com/braianncampos/campo/apps/ingest/internal/parser"
)

func TestWriteStateAndEvent(t *testing.T) {
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { rdb.Close() })
	ctx := context.Background()

	sub := rdb.Subscribe(ctx, "campo:events:demo")
	t.Cleanup(func() { sub.Close() })
	if _, err := sub.Receive(ctx); err != nil { // confirmación de suscripción
		t.Fatal(err)
	}
	ch := sub.Channel()

	readings := []parser.Reading{
		{Plant: "demo", Asset: "tk-01", TS: 1730213000000, Values: map[string]float64{"level": 72.5, "temp": 18.2}, Quality: parser.Good},
		{Plant: "demo", Asset: "pump-01", TS: 1730213000001, Values: map[string]float64{"rpm": 1450}, Quality: parser.Bad},
	}
	if err := New(rdb).Write(ctx, readings); err != nil {
		t.Fatal(err)
	}

	// Estado: campo = asset, valor = {ts, values, quality}.
	var st struct {
		TS      int64              `json:"ts"`
		Values  map[string]float64 `json:"values"`
		Quality string             `json:"quality"`
	}
	if err := json.Unmarshal([]byte(mr.HGet("campo:state:demo", "tk-01")), &st); err != nil {
		t.Fatal(err)
	}
	if st.TS != 1730213000000 || st.Values["level"] != 72.5 || st.Values["temp"] != 18.2 || st.Quality != "good" {
		t.Errorf("estado inesperado: %+v", st)
	}
	if got := mr.HGet("campo:state:demo", "pump-01"); got != `{"ts":1730213000001,"values":{"rpm":1450},"quality":"bad"}` {
		t.Errorf("estado pump-01 = %s", got)
	}

	// Evento: TelemetryEvent completo, en orden.
	for i, want := range []string{"tk-01", "pump-01"} {
		select {
		case msg := <-ch:
			var ev struct {
				Type    string             `json:"type"`
				Plant   string             `json:"plant"`
				Asset   string             `json:"asset"`
				TS      int64              `json:"ts"`
				Values  map[string]float64 `json:"values"`
				Quality string             `json:"quality"`
			}
			if err := json.Unmarshal([]byte(msg.Payload), &ev); err != nil {
				t.Fatalf("evento %d no es JSON válido: %v (%s)", i, err, msg.Payload)
			}
			if ev.Type != "telemetry" || ev.Plant != "demo" || ev.Asset != want || ev.TS == 0 || len(ev.Values) == 0 || ev.Quality == "" {
				t.Errorf("evento %d inesperado: %s", i, msg.Payload)
			}
		case <-time.After(2 * time.Second):
			t.Fatalf("no llegó el evento %d", i)
		}
	}
}

func TestWriteFailsWhenRedisDown(t *testing.T) {
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr(), MaxRetries: -1})
	t.Cleanup(func() { rdb.Close() })
	mr.Close()

	r := parser.Reading{Plant: "demo", Asset: "a", TS: 1, Values: map[string]float64{"x": 1}}
	if err := New(rdb).Write(context.Background(), []parser.Reading{r}); err == nil {
		t.Fatal("se esperaba error con Redis caído")
	}
}

func TestEventIngestTs(t *testing.T) {
	r := parser.Reading{Plant: "demo", Asset: "tk-01", TS: 1730213000000, Values: map[string]float64{"level": 72.5}, IngestTs: 1730213000123}
	state := []byte(`{"ts":1730213000000,"values":{"level":72.5},"quality":"good"}`)
	got := string(Event(&r, state))
	want := `{"type":"telemetry","plant":"demo","asset":"tk-01","ts":1730213000000,"values":{"level":72.5},"quality":"good","ingestTs":1730213000123}`
	if got != want {
		t.Errorf("evento = %s", got)
	}
	var ev map[string]any
	if err := json.Unmarshal([]byte(got), &ev); err != nil || ev["ingestTs"] != float64(1730213000123) {
		t.Errorf("JSON inválido o sin ingestTs: %v %v", err, ev)
	}
	// Sin sello no se emite el campo.
	r.IngestTs = 0
	if got := string(Event(&r, state)); strings.Contains(got, "ingestTs") {
		t.Errorf("no debía emitir ingestTs: %s", got)
	}
}

func TestWriteEventCarriesIngestTsButStateDoesNot(t *testing.T) {
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { rdb.Close() })
	ctx := context.Background()
	sub := rdb.Subscribe(ctx, "campo:events:demo")
	t.Cleanup(func() { sub.Close() })
	if _, err := sub.Receive(ctx); err != nil {
		t.Fatal(err)
	}
	r := parser.Reading{Plant: "demo", Asset: "a", TS: 5, Values: map[string]float64{"x": 1}, IngestTs: 99}
	if err := New(rdb).Write(ctx, []parser.Reading{r}); err != nil {
		t.Fatal(err)
	}
	select {
	case msg := <-sub.Channel():
		var ev struct {
			IngestTs int64 `json:"ingestTs"`
		}
		if err := json.Unmarshal([]byte(msg.Payload), &ev); err != nil || ev.IngestTs != 99 {
			t.Errorf("evento = %s (%v)", msg.Payload, err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("no llegó el evento")
	}
	if strings.Contains(mr.HGet("campo:state:demo", "a"), "ingestTs") {
		t.Error("el estado no debe incluir ingestTs")
	}
}
