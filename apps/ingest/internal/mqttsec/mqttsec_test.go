package mqttsec

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// writeTestCA escribe una CA autofirmada en dir y devuelve la ruta del PEM.
func writeTestCA(t *testing.T, dir string) string {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tpl := &x509.Certificate{
		SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "test-ca"},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour),
		IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign,
	}
	der, err := x509.CreateCertificate(rand.Reader, tpl, tpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(dir, "ca.crt")
	if err := os.WriteFile(p, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestTLSConfigDefaults(t *testing.T) {
	c, err := TLSConfig("")
	if err != nil {
		t.Fatal(err)
	}
	if c.MinVersion != tls.VersionTLS12 {
		t.Errorf("MinVersion = %#x, quiero TLS 1.2", c.MinVersion)
	}
	if c.InsecureSkipVerify {
		t.Error("la verificación del certificado nunca debe desactivarse")
	}
	if c.RootCAs != nil {
		t.Error("sin CA propia deben usarse las raíces del sistema (RootCAs nil)")
	}
}

func TestTLSConfigCustomCA(t *testing.T) {
	ca := writeTestCA(t, t.TempDir())
	c, err := TLSConfig(ca)
	if err != nil {
		t.Fatal(err)
	}
	if c.RootCAs == nil || len(c.RootCAs.Subjects()) != 1 { //nolint:staticcheck // basta para contar la CA cargada
		t.Fatal("RootCAs debe contener exactamente la CA indicada")
	}
	if c.MinVersion != tls.VersionTLS12 || c.InsecureSkipVerify {
		t.Errorf("config insegura: %+v", c)
	}
}

func TestTLSConfigErrors(t *testing.T) {
	dir := t.TempDir()
	if _, err := TLSConfig(filepath.Join(dir, "no-existe.crt")); err == nil {
		t.Error("CA inexistente debe fallar")
	}
	bad := filepath.Join(dir, "bad.crt")
	_ = os.WriteFile(bad, []byte("esto no es PEM"), 0o600)
	if _, err := TLSConfig(bad); err == nil || !strings.Contains(err.Error(), "MQTT_CA_FILE") {
		t.Errorf("PEM inválido debe fallar mencionando MQTT_CA_FILE, got %v", err)
	}
}

func TestClientRejectsTLS11Server(t *testing.T) {
	// Un servidor limitado a TLS 1.1 debe ser rechazado por el cliente (MinVersion 1.2).
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	tpl := &x509.Certificate{SerialNumber: big.NewInt(2), Subject: pkix.Name{CommonName: "localhost"},
		DNSNames: []string{"localhost"}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour)}
	der, _ := x509.CreateCertificate(rand.Reader, tpl, tpl, &key.PublicKey, key)
	srvCfg := &tls.Config{
		Certificates: []tls.Certificate{{Certificate: [][]byte{der}, PrivateKey: key}},
		MinVersion:   tls.VersionTLS10, MaxVersion: tls.VersionTLS11,
	}
	l, err := tls.Listen("tcp", "127.0.0.1:0", srvCfg)
	if err != nil {
		t.Skipf("este Go no permite TLS 1.1 en el servidor: %v", err)
	}
	defer l.Close()
	go func() {
		for {
			c, err := l.Accept()
			if err != nil {
				return
			}
			go func() { _ = c.(*tls.Conn).Handshake(); c.Close() }()
		}
	}()
	cfg, _ := TLSConfig("")
	cfg.ServerName = "localhost"
	cfg.RootCAs = x509.NewCertPool()
	cert, _ := x509.ParseCertificate(der)
	cfg.RootCAs.AddCert(cert)
	conn, err := tls.DialWithDialer(&net.Dialer{Timeout: 3 * time.Second}, "tcp", l.Addr().String(), cfg)
	if err == nil {
		conn.Close()
		t.Fatal("el cliente aceptó un servidor TLS 1.1")
	}
}

func TestValidate(t *testing.T) {
	for _, tc := range []struct {
		url, ca string
		ok      bool
	}{
		{"tcp://localhost:1883", "", true},
		{"ssl://broker:8883", "", true},
		{"ssl://broker:8883", "/ca.crt", true},
		{"tcp://broker:1883", "/ca.crt", false},
	} {
		if err := Validate(tc.url, tc.ca); (err == nil) != tc.ok {
			t.Errorf("Validate(%q,%q) = %v", tc.url, tc.ca, err)
		}
	}
}

func TestRedactAndWarn(t *testing.T) {
	if got := Redact("ssl://u:pw-secreta@host:8883"); strings.Contains(got, "pw-secreta") || !strings.Contains(got, "host:8883") {
		t.Errorf("Redact = %q", got)
	}
	if got := Redact("ssl://host:8883"); got != "ssl://host:8883" {
		t.Errorf("Redact sin credenciales alteró la URL: %q", got)
	}
	if !WarnCleartextCreds("tcp://h:1883", "demo") || WarnCleartextCreds("ssl://h:8883", "demo") || WarnCleartextCreds("tcp://h:1883", "") {
		t.Error("WarnCleartextCreds incorrecto")
	}
}
