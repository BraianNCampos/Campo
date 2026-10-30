package main

import (
	"crypto/tls"
	"os"
	"path/filepath"
	"testing"
)

func TestClientOptionsTLSAndCredentials(t *testing.T) {
	o := options{broker: "ssl://mosquitto:8883"}
	opts, err := clientOptions(o, credential{username: "demo", password: "pw"}, "sim-1")
	if err != nil {
		t.Fatal(err)
	}
	if opts.Username != "demo" || opts.Password != "pw" || opts.ClientID != "sim-1" {
		t.Errorf("credenciales no aplicadas: user=%q id=%q", opts.Username, opts.ClientID)
	}
	if opts.TLSConfig == nil || opts.TLSConfig.MinVersion != tls.VersionTLS12 || opts.TLSConfig.InsecureSkipVerify {
		t.Errorf("TLS inseguro: %+v", opts.TLSConfig)
	}
	if len(opts.Servers) != 1 || opts.Servers[0].Scheme != "ssl" {
		t.Errorf("broker inesperado: %v", opts.Servers)
	}
}

func TestClientOptionsBadCA(t *testing.T) {
	if _, err := clientOptions(options{broker: "ssl://h:8883", caFile: filepath.Join(t.TempDir(), "no.crt")}, credential{}, "x"); err == nil {
		t.Error("CA inexistente debe fallar")
	}
	bad := filepath.Join(t.TempDir(), "bad.crt")
	_ = os.WriteFile(bad, []byte("nope"), 0o600)
	if _, err := clientOptions(options{broker: "ssl://h:8883", caFile: bad}, credential{}, "x"); err == nil {
		t.Error("PEM inválido debe fallar")
	}
}
