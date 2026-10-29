// Package mqttsec reúne lo común de la seguridad del cliente MQTT (ingesta y
// simulador): construcción del tls.Config y redacción de credenciales para logs.
//
// Política: la verificación del certificado del broker NUNCA se desactiva (no
// existe ninguna opción "insecure skip verify") y la versión mínima es TLS 1.2.
package mqttsec

import (
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"net/url"
	"os"
	"strings"
)

// IsTLSScheme indica si el esquema de la URL del broker usa TLS.
func IsTLSScheme(scheme string) bool {
	switch strings.ToLower(scheme) {
	case "ssl", "tls", "tcps", "mqtts", "wss":
		return true
	}
	return false
}

// TLSConfig construye el tls.Config del cliente.
//
//   - caFile vacío: se usan las raíces del sistema (certificados públicos reales).
//   - caFile informado: se confía ÚNICAMENTE en la CA de ese fichero PEM (CA propia);
//     el broker debe presentar un certificado firmado por ella y válido para el host.
//
// ServerName se deja vacío a propósito: paho lo rellena con el host de la URL, de
// modo que se verifica siempre el nombre (SAN) del servidor.
func TLSConfig(caFile string) (*tls.Config, error) {
	cfg := &tls.Config{MinVersion: tls.VersionTLS12}
	if caFile == "" {
		return cfg, nil
	}
	pem, err := os.ReadFile(caFile)
	if err != nil {
		return nil, fmt.Errorf("MQTT_CA_FILE: %w", err)
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(pem) {
		return nil, errors.New("MQTT_CA_FILE: no contiene ningún certificado PEM válido")
	}
	cfg.RootCAs = pool
	return cfg, nil
}

// Validate comprueba la coherencia entre la URL del broker y las opciones de TLS.
// Un fichero de CA con una URL en claro es casi seguro un error de configuración
// (se creería estar cifrando sin estarlo), así que se rechaza.
func Validate(brokerURL, caFile string) error {
	u, err := url.Parse(brokerURL)
	if err != nil {
		return fmt.Errorf("URL del broker inválida: %s", Redact(brokerURL))
	}
	if caFile != "" && !IsTLSScheme(u.Scheme) {
		return fmt.Errorf("MQTT_CA_FILE requiere una URL con TLS (ssl://host:8883), no %q", u.Scheme+"://")
	}
	return nil
}

// Redact oculta la contraseña incrustada en una URL (scheme://user:pass@host).
func Redact(raw string) string {
	u, err := url.Parse(raw)
	if err != nil || u.User == nil {
		if err != nil && strings.Contains(raw, "@") {
			return "<url inválida>"
		}
		return raw
	}
	if _, has := u.User.Password(); has {
		u.User = url.UserPassword(u.User.Username(), "xxxxx")
	}
	return u.String()
}

// WarnCleartextCreds es true cuando se van a enviar credenciales por un canal sin TLS.
func WarnCleartextCreds(brokerURL, username string) bool {
	if username == "" {
		return false
	}
	u, err := url.Parse(brokerURL)
	return err == nil && !IsTLSScheme(u.Scheme)
}

// IsTLSURL es IsTLSScheme aplicado a una URL completa.
func IsTLSURL(raw string) bool {
	u, err := url.Parse(raw)
	return err == nil && IsTLSScheme(u.Scheme)
}
