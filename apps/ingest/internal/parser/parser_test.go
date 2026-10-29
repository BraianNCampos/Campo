package parser

import (
	"strings"
	"testing"
	"time"
)

var now = time.UnixMilli(1730213000000)

func TestParseTopic(t *testing.T) {
	long := strings.Repeat("a", 64)
	tests := []struct {
		topic        string
		plant, asset string
		ok           bool
	}{
		{"campo/v1/demo/tk-01/telemetry", "demo", "tk-01", true},
		{"campo/v1/p_1/a0/telemetry", "p_1", "a0", true},
		{"campo/v1/" + long + "/" + long + "/telemetry", long, long, true},
		{"campo/v1/" + long + "a/x/telemetry", "", "", false}, // 65 chars
		{"campo/v1/demo/tk-01/cmd", "", "", false},
		{"campo/v2/demo/tk-01/telemetry", "", "", false},
		{"campo/v1/demo/telemetry", "", "", false},
		{"campo/v1/demo/tk/01/telemetry", "", "", false},
		{"campo/v1//tk-01/telemetry", "", "", false},
		{"campo/v1/demo//telemetry", "", "", false},
		{"campo/v1/Demo/tk-01/telemetry", "", "", false},
		{"campo/v1/demo/-tk/telemetry", "", "", false},
		{"campo/v1/demo/_tk/telemetry", "", "", false},
		{"campo/v1/de mo/tk/telemetry", "", "", false},
		{"campo/v1/demo/tk-ñ/telemetry", "", "", false},
		{"campo/v1/+/+/telemetry", "", "", false},
		{"", "", "", false},
	}
	for _, tc := range tests {
		plant, asset, ok := ParseTopic(tc.topic)
		if ok != tc.ok || plant != tc.plant || asset != tc.asset {
			t.Errorf("ParseTopic(%q) = %q,%q,%v; quería %q,%q,%v", tc.topic, plant, asset, ok, tc.plant, tc.asset, tc.ok)
		}
	}
}

func TestParse(t *testing.T) {
	const topic = "campo/v1/demo/tk-01/telemetry"
	nowMs := now.UnixMilli()
	tests := []struct {
		name      string
		topic     string
		payload   string
		reason    Reason
		ts        int64
		values    map[string]float64
		quality   Quality
		discarded int
	}{
		{name: "completo", payload: `{"ts":1730213000123,"values":{"level":72.5,"temp":18.2},"quality":"good"}`,
			ts: 1730213000123, values: map[string]float64{"level": 72.5, "temp": 18.2}},
		{name: "ts ausente usa recepción", payload: `{"values":{"a":1}}`,
			ts: nowMs, values: map[string]float64{"a": 1}},
		{name: "ts null usa recepción", payload: `{"ts":null,"values":{"a":1}}`,
			ts: nowMs, values: map[string]float64{"a": 1}},
		{name: "ts string usa recepción", payload: `{"ts":"1730213000000","values":{"a":1}}`,
			ts: nowMs, values: map[string]float64{"a": 1}},
		{name: "ts futuro >24h", payload: `{"ts":1730400000001,"values":{"a":1}}`,
			ts: nowMs, values: map[string]float64{"a": 1}},
		{name: "ts pasado >24h", payload: `{"ts":1730100000000,"values":{"a":1}}`,
			ts: nowMs, values: map[string]float64{"a": 1}},
		{name: "ts en el límite de 24h", payload: `{"ts":1730126600000,"values":{"a":1}}`,
			ts: 1730126600000, values: map[string]float64{"a": 1}},
		{name: "ts en segundos queda fuera de rango", payload: `{"ts":1730213000,"values":{"a":1}}`,
			ts: nowMs, values: map[string]float64{"a": 1}},
		{name: "ts fraccional", payload: `{"ts":1730213000000.9,"values":{"a":1}}`,
			ts: 1730213000000, values: map[string]float64{"a": 1}},
		{name: "quality uncertain", payload: `{"values":{"a":1},"quality":"uncertain"}`,
			ts: nowMs, values: map[string]float64{"a": 1}, quality: Uncertain},
		{name: "quality bad", payload: `{"values":{"a":1},"quality":"bad"}`,
			ts: nowMs, values: map[string]float64{"a": 1}, quality: Bad},
		{name: "quality null = good", payload: `{"values":{"a":1},"quality":null}`,
			ts: nowMs, values: map[string]float64{"a": 1}},
		{name: "quality desconocida", payload: `{"values":{"a":1},"quality":"great"}`, reason: ReasonBadQuality},
		{name: "quality mayúsculas", payload: `{"values":{"a":1},"quality":"GOOD"}`, reason: ReasonBadQuality},
		{name: "quality numérica", payload: `{"values":{"a":1},"quality":1}`, reason: ReasonBadQuality},
		{name: "valores no numéricos se descartan", payload: `{"values":{"a":1,"b":"2","c":true,"d":null,"e":{"x":1},"f":[1],"g":-3.5e2}}`,
			ts: nowMs, values: map[string]float64{"a": 1, "g": -350}, discarded: 5},
		{name: "overflow float se descarta", payload: `{"values":{"a":1,"b":1e999,"c":-1e999}}`,
			ts: nowMs, values: map[string]float64{"a": 1}, discarded: 2},
		{name: "cero y negativos", payload: `{"values":{"a":0,"b":-0.5}}`,
			ts: nowMs, values: map[string]float64{"a": 0, "b": -0.5}},
		{name: "values vacío", payload: `{"values":{}}`, reason: ReasonNoValues},
		{name: "values ausente", payload: `{"ts":1730213000000}`, reason: ReasonNoValues},
		{name: "values todos inválidos", payload: `{"values":{"a":"x"}}`, reason: ReasonNoValues},
		{name: "values no es objeto", payload: `{"values":[1,2]}`, reason: ReasonBadJSON},
		{name: "json inválido", payload: `{"values":`, reason: ReasonBadJSON},
		{name: "raíz no objeto", payload: `[1]`, reason: ReasonBadJSON},
		{name: "vacío", payload: ``, reason: ReasonBadJSON},
		{name: "NaN literal no es JSON", payload: `{"values":{"a":NaN}}`, reason: ReasonBadJSON},
		{name: "tópico inválido", topic: "campo/v1/DEMO/x/telemetry", payload: `{"values":{"a":1}}`, reason: ReasonBadTopic},
		{name: "demasiado grande", payload: `{"values":{"a":1},"pad":"` + strings.Repeat("x", MaxPayloadBytes) + `"}`, reason: ReasonTooLarge},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			tp := tc.topic
			if tp == "" {
				tp = topic
			}
			r, reason := Parse(tp, []byte(tc.payload), now)
			if reason != tc.reason {
				t.Fatalf("reason = %q, quería %q", reason, tc.reason)
			}
			if reason != ReasonNone {
				return
			}
			if r.Plant != "demo" || r.Asset != "tk-01" {
				t.Errorf("plant/asset = %q/%q", r.Plant, r.Asset)
			}
			if r.TS != tc.ts {
				t.Errorf("ts = %d, quería %d", r.TS, tc.ts)
			}
			if r.Quality != tc.quality {
				t.Errorf("quality = %v, quería %v", r.Quality, tc.quality)
			}
			if r.Discarded != tc.discarded {
				t.Errorf("discarded = %d, quería %d", r.Discarded, tc.discarded)
			}
			if len(r.Values) != len(tc.values) {
				t.Fatalf("values = %v, quería %v", r.Values, tc.values)
			}
			for k, want := range tc.values {
				if got, ok := r.Values[k]; !ok || got != want {
					t.Errorf("values[%q] = %v,%v; quería %v", k, got, ok, want)
				}
			}
		})
	}
}

func BenchmarkParse(b *testing.B) {
	payload := []byte(`{"ts":1730213000123,"values":{"level":72.5,"temp":18.2},"quality":"good"}`)
	const topic = "campo/v1/demo/tk-01/telemetry"
	b.ReportAllocs()
	b.SetBytes(int64(len(payload)))
	for b.Loop() {
		if _, reason := Parse(topic, payload, now); reason != ReasonNone {
			b.Fatal(reason)
		}
	}
}

func BenchmarkParseTopic(b *testing.B) {
	b.ReportAllocs()
	for b.Loop() {
		ParseTopic("campo/v1/demo/tk-01/telemetry")
	}
}
