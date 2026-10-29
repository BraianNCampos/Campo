package mqttin

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"io"
	"log/slog"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	mqtt "github.com/eclipse/paho.mqtt.golang"
	mochi "github.com/mochi-mqtt/server/v2"
	"github.com/mochi-mqtt/server/v2/listeners"
	"github.com/mochi-mqtt/server/v2/packets"

	"github.com/braianncampos/campo/apps/ingest/internal/mqttsec"
)

// ---- PKI de pruebas ----------------------------------------------------------------------

type pki struct {
	caFile  string
	srvCert tls.Certificate
}

// newPKI genera una CA y un certificado de servidor para "localhost" (sólo DNS: sin SAN de IP).
func newPKI(t *testing.T, dir string) pki {
	t.Helper()
	caKey, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	caTpl := &x509.Certificate{
		SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "campo-test-ca"},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour),
		IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign,
	}
	caDER, err := x509.CreateCertificate(rand.Reader, caTpl, caTpl, &caKey.PublicKey, caKey)
	if err != nil {
		t.Fatal(err)
	}
	caCert, _ := x509.ParseCertificate(caDER)

	srvKey, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	srvTpl := &x509.Certificate{
		SerialNumber: big.NewInt(2), Subject: pkix.Name{CommonName: "mosquitto"},
		DNSNames:  []string{"localhost"},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour),
		KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	srvDER, err := x509.CreateCertificate(rand.Reader, srvTpl, caCert, &srvKey.PublicKey, caKey)
	if err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(dir, "ca.crt")
	if err := os.WriteFile(p, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: caDER}), 0o600); err != nil {
		t.Fatal(err)
	}
	return pki{caFile: p, srvCert: tls.Certificate{Certificate: [][]byte{srvDER}, PrivateKey: srvKey}}
}

// ---- Broker embebido con TLS, usuarios y ACL equivalentes a infra/mosquitto/config/acl.conf ----

type aclHook struct {
	mochi.HookBase
	users map[string]string // usuario -> contraseña
}

func (h *aclHook) ID() string { return "campo-acl-test" }
func (h *aclHook) Provides(b byte) bool {
	return b == mochi.OnConnectAuthenticate || b == mochi.OnACLCheck
}

func (h *aclHook) OnConnectAuthenticate(cl *mochi.Client, pk packets.Packet) bool {
	pw, ok := h.users[string(cl.Properties.Username)]
	return ok && pw == string(pk.Connect.Password)
}

// OnACLCheck replica el acl.conf real:
//
//	user ingest:              read  campo/v1/#
//	pattern write campo/v1/%u/+/telemetry
//	pattern read  campo/v1/%u/+/cmd
func (h *aclHook) OnACLCheck(cl *mochi.Client, topic string, write bool) bool {
	user := string(cl.Properties.Username)
	if user == "ingest" {
		return !write && matches("campo/v1/#", topic)
	}
	if write {
		return matches("campo/v1/"+user+"/+/telemetry", topic)
	}
	return matches("campo/v1/"+user+"/+/cmd", topic)
}

func matches(filter, topic string) bool {
	f, tp := strings.Split(filter, "/"), strings.Split(topic, "/")
	for i, p := range f {
		if p == "#" {
			return true
		}
		if i >= len(tp) || (p != "+" && p != tp[i]) {
			return false
		}
	}
	return len(f) == len(tp)
}

func startTLSBroker(t *testing.T, p pki) (addr string) {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr = l.Addr().String()
	l.Close()

	s := mochi.New(&mochi.Options{Logger: slog.New(slog.NewTextHandler(io.Discard, nil))})
	if err := s.AddHook(&aclHook{users: map[string]string{
		"ingest": "pw-ingest", "demo": "pw-demo", "otra": "pw-otra",
	}}, nil); err != nil {
		t.Fatal(err)
	}
	tlsCfg := &tls.Config{Certificates: []tls.Certificate{p.srvCert}, MinVersion: tls.VersionTLS12}
	if err := s.AddListener(listeners.NewTCP(listeners.Config{ID: "tls", Address: addr, TLSConfig: tlsCfg})); err != nil {
		t.Fatal(err)
	}
	go s.Serve()
	t.Cleanup(func() { s.Close() })
	return addr
}

// ---- helpers -------------------------------------------------------------------------------

type syncBuf struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuf) Write(p []byte) (int, error) { s.mu.Lock(); defer s.mu.Unlock(); return s.b.Write(p) }
func (s *syncBuf) String() string              { s.mu.Lock(); defer s.mu.Unlock(); return s.b.String() }

func quiet() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

type sink struct {
	mu   sync.Mutex
	msgs []string
}

func (s *sink) add(topic string, _ []byte) {
	s.mu.Lock()
	s.msgs = append(s.msgs, topic)
	s.mu.Unlock()
}
func (s *sink) has(topic string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, m := range s.msgs {
		if m == topic {
			return true
		}
	}
	return false
}

func eventually(t *testing.T, d time.Duration, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(d)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timeout: %s", what)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// connect abre un cliente paho de una sola vez (sin reintentos) y devuelve el error de conexión.
func connect(t *testing.T, host, user, pass, caFile string) (mqtt.Client, error) {
	t.Helper()
	tlsCfg, err := mqttsec.TLSConfig(caFile)
	if err != nil {
		t.Fatal(err)
	}
	o := mqtt.NewClientOptions().AddBroker("ssl://" + host).SetClientID("t-" + user + "-" + time.Now().Format("150405.000000")).
		SetUsername(user).SetPassword(pass).SetTLSConfig(tlsCfg).SetConnectTimeout(3 * time.Second).SetAutoReconnect(false)
	c := mqtt.NewClient(o)
	tok := c.Connect()
	if !tok.WaitTimeout(5 * time.Second) {
		t.Fatal("timeout conectando")
	}
	return c, tok.Error()
}

func swapHost(addr, host string) string {
	_, port, _ := net.SplitHostPort(addr)
	return net.JoinHostPort(host, port)
}

// ---- tests ----------------------------------------------------------------------------------

func TestTLSAuthACLIntegration(t *testing.T) {
	p := newPKI(t, t.TempDir())
	addr := startTLSBroker(t, p)
	host := swapHost(addr, "localhost") // el SAN del certificado es "localhost"

	// 1. Ingest real (mqttin.Client) con TLS + CA propia + credenciales: conecta y se suscribe.
	var got sink
	ing, err := New(Config{
		BrokerURL: "ssl://" + host, Topic: "campo/v1/#", ClientID: "ingest-it",
		Username: "ingest", Password: "pw-ingest", CAFile: p.caFile, QoS: 0, CleanSession: true,
	}, got.add, quiet())
	if err != nil {
		t.Fatal(err)
	}
	ing.Start()
	t.Cleanup(ing.Stop)
	eventually(t, 5*time.Second, "ingest listo (TLS + auth)", func() bool { return ing.Ready() == nil })

	// 2. La planta "demo" publica en su espacio: llega a ingest.
	demo, err := connect(t, host, "demo", "pw-demo", p.caFile)
	if err != nil {
		t.Fatalf("demo debería conectar: %v", err)
	}
	defer demo.Disconnect(100)
	if tok := demo.Publish("campo/v1/demo/tk-01/telemetry", 1, false, `{"values":{"level":1}}`); !tok.WaitTimeout(3*time.Second) || tok.Error() != nil {
		t.Fatalf("publicar en su planta falló: %v", tok.Error())
	}
	eventually(t, 3*time.Second, "mensaje de demo recibido por ingest", func() bool { return got.has("campo/v1/demo/tk-01/telemetry") })

	// 3. Publicar fuera de su planta: el broker lo descarta (o rechaza), no llega a ingest.
	_ = demo.Publish("campo/v1/otra/tk-01/telemetry", 0, false, `{"values":{"level":2}}`).WaitTimeout(2 * time.Second)
	_ = demo.Publish("campo/v1/demo/tk-01/cmd", 0, false, `{}`).WaitTimeout(2 * time.Second) // demo no puede ESCRIBIR cmd
	// centinela posterior: cuando llega, los anteriores ya se habrían entregado
	_ = demo.Publish("campo/v1/demo/tk-02/telemetry", 0, false, `{"values":{"level":3}}`).WaitTimeout(2 * time.Second)
	eventually(t, 3*time.Second, "centinela recibido", func() bool { return got.has("campo/v1/demo/tk-02/telemetry") })
	if got.has("campo/v1/otra/tk-01/telemetry") {
		t.Error("ACL rota: demo publicó en la planta 'otra'")
	}
	if got.has("campo/v1/demo/tk-01/cmd") {
		t.Error("ACL rota: demo publicó en cmd")
	}

	// 4. Ingest no puede publicar (sólo lectura).
	ingPub, err := connect(t, host, "ingest", "pw-ingest", p.caFile)
	if err != nil {
		t.Fatal(err)
	}
	defer ingPub.Disconnect(100)
	_ = ingPub.Publish("campo/v1/demo/hack/telemetry", 0, false, `{"values":{"x":1}}`).WaitTimeout(2 * time.Second)
	_ = demo.Publish("campo/v1/demo/tk-03/telemetry", 0, false, `{"values":{"level":3}}`).WaitTimeout(2 * time.Second)
	eventually(t, 3*time.Second, "centinela 2", func() bool { return got.has("campo/v1/demo/tk-03/telemetry") })
	if got.has("campo/v1/demo/hack/telemetry") {
		t.Error("ACL rota: ingest pudo publicar")
	}

	// 5. 'demo' no puede suscribirse a otras plantas ni a todo.
	var spy sink
	tok := demo.Subscribe("campo/v1/#", 0, func(_ mqtt.Client, m mqtt.Message) { spy.add(m.Topic(), m.Payload()) })
	tok.WaitTimeout(2 * time.Second)
	otra, err := connect(t, host, "otra", "pw-otra", p.caFile)
	if err != nil {
		t.Fatal(err)
	}
	defer otra.Disconnect(100)
	_ = otra.Publish("campo/v1/otra/tk-01/telemetry", 0, false, `{"values":{"level":9}}`).WaitTimeout(2 * time.Second)
	eventually(t, 3*time.Second, "ingest recibe de 'otra'", func() bool { return got.has("campo/v1/otra/tk-01/telemetry") })
	if spy.has("campo/v1/otra/tk-01/telemetry") {
		t.Error("ACL rota: demo escuchó telemetría de otra planta")
	}
}

func TestTLSRejections(t *testing.T) {
	p := newPKI(t, t.TempDir())
	addr := startTLSBroker(t, p)
	host := swapHost(addr, "localhost")

	if _, err := connect(t, host, "demo", "mala", p.caFile); err == nil {
		t.Error("contraseña incorrecta aceptada")
	}
	if _, err := connect(t, host, "", "", p.caFile); err == nil {
		t.Error("conexión anónima aceptada")
	}
	if _, err := connect(t, host, "desconocido", "x", p.caFile); err == nil {
		t.Error("usuario desconocido aceptado")
	}
	// Sin la CA propia el certificado no es de confianza (raíces del sistema): la verificación NO se omite.
	if _, err := connect(t, host, "demo", "pw-demo", ""); err == nil {
		t.Error("el cliente aceptó un certificado de una CA no confiable")
	}
	// Nombre que no figura en el SAN del certificado (127.0.0.1): debe fallar la verificación del host.
	if _, err := connect(t, swapHost(addr, "127.0.0.1"), "demo", "pw-demo", p.caFile); err == nil {
		t.Error("el cliente aceptó un host que no está en el SAN")
	}
	// Texto plano contra el puerto TLS: no hay conexión.
	o := mqtt.NewClientOptions().AddBroker("tcp://" + addr).SetClientID("plain").SetUsername("demo").SetPassword("pw-demo").
		SetConnectTimeout(2 * time.Second).SetAutoReconnect(false)
	c := mqtt.NewClient(o)
	if tok := c.Connect(); tok.WaitTimeout(4*time.Second) && tok.Error() == nil {
		t.Error("MQTT en claro aceptado por el listener TLS")
	}
}

func TestNewRejectsBadTLSConfig(t *testing.T) {
	if _, err := New(Config{BrokerURL: "ssl://localhost:8883", Topic: "t", ClientID: "c", CAFile: "/no/existe.crt"}, func(string, []byte) {}, quiet()); err == nil {
		t.Error("CA inexistente debería fallar en New")
	}
	if _, err := New(Config{BrokerURL: "tcp://localhost:1883", Topic: "t", ClientID: "c", CAFile: "/algo.crt"}, func(string, []byte) {}, quiet()); err == nil {
		t.Error("CA con tcp:// debería fallar en New")
	}
}

func TestPasswordNeverLogged(t *testing.T) {
	p := newPKI(t, t.TempDir())
	addr := startTLSBroker(t, p)
	buf := &syncBuf{}
	log := slog.New(slog.NewTextHandler(buf, &slog.HandlerOptions{Level: slog.LevelDebug}))
	c, err := New(Config{
		BrokerURL: "ssl://ingest:pw-ingest@" + swapHost(addr, "localhost"), Topic: "campo/v1/#", ClientID: "ing-log",
		Username: "ingest", Password: "pw-ingest", CAFile: p.caFile, CleanSession: true,
	}, func(string, []byte) {}, log)
	if err != nil {
		t.Fatal(err)
	}
	c.Start()
	t.Cleanup(c.Stop)
	eventually(t, 5*time.Second, "listo", func() bool { return c.Ready() == nil })
	if out := buf.String(); strings.Contains(out, "pw-ingest") {
		t.Fatalf("el log contiene una contraseña:\n%s", out)
	}
}
