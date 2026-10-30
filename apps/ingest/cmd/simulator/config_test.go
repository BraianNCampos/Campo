package main

import (
	"fmt"
	"strings"
	"testing"
)

func TestParsePlants(t *testing.T) {
	ok := map[string][]string{
		"demo":                  {"demo"},
		"demo,tanques":          {"demo", "tanques"},
		" demo , tanques ":      {"demo", "tanques"},
		"a-1,b_2,0x":            {"a-1", "b_2", "0x"},
		strings.Repeat("a", 64): {strings.Repeat("a", 64)},
	}
	for in, want := range ok {
		got, err := parsePlants(in)
		if err != nil || !equalStrings(got, want) {
			t.Errorf("parsePlants(%q) = %v, %v; se esperaba %v", in, got, err, want)
		}
	}
	for _, in := range []string{"", ",", "demo,", ",demo", "demo,,tanques", "Demo", "demo,demo", "-x", "a b", "a/b", "tanques,_x", strings.Repeat("a", 65)} {
		if got, err := parsePlants(in); err == nil {
			t.Errorf("parsePlants(%q) debía fallar y devolvió %v", in, got)
		}
	}
}

func TestParsePasswords(t *testing.T) {
	got, err := parsePasswords("demo=xxx,tanques=y=y+z/==")
	if err != nil || len(got) != 2 || got["demo"] != "xxx" || got["tanques"] != "y=y+z/==" {
		t.Errorf("válido: %v %v", got, err)
	}
	if got, err := parsePasswords(""); err != nil || len(got) != 0 {
		t.Errorf("vacío debe ser válido y sin entradas: %v %v", got, err)
	}
	const secret = "s3cr3t-no-debe-aparecer"
	for _, in := range []string{
		secret,                      // sin "="
		"demo=a," + secret,          // segundo elemento sin "="
		"=" + secret,                // planta vacía
		"Demo=" + secret,            // id inválido
		"demo=",                     // contraseña vacía
		"demo=a,demo=" + secret,     // repetida
		"demo=a,,tanques=" + secret, // elemento vacío
	} {
		_, err := parsePasswords(in)
		if err == nil {
			t.Errorf("parsePasswords(%q) debía fallar", in)
			continue
		}
		if strings.Contains(err.Error(), secret) {
			t.Errorf("el error revela una contraseña: %v", err)
		}
	}
}

func TestPickPlantsPrecedence(t *testing.T) {
	for _, c := range []struct{ fPlants, fPlant, ePlants, ePlant, want string }{
		{"", "", "", "", defaultPlants},
		{"", "", "", "x", "x"},
		{"", "", "a,b", "x", "a,b"},
		{"", "f", "a,b", "x", "f"},      // flag -plant gana al entorno
		{"p,q", "f", "a,b", "x", "p,q"}, // -plants gana a -plant
	} {
		if got := pickPlants(c.fPlants, c.fPlant, c.ePlants, c.ePlant); got != c.want {
			t.Errorf("pickPlants%+v = %q, se esperaba %q", c, got, c.want)
		}
	}
}

func TestResolveCredentials(t *testing.T) {
	two := []string{"demo", "tanques"}

	// Varias plantas: cada una su usuario (= id) y su contraseña.
	c, err := resolveCredentials(two, "", "", map[string]string{"demo": "pd", "tanques": "pt"})
	if err != nil || c["demo"] != (credential{"demo", "pd"}) || c["tanques"] != (credential{"tanques", "pt"}) {
		t.Errorf("varias plantas: %v %v", c, err)
	}
	// Sin credenciales: anónimo.
	if c, err = resolveCredentials(two, "", "", nil); err != nil || c["demo"] != (credential{}) || c["tanques"] != (credential{}) {
		t.Errorf("anónimo: %v %v", c, err)
	}
	// Una sola planta: como siempre, -username/-password (el usuario puede diferir de la planta).
	if c, err = resolveCredentials([]string{"demo"}, "u", "p", nil); err != nil || c["demo"] != (credential{"u", "p"}) {
		t.Errorf("una planta: %v %v", c, err)
	}
	// Una sola planta con -passwords: usuario = planta.
	if c, err = resolveCredentials([]string{"demo"}, "", "", map[string]string{"demo": "pd"}); err != nil || c["demo"] != (credential{"demo", "pd"}) {
		t.Errorf("una planta con -passwords: %v %v", c, err)
	}

	// Errores: falta una planta; sobra una; -password único con varias; -username con varias.
	for name, f := range map[string]func() error{
		"falta tanques": func() error {
			_, err := resolveCredentials(two, "", "", map[string]string{"demo": "pd"})
			return err
		},
		"sobra otra": func() error {
			_, err := resolveCredentials(two, "", "", map[string]string{"demo": "pd", "tanques": "pt", "otra": "po"})
			return err
		},
		"password único": func() error { _, err := resolveCredentials(two, "", "unica", nil); return err },
		"password único + mapa": func() error {
			_, err := resolveCredentials(two, "", "unica", map[string]string{"demo": "pd", "tanques": "pt"})
			return err
		},
		"username con varias": func() error { _, err := resolveCredentials(two, "demo", "", nil); return err },
	} {
		err := f()
		if err == nil {
			t.Errorf("%s: debía ser un error de configuración", name)
			continue
		}
		for _, secret := range []string{"pd", "pt", "po", "unica"} {
			if strings.Contains(err.Error(), "="+secret) {
				t.Errorf("%s: el error revela una contraseña: %v", name, err)
			}
		}
	}
	_, err = resolveCredentials(two, "", "", map[string]string{"demo": "pd"})
	if err == nil || !strings.Contains(err.Error(), "tanques") {
		t.Errorf("el error debe nombrar la planta sin contraseña: %v", err)
	}
}

func TestCredentialNeverPrintsPassword(t *testing.T) {
	c := credential{"demo", "ultra-secreta"}
	for _, s := range []string{c.String(), fmt.Sprintf("%v", c), fmt.Sprintf("%+v", c), fmt.Sprint(map[string]credential{"demo": c})} {
		if strings.Contains(s, "ultra-secreta") {
			t.Errorf("la contraseña aparece en %q", s)
		}
	}
}

func envMap(m map[string]string) func(string) string { return func(k string) string { return m[k] } }

func baseOptions() options {
	return options{broker: "tcp://localhost:1883", tanks: 4, pumps: 2, valves: 2, rate: 1, conns: 1, seed: 1}
}

func TestOptionsResolve(t *testing.T) {
	// Por defecto: demo,tanques anónimas.
	o := baseOptions()
	if err := o.resolve("", "", envMap(nil)); err != nil || !equalStrings(o.plants, []string{"demo", "tanques"}) {
		t.Fatalf("defecto: %v %v", o.plants, err)
	}

	// Alias -plant con credenciales de siempre (uso del compose de producción actual).
	o = baseOptions()
	o.username = "demo"
	if err := o.resolve("", "demo", envMap(map[string]string{"MQTT_PASSWORD": "pw"})); err != nil {
		t.Fatal(err)
	}
	if !equalStrings(o.plants, []string{"demo"}) || o.creds["demo"] != (credential{"demo", "pw"}) {
		t.Errorf("alias: %v %v", o.plants, o.creds)
	}

	// Varias plantas con MQTT_SIM_PASSWORDS.
	o = baseOptions()
	env := envMap(map[string]string{"SIM_PLANTS": "demo,tanques", "MQTT_SIM_PASSWORDS": "demo=pd,tanques=pt"})
	if err := o.resolve("", "", env); err != nil {
		t.Fatal(err)
	}
	if o.creds["demo"] != (credential{"demo", "pd"}) || o.creds["tanques"] != (credential{"tanques", "pt"}) {
		t.Errorf("creds: %v", o.creds)
	}
	// -passwords manda sobre el entorno.
	o = baseOptions()
	o.passwords = "demo=flag1,tanques=flag2"
	if err := o.resolve("", "", env); err != nil || o.creds["tanques"].password != "flag2" {
		t.Errorf("flag sobre env: %v %v", o.creds, err)
	}

	// Errores de configuración.
	bad := map[string]func(o *options) (string, string, map[string]string){
		"falta tanques": func(o *options) (string, string, map[string]string) {
			return "", "", map[string]string{"MQTT_SIM_PASSWORDS": "demo=pd"}
		},
		"planta inválida": func(o *options) (string, string, map[string]string) { return "Demo", "", nil },
		"MQTT_PASSWORD único": func(o *options) (string, string, map[string]string) {
			return "", "", map[string]string{"MQTT_PASSWORD": "x"}
		},
		"CA con tcp://": func(o *options) (string, string, map[string]string) {
			o.caFile = "/ca.crt"
			return "", "", nil
		},
		"rate": func(o *options) (string, string, map[string]string) { o.rate = 0; return "", "", nil },
		"sin activos": func(o *options) (string, string, map[string]string) {
			o.tanks, o.pumps, o.valves = 0, 0, 0
			return "", "otra", nil
		},
	}
	for name, f := range bad {
		o := baseOptions()
		pf, p, env := f(&o)
		if err := o.resolve(pf, p, envMap(env)); err == nil {
			t.Errorf("%s: debía fallar", name)
		}
	}
	// Con 0/0/0 la planta demo sigue teniendo los activos nuevos: válido.
	o = baseOptions()
	o.tanks, o.pumps, o.valves = 0, 0, 0
	if err := o.resolve("demo", "", envMap(nil)); err != nil {
		t.Errorf("demo sin heredados debe ser válida: %v", err)
	}
}
