# apps/web — Campo 2.0 (frontend)

Next.js (App Router) + TypeScript estricto + Tailwind v4 + Zustand + React Three Fiber/drei. PWA instalable.

## Arranque

```bash
npm install
npm run dev          # http://localhost:3000 — modo DEMO si no hay NEXT_PUBLIC_WS_URL
npm run lint && npm test && npm run build
npm run e2e          # next build + next start + Playwright (escritorio y móvil) → e2e/screenshots/
```

## Variables (se incrustan en build)

| Variable | Uso |
|---|---|
| `NEXT_PUBLIC_WS_URL` | URL del WebSocket (`wss://host/ws`); se le añade `?plant=&token=`. Si falta → modo demo |
| `NEXT_PUBLIC_API_URL` | Base REST (`''` = mismo origen): `POST /api/auth/login`, `GET /api/alarms?state=active`, `POST /api/alarms/:id/ack` |
| `NEXT_PUBLIC_PLANT` | Planta (def. `demo`) |
| `NEXT_PUBLIC_MOCK` | `1`/`0` fuerza demo / real |

## Arquitectura

- `src/lib/` utilidades puras (backoff, batcher rAF, parseo de mensajes, estados, métricas).
- `src/store/live-store.ts` (`useLiveStore`: activos, alarmas, conexión) y `history.ts` (buffers circulares fuera de React).
- `src/live/` cliente WS con reconexión (backoff exponencial + jitter), simulador de la planta demo (`ServerMessage` idénticos a los del WS) y arranque.
- `src/scene/` gemelo 3D (carga dinámica, sólo escritorio o móvil bajo demanda): el 3D lee con `useLiveStore.subscribe` y refs, interpola en `useFrame`; `frameloop="demand"` a 30 fps; calidad baja automática con render por software.
- `src/components/` UI: móvil (<768px) tarjetas + alarmas + "Ver 3D" opt-in; escritorio lista + 3D + curvas + alarmas.
- `public/sw.js` service worker (shell offline, caché de estáticos); iconos generados con `node scripts/gen-icons.mjs`.

## Docker

```bash
docker build -f apps/web/Dockerfile -t campo-web .   # contexto = raíz del monorepo
```
