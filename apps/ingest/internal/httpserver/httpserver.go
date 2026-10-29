// Package httpserver expone /healthz, /readyz y /metrics.
package httpserver

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"sort"
	"time"
)

// Check devuelve nil si la dependencia está lista.
type Check func(ctx context.Context) error

type Server struct {
	srv *http.Server
	ln  net.Listener
}

// New prepara el servidor y abre el puerto de inmediato, para que Addr sea
// válido y un puerto ocupado falle al arrancar.
func New(addr string, metrics http.Handler, checks map[string]Check) (*Server, error) {
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return nil, err
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Write([]byte("ok\n"))
	})
	mux.HandleFunc("GET /readyz", readyz(checks))
	mux.Handle("GET /metrics", metrics)
	return &Server{
		srv: &http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second},
		ln:  ln,
	}, nil
}

func readyz(checks map[string]Check) http.HandlerFunc {
	names := make([]string, 0, len(checks))
	for n := range checks {
		names = append(names, n)
	}
	sort.Strings(names)

	return func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), time.Second)
		defer cancel()

		status, ready := make(map[string]string, len(checks)), true
		for _, n := range names {
			if err := checks[n](ctx); err != nil {
				status[n], ready = err.Error(), false
			} else {
				status[n] = "ok"
			}
		}
		w.Header().Set("Content-Type", "application/json")
		if !ready {
			w.WriteHeader(http.StatusServiceUnavailable)
		}
		json.NewEncoder(w).Encode(map[string]any{"ready": ready, "checks": status})
	}
}

func (s *Server) Addr() string { return s.ln.Addr().String() }

// Serve bloquea hasta Shutdown.
func (s *Server) Serve() error {
	if err := s.srv.Serve(s.ln); !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

func (s *Server) Shutdown(ctx context.Context) error { return s.srv.Shutdown(ctx) }
