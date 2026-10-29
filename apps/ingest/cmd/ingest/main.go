// Servicio de ingesta de Campo — cliente MQTT básico (Fase 1).
//
// Se suscribe a un tópico, recibe mensajes y los imprime en consola.
// Más adelante este handler encolará los datos hacia Redis/TimescaleDB.
package main

import (
	"context"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	mqtt "github.com/eclipse/paho.mqtt.golang"
)

type config struct {
	brokerURL string
	topic     string
	clientID  string
	qos       byte
}

func loadConfig() config {
	return config{
		brokerURL: getenv("MQTT_BROKER_URL", "tcp://localhost:1883"),
		topic:     getenv("MQTT_TOPIC", "campo/test"),
		clientID:  getenv("MQTT_CLIENT_ID", "campo-ingest-dev"),
		qos:       1,
	}
}

func getenv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func main() {
	cfg := loadConfig()

	// El handler corre en la goroutine del cliente; debe ser rápido.
	// Aquí solo imprimimos: el trabajo pesado irá a un pool de workers.
	onMessage := func(_ mqtt.Client, msg mqtt.Message) {
		log.Printf("[msg] topic=%s qos=%d payload=%s", msg.Topic(), msg.Qos(), msg.Payload())
	}

	opts := mqtt.NewClientOptions().
		AddBroker(cfg.brokerURL).
		SetClientID(cfg.clientID).
		SetKeepAlive(30 * time.Second).
		SetConnectTimeout(10 * time.Second).
		SetAutoReconnect(true).
		// Reintenta también la conexión inicial (broker aún no disponible al arrancar).
		SetConnectRetry(true).
		SetConnectRetryInterval(2 * time.Second).
		SetMaxReconnectInterval(30 * time.Second).
		// Sesión persistente: el broker retiene mensajes QoS 1 mientras estamos caídos.
		SetCleanSession(false).
		SetOrderMatters(false). // permite procesar mensajes en paralelo
		SetConnectionLostHandler(func(_ mqtt.Client, err error) {
			log.Printf("[mqtt] conexión perdida: %v", err)
		}).
		// Se ejecuta en cada (re)conexión, así la suscripción se restablece sola.
		SetOnConnectHandler(func(c mqtt.Client) {
			log.Printf("[mqtt] conectado a %s", cfg.brokerURL)
			if t := c.Subscribe(cfg.topic, cfg.qos, onMessage); t.Wait() && t.Error() != nil {
				log.Printf("[mqtt] error al suscribirse a %q: %v", cfg.topic, t.Error())
				return
			}
			log.Printf("[mqtt] suscrito a %q (qos=%d)", cfg.topic, cfg.qos)
		})

	client := mqtt.NewClient(opts)
	// Con ConnectRetry el token no se completa hasta conectar; no bloqueamos el arranque.
	client.Connect()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	<-ctx.Done()

	log.Println("[mqtt] cerrando...")
	client.Unsubscribe(cfg.topic).WaitTimeout(2 * time.Second)
	client.Disconnect(500)
}
