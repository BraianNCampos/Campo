# Rediseño ISA-101 / ISA-18.2 — decisiones y plan

Requisitos del cliente (resumen): plantilla maestra bloqueada, jerarquía de 4 niveles, indicadores de desviación con color por estado, gestión de alarmas ISA-18.2/EEMUA 191, nomenclatura de tags estándar, gemelo digital 3D realista con paneles de vidrio, operación móvil con modo de alto contraste, y baja latencia.

Este documento dice **qué ya cumplimos, qué falta, cómo lo resolvemos y en qué orden**. Es la guía de las fases 7a–7d; el contrato técnico de cada una se agrega a `architecture.md` antes de construirla.

## 1. Cómo encaja con clientes y módulos (Fase 6, en curso)

Los **módulos** (§11) siguen siendo la unidad comercial: definen qué ve cada cliente. Los niveles ISA-101 son la forma de **navegar** lo que ve:

| Nivel ISA-101 | En Campo |
|---|---|
| 1 · Vista general de la planta | Pantalla de inicio: 3D de la planta (si el cliente tiene `view3d`; si no, un mapa 2D de unidades), solo KPIs de alto nivel y alertas agregadas **por módulo/unidad**. Sin valores de instrumentos. |
| 2 · Vista general de la unidad | Pantalla de módulo (`/m/<módulo>`): equipos principales, variables controladas clave y alarmas activas. |
| 3 · Detalle de la unidad | Detalle por activo (`/m/<módulo>/<tag>`): lazos (PV/SP/OP), posiciones de válvulas, totales, alarmas con **tag, descripción, valor y límite**, tendencias. |
| 4 · Detalle del equipo | Diagnóstico y mantenimiento: panel de motor, permisivos de enclavamiento, ajuste de setpoints. **Solo lectura hasta que exista el módulo de comandos** (§ siguiente fase), que lleva confirmación, permisos y auditoría. |

Más adelante una *unidad de proceso* (área: recepción, secado, tanques de aceite…) será una agrupación de activos dentro de un módulo; el modelo de datos lo admite sin romper lo anterior.

## 2. Requisito por requisito

**1. Plantilla maestra bloqueada.** Un único layout con **cabecera**, **barra de navegación** y **pie con resumen de alarmas** fijos; todas las pantallas lo heredan. Prohibido el acceso directo ad-hoc: la navegación sale solo de `me.org.modules` y de la jerarquía. *Estado:* el agente de pantallas por módulo ya construye la navegación; se le exige además el pie global de alarmas y la herencia estricta. *Fase 7a.*

**2. Jerarquía de 4 niveles.** Ver tabla. *Fases 7a (niveles 1-2) y 7d (3-4).*

**3. Indicadores de desviación.**
- Barra de desviación respecto del **setpoint (SP)**, no valores aislados. El SP sale de `metadata.setpoints[métrica]` o de la métrica `sp` en telemetría.
- Color por estado: neutro en rango; **ámbar cuando el valor llega al 90 % de la distancia entre el SP y el límite de alarma** (sin SP: entre el mínimo de la escala y el límite); rojo en alarma. Hoy usamos "a menos del 10 % de la escala"; se reemplaza por esta regla (misma función pura, nuevos tests).
- Tendencia a un clic desde cualquier pantalla de nivel 2 o 3 (panel lateral con la curva de la variable). *Fase 7a.*

**4. Gestión de alarmas ISA-18.2 / EEMUA 191.**
- Tipos: `HH`, `HI`, `LO`, `LL`, `DEV` (desviación respecto del SP), `ROC` (tasa de cambio), con **prioridad** y **banda muerta** y **retardos** de activación/desactivación justificados (ya existen histéresis y retardo de activación).
- **Ciclo de vida:** normal → activa sin reconocer → activa reconocida → vuelta a normal sin reconocer → normal; además *shelving* temporal con motivo y vencimiento, *supresión por diseño* basada en estado (p. ej. no alarmar nivel bajo si la bomba está detenida por mantenimiento: la regla lleva una condición sobre otro tag) y *fuera de servicio* con auditoría.
- **Métricas:** tasa de alarmas, alarmas "sentadas" (stale), las más frecuentes y picos en 10 minutos, con panel de salud de alarmas.
- ⚠️ **Objetivo de tasa:** el documento pide "150 alarmas por operador **por hora**". Las referencias habituales (EEMUA 191 / ISA-18.2) hablan de unas **150 por operador por día** (≈ 6 por hora, 1 cada 10 minutos) como manejable, y de no más de ~10 en los 10 minutos posteriores a una perturbación. Lo implementamos como **umbrales configurables con esos valores por defecto**; pendiente de confirmar con el equipo de ingeniería.
- Presentación: una alarma activa muestra aviso rojo en el equipo (3D y tarjeta), entrada en el pie global y alerta agregada en el nivel 1. *Fase 7b.*

**5. Nomenclatura de tags.** Cada activo tendrá un `tag` único por planta con prefijos `PMP`, `VLV`, `TNK`, `MTR`, `XMTR`, `PID`, `COMP`, `CONV` (p. ej. `TNK-101`), variables `PV`, `SP`, `OP`, `MV`, estados/comandos `STS`, `CMD`, `FB`, `MODE` y alarmas `HH/HI/LO/LL/DEV/ROC`. Se muestran en toda la interfaz junto al nombre descriptivo. Los ids actuales (`tk-01`…) se migran a tags sin romper los tópicos MQTT (el tag es presentación; el id técnico no cambia). *Fase 7d.*

**6. Gemelo digital 3D, estética y móvil.**
- **3D realista:** kit industrial paramétrico (silos con dosel y escalera, cintas transportadoras, naves con cubierta, tuberías con soportes, tanques con bandeja de contención), materiales PBR, iluminación y sombras suaves; los modelos propios del cliente (GLB) siguen siendo la vía para la planta real. *Fase 7c.*
- **Anomalías sobre el modelo:** contornos brillantes (*outline/glow*) y marcadores holográficos en ámbar, rojo o magenta (post-proceso `Outline`), iluminación dinámica puntual; el resto del modelo no se tiñe. *Fase 7c.*
- **Paneles de vidrio** (*glassmorphism*) sobre el 3D: tarjetas translúcidas con KPI, indicadores de desviación y tendencias; amplio espacio negativo, Barlow. Cuidamos el contraste (el vidrio nunca baja de AA). *Fases 7a–7c.*
- **Móvil primero:** gestos táctiles (zoom con pellizco, rotación, desplazamiento), tarjetas en lugar de 3D por defecto, y un **modo de alto contraste para luz solar** (tema claro de alto contraste con color + forma + texto, conmutable y recordado). *Fase 7a.*
- **Baja latencia:** hoy ingesta→Redis ≤10 ms (p99 ≤100 ms) y fusión de 100 ms en la API; añadimos un indicador de **latencia extremo a extremo** (marca de tiempo de la muestra → pintado) en el pie, con alarma de degradación, y una prueba de carga que lo mide. *Fase 7c.*

## 3. Orden de construcción

1. **Fase 6 (en curso):** clientes, módulos, aislamiento, límites, simulador, pantallas por módulo y administración.
2. **7a — Plantilla maestra y niveles 1-2:** layout bloqueado con pie de alarmas, vista de planta, indicadores de desviación, regla del 90 %, tendencia a un clic, modo alto contraste, paneles de vidrio.
3. **7b — Alarmas ISA-18.2:** tipos, prioridades, ciclo de vida, shelving, supresión por estado, métricas y panel de salud.
4. **7c — 3D realista y latencia:** kit industrial, contornos, marcadores, indicador de latencia.
5. **7d — Tags, niveles 3-4 y comandos:** nomenclatura, detalle de lazo y de equipo, setpoints y órdenes con confirmación y auditoría (control de llenado).

## 4. Supuestos a confirmar

1. Objetivo de tasa de alarmas: 150/día (o 150/hora como dice el documento).
2. Nivel 4 de solo lectura hasta tener comandos (seguridad primero).
3. Planta de referencia para el 3D realista: usamos un kit paramétrico agroindustrial (silos, cintas, naves); si hay planos o modelos reales, los usamos.
