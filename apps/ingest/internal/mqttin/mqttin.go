// Package mqttin es el cliente MQTT de entrada: se suscribe y entrega cada
// mensaje a un handler que debe ser muy liviano.
package mqttin

import (
	"errors"
	"fmt"
	"log/slog"
	"sync/atomic"
	"time"

	mqtt "github.com/eclipse/paho.mqtt.golang"

	"github.com/braianncampos/campo/apps/ingest/internal/mqttsec"
)

type Config struct {
	BrokerURL    string
	Topic        string
	ClientID     string
	Username     string
	Password     string // nunca se registra en logs
	CAFile       string // CA propia (PEM) para verificar el broker; vacío = raíces del sistema
	QoS          byte
	CleanSession bool
}

type Handler func(topic string, payload []byte)

type Client struct {
	cfg        Config
	c          mqtt.Client
	subscribed atomic.Bool
}

// New no conecta: Start lanza la conexión en segundo plano con reintentos.
// Falla si la configuración TLS es inválida (CA ilegible, CA con URL en claro).
func New(cfg Config, h Handler, log *slog.Logger) (*Client, error) {
	if err := mqttsec.Validate(cfg.BrokerURL, cfg.CAFile); err != nil {
		return nil, err
	}
	tlsCfg, err := mqttsec.TLSConfig(cfg.CAFile)
	if err != nil {
		return nil, fmt.Errorf("mqtt: %w", err)
	}
	shownURL := mqttsec.Redact(cfg.BrokerURL)
	if mqttsec.WarnCleartextCreds(cfg.BrokerURL, cfg.Username) {
		log.Warn("credenciales MQTT enviadas SIN TLS; usa ssl://host:8883", "broker", shownURL)
	}
	cl := &Client{cfg: cfg}
	onMessage := func(_ mqtt.Client, m mqtt.Message) { h(m.Topic(), m.Payload()) }

	opts := mqtt.NewClientOptions().
		AddBroker(cfg.BrokerURL).
		SetClientID(cfg.ClientID).
		SetUsername(cfg.Username).
		SetPassword(cfg.Password).
		SetTLSConfig(tlsCfg).
		SetKeepAlive(30 * time.Second).
		SetConnectTimeout(10 * time.Second).
		SetAutoReconnect(true).
		SetConnectRetry(true). // el broker puede no estar listo al arrancar
		SetConnectRetryInterval(2 * time.Second).
		SetMaxReconnectInterval(30 * time.Second).
		// Con sesión persistente el broker retiene QoS 1 mientras estamos caídos.
		SetCleanSession(cfg.CleanSession).
		// El handler solo encola, así que se puede ejecutar en paralelo sin orden estricto.
		SetOrderMatters(false).
		SetConnectionLostHandler(func(_ mqtt.Client, err error) {
			cl.subscribed.Store(false)
			log.Warn("conexión MQTT perdida", "err", err)
		}).
		SetOnConnectHandler(func(c mqtt.Client) {
			log.Info("MQTT conectado", "broker", shownURL, "tls", mqttsec.IsTLSURL(cfg.BrokerURL), "user", cfg.Username)
			t := c.Subscribe(cfg.Topic, cfg.QoS, onMessage)
			t.Wait()
			if err := t.Error(); err != nil {
				log.Error("fallo al suscribirse", "topic", cfg.Topic, "err", err)
				return
			}
			cl.subscribed.Store(true)
			log.Info("MQTT suscrito", "topic", cfg.Topic, "qos", cfg.QoS)
		})
	cl.c = mqtt.NewClient(opts)
	return cl, nil
}

func (c *Client) Start() { c.c.Connect() } // el token se ignora: ConnectRetry reintenta solo

// Ready indica conexión abierta y suscripción activa.
func (c *Client) Ready() error {
	if !c.c.IsConnectionOpen() || !c.subscribed.Load() {
		return errors.New("MQTT sin conexión o sin suscripción")
	}
	return nil
}

// Stop cancela la suscripción y desconecta, dejando que los mensajes en vuelo terminen.
func (c *Client) Stop() {
	if c.c.IsConnectionOpen() {
		c.c.Unsubscribe(c.cfg.Topic).WaitTimeout(2 * time.Second)
	}
	c.c.Disconnect(500)
}
