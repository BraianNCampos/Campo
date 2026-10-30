# apps/web — Campo 2.0 (frontend)

Next.js (App Router) + TypeScript estricto + Tailwind v4 + Zustand + React Three Fiber/drei. PWA instalable.

## Arranque

```bash
npm install
npm run dev          # http://localhost:3000 — modo DEMO si no hay NEXT_PUBLIC_WS_URL
npm run lint && npm run typecheck && npm test && npm run build
npm run e2e          # next build + next start + Playwright (escritorio y móvil) → e2e/screenshots/
npm run e2e:admin    # e2e de /admin en modo demo (1440x900 y 390x844) → e2e/screenshots/admin-*.png
npm run e2e:models   # e2e del catálogo vivo y los modelos 3D (demo, 1440x900 y 390x844) → e2e/screenshots/models-*.png
```
`SKIP_BUILD=1` reutiliza `.next` en los tres e2e (puertos 3217, 3218 y 3219; no los lances a la vez: comparten `.next`).

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

## Catálogo vivo y modelos 3D (Fase 5, `docs/architecture.md` §10)

- **La lista y el 3D salen del catálogo**, no de la telemetría. `startLive(plant)` pide `GET /api/plants/:plant/assets` (vía `AdminApi.listAssets`, también en demo) y lo guarda en `useLiveStore` (`catalog`, `catalogReady`, `catalogError`); `assetIds` = catálogo ∪ telemetría, ordenado por tipo. `live/catalog-sync.ts` vuelve a pedirlo al recibir `{type:"catalog", plant}` por WebSocket (*debounce* 300 ms, una sola petición en vuelo, reintento con espera creciente si falla; también tras reconectar). Si el contenido no cambia no se tocan las referencias (nada se re-renderiza). En demo, `MockAdminApi.onCatalogChange` hace que el stream simulado emita ese mismo mensaje al editar activos o modelos.
- **Estados**: activo del catálogo sin telemetría → «Sin datos» (gris, icono de círculo discontinuo, sin valores) en la lista de escritorio, las tarjetas móviles, el panel de detalle y el 3D (tintado gris); activo con telemetría pero fuera del catálogo → etiqueta «No catalogado» (sólo con el catálogo ya cargado). Sin catálogo ni datos hay un estado vacío explicativo (cargando / error / catálogo vacío), no «Esperando datos…».
- **3D** (`src/scene/`): `SceneEntities` dibuja cada activo por su `type` (`tank`/`pump`/`valve` procedurales; `sensor` = mástil con cabezal) en `metadata.layout` (`x,z,y,rotY°,scale`), si falta en la posición manual de los ids de `demo` y si no en la cuadrícula automática (`resolvePlacements`, `layout.ts`). La cámara y el suelo se ajustan a los límites de la planta (`sceneBounds`/`fitView`). Los datos en vivo se leen por `SceneData` (suscripción transitoria; en la vista previa de administración es un origen vacío → «sin datos»).
- **Modelos GLB** (`src/scene/models/`): `model3dRef = "model:<uuid>"` → `AdminApi.downloadModel` (fetch + Bearer, 401 → `/login`) → `parseGlb` (`GLTFLoader.parse` sobre el `ArrayBuffer`; sin Draco/meshopt/KTX2; las URIs que no sean `blob:`/`data:` se neutralizan y el modelo se rechaza; límites de 10 MB, 200 000 vértices y 2 000 nodos; se descartan luces y cámaras del archivo). `ModelCache` comparte una sola descarga por id (peticiones en vuelo deduplicadas, máx. 2 simultáneas, errores no cacheados) y libera geometrías/materiales/texturas cuando el último activo lo suelta (3 s de gracia) o cambia de planta. Cada activo recibe un clon con materiales propios, se normaliza a una caja de **1 unidad de lado** (apoyada en y=0) y se multiplica por `layout.scale` (p. ej. 3,5 para un tanque). Convenciones `campo_level*` / `campo_rotor*` / `campo_gate*` y tinte por estado en `conventions.ts` (funciones puras). Mientras carga, o si falla (o si lo dibujado lanza un error), se usa el modelo procedural y el panel del activo muestra «Modelo no disponible».
- **Tuberías**: si algún activo declara `metadata.connectsTo`, se dibuja una tubería ortogonal por par (recortada por la huella de ambos) con partículas de flujo cuando el origen es una bomba con rpm>0 o una válvula con apertura>0; si ninguno lo declara, las tuberías manuales de `demo` (que se ocultan si se mueve un activo de demo con `layout`) o ninguna.
- **Administración** (`/admin/plants/[plant]`): formulario de activo con selector **Modelo 3D** (Procedural / modelos de la planta / «Subir nuevo…»), **Posición X, Z, Altura Y, Rotación, Escala** (rangos del contrato; admite coma decimal) y **Conectado a**; los campos y el JSON avanzado se mantienen sincronizados sin pisar otras claves de `metadata`, y los `warnings` de la API se muestran tras guardar. Sección **Modelos 3D** (lista con tamaño, fecha y nº de activos; subida con input accesible o arrastrando, validación de extensión y ≤ 10 MB en cliente, barra de progreso por XHR, errores 400/413 junto al control; borrado con confirmación y lista de activos del 409). **Vista previa 3D** de la planta (import dinámico; sola en escritorio, botón «Ver vista previa» en móvil).
- Un valor antiguo de `model3dRef` que no sea `model:<uuid>` (p. ej. `tank`) se trata como «sin modelo» y sólo se reenvía si el usuario no cambia ese campo (la API tolera reenviarlo igual).
- `MockAdminApi` (demo) implementa los modelos en memoria: valida la cabecera GLB, versión, longitud, extensiones, URIs externas y límites (400 `GLB no válido: …`, 413 `El modelo supera el límite de 10 MB`), deduplica por sha256 (200 vs 201), 409 con lista de activos al borrar un modelo en uso, `warnings` por `connectsTo` inexistentes (que no se guardan) y auditoría `model.upload`/`model.delete`.

## Docker

```bash
docker build -f apps/web/Dockerfile -t campo-web .   # contexto = raíz del monorepo
```
