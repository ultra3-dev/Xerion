# 💸 Costos en Render — qué entra en la factura y qué puedes bajar

> **Resumen.** En el plan **Starter** el costo de la instancia es **fijo (≈ US$7/mes)**: ningún cambio de código lo baja ni lo sube.
> v1.1.0 **no agrega servicios, no cambia el plan, los recursos ni las variables de producción** y el canvas del blackjack está
> diseñado para no aumentar la factura (imágenes de ≈74 KB, caché, sin dependencias nuevas). Lo único que **baja** el total es una
> decisión tuya sobre el plan o el cron job; dejé listo el camino, pero **no lo apliqué** (no tengo acceso a tu cuenta y tú no
> autorizaste cambiar plan ni infraestructura).

## Lo que muestra tu captura de facturación (7 de octubre de 2026)

| Concepto | Valor | Lectura |
|---|---|---|
| Services | US$0.94 en lo que va del mes | Tu servicio web **Starter** (se factura por segundo; Free Instance Hours = 0/750 h, o sea que no usas el plan gratuito) |
| Cron Jobs | US$0.10 | **`render.yaml` no define ningún cron job**: es algo creado a mano en el panel (o de otro proyecto). Ver «Opción B» |
| Pipeline Minutes | US$0.00 (5 de 500 min) | Los builds de cada deploy; lejos del límite |
| Bandwidth | 94 MB de 5 GB (92 MB iniciados por el servicio) | Mensajes a Discord, Neon y subidas de archivos |
| Total del mes / proyección | US$1.04 / **US$6.89** para octubre | Coherente con una instancia Starter (≈US$7/mes) más el cron |
| Crédito | US$10.00 | «Se aplica al importe de tu próxima factura»: cubriría la proyección de octubre |

## Opciones (tú decides)

| Opción | Ahorro aproximado | Contrapartidas | Cómo |
|---|---|---|---|
| **A. Seguir en Starter** (estado actual) | — (≈ US$7/mes, proyección US$6.89) | Ninguna: no se suspende, mejor latencia | No hacer nada |
| **B. Borrar el cron job si es un sobrante** | su cargo mensual (US$0.10 en lo que va del mes) | Si el cron hace algo útil (p. ej. un ping), dejaría de hacerlo; en Starter el servicio **no se duerme**, así que un ping de keep-alive sobra | Render → tu workspace → busca el *Cron Job* → revisa su comando y logs → elimínalo. Yo no lo toqué |
| **C. Plan Free + keep-alive** | ≈ **US$6.9/mes** de instancia | Puede reiniciarse o suspenderse y tarda en despertar; CPU ≈ 0.1 (comandos y dibujo del blackjack bastante más lentos); 750 h gratis por workspace; Render podría cambiar esta política | Usa `render.free.yaml` (New → Blueprint) o cambia el plan del servicio a Free y define `KEEP_ALIVE=on` (ver abajo) |

**Recomendación:** haz **B** si confirmas que es un sobrante (riesgo nulo) y mantén **A** mientras el bot tenga jugadores activos y
quieras respuestas rápidas; elige **C** solo si prefieres bajar el costo aceptando que el bot puede tardar o reiniciarse.
No recomiendo C sin haber medido tu latencia real en Free.

### Keep-alive (solo para la opción C)

Un servicio Free se suspende tras 15 minutos sin tráfico HTTP entrante y un bot casi no recibe HTTP. Con `KEEP_ALIVE=on` el bot se hace una
petición HTTPS a su propia URL pública (`/health`) cada 10 minutos (`KEEP_ALIVE_MINUTES`, 1–14; `KEEP_ALIVE_URL` si no usas la URL que
Render define como `RENDER_EXTERNAL_URL`). Está **apagado por defecto**; con Starter no debe activarse. Es una mitigación, no una garantía.

## Qué hice para no subir el costo

- **Sin infraestructura nueva:** ni servicios, ni workers, ni base de datos adicional, ni dependencias (`package.json` y `package-lock.json`
  solo cambian de versión), ni variables obligatorias nuevas.
- **Canvas liviano:** cada imagen del blackjack pesa ≈74 KB (PNG indexado; en color verdadero serían ≈250–270 KB). Las imágenes salen del
  servicio hacia Discord y cuentan como **ancho de banda de salida**; el cálculo es `partidas al mes × imágenes por partida × 74 KB`. Con
  1,000 partidas de 3 imágenes ≈ 217 MB; el ancho de banda incluido que muestra tu panel es de 5 GB. Los renders repetidos salen de una caché LRU.
- **Memoria:** ≈ 40 MB extra (sprites y fondo cacheados); cabe de sobra en una instancia de 512 MB.
- **Persistencia sin cambios:** no se añadieron consultas por comando; los trades no consultan la base de datos (viven en memoria y se
  persisten con el autoguardado existente). `getRank` pasó de ordenar todos los perfiles a contar en O(n) (medición local con 10,000 perfiles
  sintéticos: 21.3 ms → 16.3 ms, mismo resultado; **no** es una medición de producción).
- **Sin descargas repetidas:** los emojis Apple (≈100 KB en total) se bajan una vez por arranque y se cachean.

## Qué NO hice (y por qué)

- No cambié el plan ni borré el cron job (decisión tuya).
- No toqué la lógica de idempotencia por evento (`claimDiscordEvent`, una escritura en Neon por comando/interacción): quitarla o cambiarla
  podría permitir ejecuciones duplicadas. Si tu consumo en Neon preocupa, mide primero en su panel antes de tocarlo.
- No afirmo que la factura haya bajado ni que el bot sea más rápido en producción: **no hay mediciones de producción**. Mide tú con:
  1. Render → *Billing* → *Monthly Included Usage*: compara «Service-Initiated» antes y después de activar el canvas.
  2. `npm run bench:canvas` para el peso y el tiempo por imagen en tu servidor.
  3. `npm run load-test` (sintético, local) para la economía.

## Si quieres bajar aún más (futuro, requiere medir y tu autorización)

- Subir el nivel de compresión del PNG o reducir el tamaño de la imagen (hoy 900×576) si el ancho de banda llega a preocupar.
- Reducir escrituras de idempotencia a Neon agrupándolas en memoria con ventana corta (cambia garantías: solo con pruebas y tu visto bueno).
- Revisar el plan de Neon (compute-hours / almacenamiento) en su propio panel: no es visible desde este repositorio.
