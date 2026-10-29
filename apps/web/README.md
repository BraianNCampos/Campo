# apps/web — Campo 2.0 (frontend)

Next.js (App Router) + TypeScript estricto + Tailwind v4 + Zustand + React Three Fiber/drei. PWA instalable.

## Arranque

```bash
npm install
npm run dev          # http://localhost:3000 — modo DEMO si no hay NEXT_PUBLIC_WS_URL
npm run lint && npm run typecheck && npm test && npm run build
npm run e2e          # next build + next start + Playwright (escritorio y móvil) → e2e/screenshots/
npm run e2e:admin    # e2e de /admin en modo demo (1440x900 y 390x844) → e2e/screenshots/admin-*.png
```
`SKIP_BUILD=1` reutiliza `.next` en ambos e2e (puertos 3217 y 3218; no los lances a la vez: comparten `.next`).

## Variables (se incrustan en build)

| Variable | Uso |
|---|---|
| `NEXT_PUBLIC_WS_URL` | URL del WebSocket (`wss://host/ws`); se le añade `?plant=&token=`. Si falta → modo demo |
| `NEXT_PUBLIC_API_URL` | Base REST (`''` = mismo origen): login, alarmas, y toda la administración (`/api/me`, `/api/plants*`, `/api/users*`, `/api/alarm-rules*`, `/api/audit`, `/api/me/password`) |
| `NEXT_PUBLIC_PLANT` | Planta preferida al entrar si el usuario no tiene una recordada (def. `demo`) |
| `NEXT_PUBLIC_MOCK` | `1`/`0` fuerza demo / real. En demo tanto el stream como la API de administración son simulados |

## Arquitectura

- `src/lib/` utilidades puras (backoff, batcher rAF, parseo de mensajes, estados, métricas).
- `src/store/live-store.ts` (`useLiveStore`: activos, alarmas, conexión) y `history.ts` (buffers circulares fuera de React).
- `src/live/` cliente WS con reconexión (backoff exponencial + jitter), simulador de la planta demo (`ServerMessage` idénticos a los del WS) y arranque.
- `src/scene/` gemelo 3D (carga dinámica, sólo escritorio o móvil bajo demanda): el 3D lee con `useLiveStore.subscribe` y refs, interpola en `useFrame`; `frameloop="demand"` a 30 fps; calidad baja automática con render por software.
- `src/components/` UI: móvil (<768px) tarjetas + alarmas + "Ver 3D" opt-in; escritorio lista + 3D + curvas + alarmas.
- `src/lib/admin/` capa de API de administración: `AdminApi` (interfaz tipada, `types.ts`), `HttpAdminApi` (fetch + Bearer; `errors.ts` convierte 400/401/403/404/409/red en `AdminApiError` con mensajes en español, sin trazas; un 401 limpia el token y vuelve a `/login`), `MockAdminApi` (en memoria, sembrada con la planta `demo`, 8 activos, 3 reglas, 4 usuarios y auditoría; mismos 400/403/404/409, `affectedRules`, "último admin", auditoría de cada cambio), `access.ts` (guardas por rol), `validation.ts` (formularios, coherente con los DTO del servidor). `getAdminApi()` elige mock o HTTP igual que el stream (`config.mock`).
- `src/store/session-store.ts` (usuario + plantas, con caché local para abrir sin red), `plant-store.ts` (plantas y planta activa, recordada en `localStorage` `campo.plant`), `toast-store.ts` (avisos `aria-live`).
- `src/components/admin/` pantallas de `/admin` (Usuarios, Plantas y activos, Reglas, Auditoría, Mi cuenta), diálogos accesibles (`Modal`/`ConfirmDialog`: `role=dialog|alertdialog`, foco atrapado, Esc, foco devuelto) y campos de formulario.
- `public/sw.js` service worker (shell offline, caché de estáticos); iconos generados con `node scripts/gen-icons.mjs`.

## Plantas y administración

- **Selector de planta** en la cabecera (de `GET /api/plants`; no aparece si sólo hay una). Cambiarla para y vuelve a arrancar el stream (`startLive(plant)`): se cierra el WebSocket, se limpia el estado vivo, el histórico y la selección, y se conecta a `/ws?plant=<nueva>`. Un usuario sin plantas ve «Sin plantas asignadas». Las plantas distintas de `demo` no tienen layout 3D propio: sin ids conocidos se colocan en cuadrícula centrada y sin tuberías; con mezcla, los desconocidos van a la fila trasera. En modo demo, una planta creada simula valores suaves para los activos de su catálogo mock.
- **`/admin`** (barra lateral en escritorio, pestañas inferiores en móvil; tablas → tarjetas): Usuarios (admin), Plantas y activos (admin, engineer), Reglas de alarma (admin, engineer), Auditoría (admin), Mi cuenta (todos). El acceso se protege en cliente (403 amigable) pero la API es la autoridad. «Administración» en la cabecera sólo para admin/engineer; «Mi cuenta» para todos (en móvil, menú de usuario).
- **Modo demo**: los datos de administración viven en memoria (se reinician al recargar). En *Mi cuenta* se puede cambiar el rol de la sesión demo (`localStorage` `campo.demoRole`) para ver cómo cambia la navegación; la contraseña inicial de los usuarios demo es `demo-password-123`.
- Respuestas no especificadas en `docs/architecture.md` que el cliente asume (confirmadas con la API): `POST /api/users/:id/revoke` → `ManagedUser`; `DELETE /api/plants/:plant` → `{deleted:true}`; `DELETE` de activo → `{deleted:true, affectedRules:n}`; `POST /api/me/password` → `{accessToken}` (se guarda). Desactivar o revocar sube la versión de token: el usuario afectado recibe 401 y vuelve a `/login`.
- Auditoría: `GET /api/audit?limit=50&before=<id>&actor=&action=`; «Cargar más» pide la página siguiente con `before` = id de la última entrada.

## Docker

```bash
docker build -f apps/web/Dockerfile -t campo-web .   # contexto = raíz del monorepo
```
