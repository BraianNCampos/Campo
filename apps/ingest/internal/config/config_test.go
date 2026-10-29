package config

import (
	"fmt"
	"strings"
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

func TestMQTTTLSOptions(t *testing.T) {
	c, err := Load(env(map[string]string{
		"MQTT_BROKER_URL": "ssl://mosquitto:8883", "MQTT_USERNAME": "ingest",
		"MQTT_PASSWORD": "s3creto-ultra", "MQTT_CA_FILE": "/run/secrets/ca.crt",
	}))
	if err != nil {
		t.Fatal(err)
	}
	if c.MQTTUsername != "ingest" || c.MQTTPassword != "s3creto-ultra" || c.MQTTCAFile != "/run/secrets/ca.crt" {
		t.Fatalf("opciones MQTT no cargadas: %+v", c)
	}

	// CA propia con URL en claro: error de configuración (falsa sensación de cifrado).
	if _, err := Load(env(map[string]string{"MQTT_BROKER_URL": "tcp://mosquitto:1883", "MQTT_CA_FILE": "/ca.crt"})); err == nil {
		t.Error("MQTT_CA_FILE con tcp:// debería fallar")
	}
	// Sin CA y en claro (desarrollo) sigue siendo válido.
	if _, err := Load(env(map[string]string{"MQTT_BROKER_URL": "tcp://localhost:1883"})); err != nil {
		t.Errorf("desarrollo en claro debería seguir valiendo: %v", err)
	}
}

func TestConfigStringHidesSecrets(t *testing.T) {
	c, err := Load(env(map[string]string{
		"MQTT_PASSWORD": "pw-mqtt-secreta", "REDIS_URL": "redis://:pw-redis-secreta@redis:6379/0",
		"DATABASE_URL": "postgres://campo:pw-pg-secreta@db:5432/campo",
	}))
	if err != nil {
		t.Fatal(err)
	}
	for _, out := range []string{c.String(), fmt.Sprintf("%v", c), fmt.Sprintf("%+v", c)} {
		for _, s := range []string{"pw-mqtt-secreta", "pw-redis-secreta", "pw-pg-secreta"} {
			if strings.Contains(out, s) {
				t.Fatalf("la configuración impresa filtra %q: %s", s, out)
			}
		}
	}
}
