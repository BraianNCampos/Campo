package config

import (
	"testing"
	"time"
)

func env(m map[string]string) func(string) string {
	return func(k string) string { return m[k] }
}

func TestLoadDefaults(t *testing.T) {
	c, err := Load(env(nil))
	if err != nil {
		t.Fatal(err)
	}
	if c.MQTTTopic != "campo/v1/+/+/telemetry" || c.HTTPAddr != ":8080" || c.BatchSize != 5000 {
		t.Fatalf("defaults inesperados: %+v", c)
	}
}

func TestLoadOverridesAndErrors(t *testing.T) {
	c, err := Load(env(map[string]string{"BATCH_SIZE": "10", "FLUSH_INTERVAL": "250ms", "MQTT_CLEAN_SESSION": "true"}))
	if err != nil {
		t.Fatal(err)
	}
	if c.BatchSize != 10 || c.FlushInterval != 250*time.Millisecond || !c.MQTTCleanSession {
		t.Fatalf("overrides no aplicados: %+v", c)
	}

	for name, m := range map[string]map[string]string{
		"entero inválido":    {"INGEST_WORKERS": "x"},
		"duración inválida":  {"FLUSH_INTERVAL": "rápido"},
		"qos fuera de rango": {"MQTT_QOS": "3"},
		"batch cero":         {"BATCH_SIZE": "0"},
		"formato de log":     {"LOG_FORMAT": "xml"},
	} {
		if _, err := Load(env(m)); err == nil {
			t.Errorf("%s: se esperaba error", name)
		}
	}
}
