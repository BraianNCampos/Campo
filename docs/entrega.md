# Plan de entrega — Campo 2.0

**Qué entrego como "terminado":** una plataforma lista para un **piloto con un cliente real**: funciona de punta a punta, está probada con automatismos que corren en GitHub, se despliega con una guía paso a paso y tiene el comportamiento que pide el cliente (ISA-101 / ISA-18.2, módulos por cliente, comandos con auditoría, avisos por Telegram).

**Lo que ningún proyecto de software puede dar por sí solo** y queda como validación de campo, con fecha a definir con ustedes: probar con sensores y gateways reales, una revisión de seguridad por una persona del equipo antes de abrirlo a internet, y la validación de la filosofía de alarmas con los operadores de la planta.

## Estado

| Bloque | Estado |
|---|---|
| Ingesta MQTT → Redis/TimescaleDB, API, WebSocket, PWA | Hecho y verificado con Docker |
| Seguridad: TLS, aislamiento entre clientes, auditoría | Hecho y verificado |
| Clientes y módulos, administración | Hecho y verificado |
| Identidad de marca, pantallas por módulo, Modo pared, alto contraste | Hecho |
| CI en GitHub | Configurado; **primera ejecución real en curso** |
| Demo publicable (GitHub Pages) | Lista; falta que el dueño del repo la active |

## Lo que falta, en orden

| Fase | Contenido | Resultado verificable |
|---|---|---|
| **7a** | Setpoints y barras de desviación, regla del 90 %, tendencia a un clic, vista general de la planta (Nivel 1) con paneles de vidrio | e2e en navegador + pruebas unitarias |
| **7b** | Alarmas ISA-18.2: tipos HH/HI/LO/LL/DEV/ROC, ciclo de vida, shelving, supresión por estado, banda muerta y retardos, racionalización, indicadores de salud | pruebas del motor + prueba con Postgres real |
| **7c** | 3D realista (silos, cintas, naves), contornos brillantes en anomalías, indicador de latencia extremo a extremo | capturas + medición de latencia |
| **7d** | Tags estándar (`TNK-101`…), niveles 3 y 4, comandos de control de llenado con confirmación, permisos y registro de órdenes | prueba de comandos de punta a punta con el simulador |
| **8** | Avisos por Telegram, histórico y alarmas cerradas, consumo de energía por hora | pruebas con un servidor de Telegram simulado |
| **9** | Cierre: manual de usuario, guía de despliegue en un servidor, copias de seguridad, pull request listo para fusionar, CI verde | `docs/` completo y CI verde |

Cada fase se verifica con Docker real antes de pasar a la siguiente.
