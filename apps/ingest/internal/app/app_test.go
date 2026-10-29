package app

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	mochi "github.com/mochi-mqtt/server/v2"
	"github.com/mochi-mqtt/server/v2/hooks/auth"
	"github.com/mochi-mqtt/server/v2/listeners"
	"github.com/redis/go-redis/v9"

	"github.com/braianncampos/campo/apps/ingest/internal/config"
	"github.com/braianncampos/campo/apps/ingest/internal/tsdb"
)

type memHistory struct {
	mu   sync.Mutex
	rows []tsdb.Row
}

func (h *memHistory) WriteRows(_ context.Context, rows []tsdb.Row) error {
	h.mu.Lock()
	h.rows = append(h.rows, rows...)
	h.mu.Unlock()
	return nil
}

func (h *memHistory) snapshot() []tsdb.Row {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]tsdb.Row(nil), h.rows...)
}

func freeAddr(t *testing.T) string {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	return l.Addr().String()
}

// startBroker levanta un broker MQTT embebido (sin Docker) en addr.
func startBroker(t *testing.T, addr string) *mochi.Server {
	t.Helper()
	s := mochi.New(&mochi.Options{InlineClient: true, Logger: quietLogger()})
	_ = s.AddHook(new(auth.AllowHook), nil)
	if err := s.AddListener(listeners.NewTCP(listeners.Config{ID: "t", Address: addr})); err != nil {
		t.Fatal(err)
	}
	go s.Serve()
	t.Cleanup(func() { s.Close() })
	return s
}

func testConfig(t *testing.T, brokerAddr, redisAddr string, extra map[string]string) config.Config {
	t.Helper()
	env := map[string]string{
		"MQTT_BROKER_URL":    "tcp://" + brokerAddr,
		"MQTT_CLIENT_ID":     "ingest-test",
		"MQTT_CLEAN_SESSION": "true",
		"REDIS_URL":          "redis://" + redisAddr + "/0",
		"DATABASE_URL":       "",
		"HTTP_ADDR":          "127.0.0.1:0",
		"INGEST_WORKERS":     "2",
		"BATCH_SIZE":         "100000",
		"FLUSH_INTERVAL":     "1h", // el flush ocurre sólo al cerrar
		"REDIS_TIMEOUT":      "500ms",
	}
	for k, v := range extra {
		env[k] = v
	}
	cfg, err := config.Load(func(k string) string { return env[k] })
	if err != nil {
		t.Fatal(err)
	}
	return cfg
}

func get(t *testing.T, url string) (int, string) {
	t.Helper()
	resp, err := http.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(b)
}

func eventually(t *testing.T, timeout time.Duration, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timeout esperando: %s", what)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func quietLogger() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

func TestEndToEnd(t *testing.T) {
	mr := miniredis.RunT(t)
	brokerAddr := freeAddr(t)
	broker := startBroker(t, brokerAddr)
	hist := &memHistory{}

	a, err := New(context.Background(), testConfig(t, brokerAddr, mr.Addr(), nil), quietLogger(), WithHistoryWriter(hist))
	if err != nil {
		t.Fatal(err)
	}
	a.Start()
	base := "http://" + a.HTTPAddr()

	eventually(t, 5*time.Second, "readyz 200", func() bool {
		code, _ := get(t, base+"/readyz")
		return code == 200
	})
	if code, _ := get(t, base+"/healthz"); code != 200 {
		t.Fatalf("healthz = %d", code)
	}

	// Suscriptor del tiempo real, como haría la API.
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	defer rdb.Close()
	sub := rdb.Subscribe(context.Background(), "campo:events:demo")
	defer sub.Close()
	if _, err := sub.Receive(context.Background()); err != nil {
		t.Fatal(err)
	}

	now := time.Now().UnixMilli()
	pub := func(topic, payload string) {
		t.Helper()
		if err := broker.Publish(topic, []byte(payload), false, 1); err != nil {
			t.Fatal(err)
		}
	}
	pub("campo/v1/demo/tk-01/telemetry", fmt.Sprintf(`{"ts":%d,"values":{"level":72.5,"temp":18.2},"quality":"good"}`, now))
	pub("campo/v1/demo/pump-01/telemetry", `{"values":{"rpm":1450,"current":12.5,"junk":"x"},"quality":"uncertain"}`)
	pub("campo/v1/DEMO/x/telemetry", `{"values":{"a":1}}`) // tópico inválido que pasa el filtro MQTT
	pub("campo/v1/demo/tk-02/telemetry", `{"values":`)     // JSON inválido

	// Los workers no garantizan orden entre activos: se esperan los dos eventos válidos, en cualquier orden.
	seen := map[string]bool{}
	for len(seen) < 2 {
		select {
		case msg := <-sub.Channel():
			var ev map[string]any
			if err := json.Unmarshal([]byte(msg.Payload), &ev); err != nil {
				t.Fatal(err)
			}
			asset, _ := ev["asset"].(string)
			if ev["type"] != "telemetry" || ev["plant"] != "demo" || (asset != "tk-01" && asset != "pump-01") {
				t.Errorf("evento inesperado: %s", msg.Payload)
			}
			seen[asset] = true
		case <-time.After(5 * time.Second):
			t.Fatalf("eventos recibidos por pub/sub: %v, faltan", seen)
		}
	}

	eventually(t, 5*time.Second, "estado en Redis", func() bool {
		return mr.HGet("campo:state:demo", "tk-01") != "" && mr.HGet("campo:state:demo", "pump-01") != ""
	})
	var st struct {
		TS      int64              `json:"ts"`
		Values  map[string]float64 `json:"values"`
		Quality string             `json:"quality"`
	}
	if err := json.Unmarshal([]byte(mr.HGet("campo:state:demo", "tk-01")), &st); err != nil {
		t.Fatal(err)
	}
	if st.TS != now || st.Values["level"] != 72.5 || st.Quality != "good" {
		t.Errorf("estado tk-01 = %+v", st)
	}
	if mr.HGet("campo:state:demo", "tk-02") != "" {
		t.Error("el mensaje inválido no debía llegar a Redis")
	}

	eventually(t, 5*time.Second, "métricas de descarte", func() bool {
		_, body := get(t, base+"/metrics")
		return strings.Contains(body, `ingest_dropped_total{reason="bad_topic"} 1`) &&
			strings.Contains(body, `ingest_dropped_total{reason="bad_json"} 1`)
	})
	_, body := get(t, base+"/metrics")
	for _, want := range []string{
		"ingest_messages_received_total 4",
		"ingest_values_discarded_total 1",
		"ingest_redis_latency_seconds_count 2",
		`ingest_queue_length{queue="live"}`,
		`ingest_queue_length{queue="history"}`,
	} {
		if !strings.Contains(body, want) {
			t.Errorf("/metrics no contiene %q", want)
		}
	}

	// El histórico sólo se escribe en el cierre (FLUSH_INTERVAL=1h): prueba el flush final.
	if n := len(hist.snapshot()); n != 0 {
		t.Fatalf("filas antes del cierre = %d", n)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := a.Shutdown(ctx); err != nil {
		t.Fatal(err)
	}

	rows := hist.snapshot()
	if len(rows) != 4 { // level,temp + rpm,current
		t.Fatalf("filas históricas = %d, quería 4: %+v", len(rows), rows)
	}
	byMetric := map[string]tsdb.Row{}
	for _, r := range rows {
		byMetric[r.Asset+"/"+r.Metric] = r
	}
	if r := byMetric["tk-01/level"]; r.Value != 72.5 || r.Plant != "demo" || r.Quality != 0 || r.Time.UnixMilli() != now {
		t.Errorf("fila tk-01/level = %+v", r)
	}
	if r := byMetric["pump-01/rpm"]; r.Value != 1450 || r.Quality != 1 {
		t.Errorf("fila pump-01/rpm = %+v", r)
	}
}

// Arrancar sin broker ni Redis no mata el proceso; al aparecer, el servicio se recupera solo.
func TestStartsWithoutDependenciesAndRecovers(t *testing.T) {
	mr := miniredis.RunT(t)
	redisAddr := mr.Addr()
	mr.Close()
	brokerAddr := freeAddr(t)
	hist := &memHistory{}

	a, err := New(context.Background(), testConfig(t, brokerAddr, redisAddr, nil), quietLogger(), WithHistoryWriter(hist))
	if err != nil {
		t.Fatalf("New debía tolerar dependencias caídas: %v", err)
	}
	a.Start()
	base := "http://" + a.HTTPAddr()

	code, body := get(t, base+"/readyz")
	if code != http.StatusServiceUnavailable || !strings.Contains(body, `"ready":false`) {
		t.Fatalf("readyz = %d %s, quería 503", code, body)
	}
	if code, _ := get(t, base+"/healthz"); code != 200 {
		t.Fatalf("healthz = %d, el proceso debe seguir vivo", code)
	}

	broker := startBroker(t, brokerAddr)
	if err := mr.Restart(); err != nil {
		t.Fatal(err)
	}
	eventually(t, 15*time.Second, "readyz tras recuperar dependencias", func() bool {
		code, _ := get(t, base+"/readyz")
		return code == 200
	})

	if err := broker.Publish("campo/v1/demo/tk-01/telemetry", []byte(`{"values":{"level":50}}`), false, 1); err != nil {
		t.Fatal(err)
	}
	eventually(t, 5*time.Second, "estado en Redis tras recuperación", func() bool {
		return mr.HGet("campo:state:demo", "tk-01") != ""
	})

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := a.Shutdown(ctx); err != nil {
		t.Fatal(err)
	}
	if len(hist.snapshot()) != 1 {
		t.Errorf("filas históricas = %d, quería 1", len(hist.snapshot()))
	}
}

// Una CA ilegible debe impedir el arranque (fallar pronto), no degradarse a "sin verificación".
func TestNewFailsOnUnreadableMQTTCA(t *testing.T) {
	mr := miniredis.RunT(t)
	cfg := testConfig(t, "localhost:8883", mr.Addr(), map[string]string{
		"MQTT_BROKER_URL": "ssl://localhost:8883", "MQTT_CA_FILE": "/no/existe/ca.crt",
	})
	if a, err := New(context.Background(), cfg, quietLogger(), WithHistoryWriter(&memHistory{})); err == nil {
		_ = a.Shutdown(context.Background())
		t.Fatal("New debería fallar con MQTT_CA_FILE ilegible")
	} else if !strings.Contains(err.Error(), "MQTT_CA_FILE") {
		t.Fatalf("error poco claro: %v", err)
	}
}
