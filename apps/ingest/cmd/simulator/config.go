package main

import (
	"errors"
	"fmt"
	"strings"

	"github.com/braianncampos/campo/apps/ingest/internal/parser"
)

const defaultPlants = "demo,tanques"

// credential es la identidad MQTT con la que se publica una planta.
type credential struct{ username, password string }

// String oculta la contraseña por si una credencial acaba en un log o en un %v.
func (c credential) String() string { return fmt.Sprintf("{user=%q}", c.username) }

// parsePlants interpreta una lista de ids de planta separados por comas.
func parsePlants(s string) ([]string, error) {
	var out []string
	seen := map[string]bool{}
	for i, p := range strings.Split(s, ",") {
		p = strings.TrimSpace(p)
		switch {
		case p == "":
			return nil, fmt.Errorf("plantas: elemento %d vacío", i+1)
		case !parser.ValidID(p):
			return nil, fmt.Errorf("plantas: id %q inválido (debe cumplir ^[a-z0-9][a-z0-9_-]{0,63}$)", p)
		case seen[p]:
			return nil, fmt.Errorf("plantas: %q repetida", p)
		}
		seen[p] = true
		out = append(out, p)
	}
	return out, nil
}

// parsePasswords interpreta "demo=xxx,tanques=yyy". Parte por la primera "=" de cada
// elemento (la contraseña puede contener "=", pero no ","). Los mensajes de error
// nunca reproducen el contenido de un elemento: podría ser una contraseña.
func parsePasswords(s string) (map[string]string, error) {
	out := map[string]string{}
	if strings.TrimSpace(s) == "" {
		return out, nil
	}
	for i, kv := range strings.Split(s, ",") {
		plant, pw, ok := strings.Cut(kv, "=")
		plant = strings.TrimSpace(plant)
		switch {
		case !ok:
			return nil, fmt.Errorf("contraseñas: el elemento %d no tiene la forma planta=contraseña", i+1)
		case !parser.ValidID(plant):
			return nil, fmt.Errorf("contraseñas: el elemento %d no tiene un id de planta válido", i+1)
		case pw == "":
			return nil, fmt.Errorf("contraseñas: la planta %q tiene la contraseña vacía", plant)
		}
		if _, dup := out[plant]; dup {
			return nil, fmt.Errorf("contraseñas: planta %q repetida", plant)
		}
		out[plant] = pw
	}
	return out, nil
}

// pickPlants decide qué plantas se simulan. Precedencia (la primera que exista):
//
//  1. flag -plants
//  2. flag -plant (alias de una sola planta)
//  3. env SIM_PLANTS
//  4. env SIM_PLANT
//  5. por defecto "demo,tanques"
//
// Un flag explícito siempre gana al entorno; con ambos flags, -plants.
func pickPlants(flagPlants, flagPlant, envPlants, envPlant string) string {
	for _, v := range []string{flagPlants, flagPlant, envPlants, envPlant} {
		if v != "" {
			return v
		}
	}
	return defaultPlants
}

// resolveCredentials asigna a cada planta su identidad MQTT.
//
//   - Sin ninguna credencial: todas anónimas (broker de desarrollo).
//   - Una sola planta: -username/-password como siempre (el usuario puede no ser el id de
//     planta); si falta la contraseña se toma de passwords[planta] y el usuario es la planta.
//   - Varias plantas: usuario = id de planta y la contraseña sale de passwords. Todas deben
//     tener la suya y no puede sobrar ninguna; -username/-password (únicos) se rechazan
//     porque no se sabe a qué planta pertenecen. Nunca se reutilizan credenciales entre plantas.
func resolveCredentials(plants []string, username, password string, passwords map[string]string) (map[string]credential, error) {
	creds := make(map[string]credential, len(plants))
	inList := map[string]bool{}
	for _, p := range plants {
		inList[p] = true
	}
	for p := range passwords {
		if !inList[p] {
			return nil, fmt.Errorf("contraseñas: hay una para %q, que no está en las plantas simuladas", p)
		}
	}

	if len(plants) == 1 {
		p := plants[0]
		c := credential{username: username, password: password}
		if c.password == "" {
			if pw, ok := passwords[p]; ok {
				c.password = pw
				if c.username == "" {
					c.username = p
				}
			}
		}
		creds[p] = c
		return creds, nil
	}

	if username != "" || password != "" {
		return nil, errors.New("con varias plantas -username/-password (MQTT_USERNAME/MQTT_PASSWORD) no se pueden usar: " +
			"cada planta es su propio usuario; usa -passwords planta=contraseña,... (env MQTT_SIM_PASSWORDS)")
	}
	if len(passwords) == 0 { // modo sin autenticación
		for _, p := range plants {
			creds[p] = credential{}
		}
		return creds, nil
	}
	var missing []string
	for _, p := range plants {
		pw, ok := passwords[p]
		if !ok {
			missing = append(missing, p)
			continue
		}
		creds[p] = credential{username: p, password: pw}
	}
	if len(missing) > 0 {
		return nil, fmt.Errorf("faltan contraseñas MQTT para las plantas: %s (-passwords / MQTT_SIM_PASSWORDS)", strings.Join(missing, ", "))
	}
	return creds, nil
}
