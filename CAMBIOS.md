# Xerion v1.9.3 — Qué cambió

## Sistema de Portales (nuevo, completo)

- Cada 1 hora hay 50% de probabilidad de que se abra un portal (si no hay uno activo ya) — el reloj vive en la base de datos, así que un reinicio del bot no lo reinicia.
- **3 rangos, estilo Solo Leveling**: Portal Rango-E (Inestable, común), Portal Rango-B (Cazador, medio), Portal Rango-S (Monarca, rarísimo) — cada uno con su propia apuesta mínima y su propio reparto.
- Para entrar apostás Feathers con un modal (formulario de Discord) — **mientras más apostás, más probabilidad real de ganar tenés** (verificado con 20,000 simulaciones: la probabilidad coincide con la teoría casi exacta).
- Se cierra a los 10 minutos. Si nadie entra, se cierra solo. Si entra una sola persona, se le devuelve la apuesta (no hay contra quién competir).
- Con 2+ participantes, el Boss del portal "elimina" contendientes en una animación de Canvas completamente nueva — círculo alrededor de un Boss con un anillo de portal brillante, nada que ver con la ruleta de los cofres.
- Reparto final: el ganador se lleva un % del pozo (55/60/70% según el rango), el resto se reparte entre todos los demás según cuánto apostó cada uno, y un 10% sale de la economía — las Feathers tienen riesgo real.
- Todo persiste igual que los cofres: si el bot se reinicia con un portal activo, retoma exactamente donde quedó, sin perder ni una apuesta.

**Todavía falta:** conectarlo al panel del owner para forzarlo manualmente (`/panel-owner`, que es la próxima pieza grande), y avisar en `/help` que existe.

---

# Xerion v1.9.2 — Qué cambió

## Arreglo real: la IA se activaba cuando no debía

- Confirmado con tu reporte: responder a un mensaje de eliminación (o a cualquier mensaje del bot) activaba la IA igual, y escribir `@everyone`/`@here` también. La causa: Discord cuenta técnicamente esas dos cosas como "mención", y el código no las estaba filtrando.
- Arreglado con las opciones correctas de discord.js: ahora solo cuenta como mención un `@Xerion` explícito escrito de verdad, o responder a un mensaje que la IA generó ella misma. Nada más activa el chat.

---

# Xerion v1.9.1 — Qué cambió

## Arreglo: errores de "Unknown interaction" tras reconectar

- Después de la 1.9.0 aparecieron varios `DiscordAPIError[10062]: Unknown interaction` en los logs. Investigado a fondo: no era un bug nuevo — Discord solo da 3 segundos para responder a un botón o comando, y ese error salió porque, tras la inestabilidad que tuvimos antes (el bot desconectándose y reconectando varias veces), quedó un backlog de clics y comandos viejos que Discord entregó de golpe al reconectar — todos ya vencidos, sin ninguna forma de responderlos.
- Se confirmó que ningún cambio reciente introduce este riesgo: en los dos lugares donde se agregó una consulta extra a Discord (`/profile` y la apertura de cofre), el bot ya reconoce la interacción antes de hacer esa consulta, así que siempre queda dentro del margen de 3 segundos.
- Se mejoró igual el manejo de este caso puntual: ahora se loguea aparte, sin alarmar como error grave, y no se intenta responder de nuevo (algo que iba a fallar exactamente igual).

## Tienda: 2 items nuevos (5 en total)

- 🔮 **Amuleto contra el Vacío** (450 Feathers): garantiza que tu próximo cofre no te dé "Nothing" — sacás algo sí o sí.
- ⏩ **Acelerador Temporal** (320 Feathers): completa al instante todo tu ingreso pasivo de rol pendiente la próxima vez que uses `/claim`.

---

# Xerion v1.9.0 — Qué cambió

## 🔴 Arreglo urgente: beneficios de rol sin tener el rol

- Se detectó que alguien pudo reclamar el ingreso pasivo de KING (`/claim`) **sin tener el rol** — el sistema comparaba contra el historial de la base de datos (cuántas veces lo ganó alguna vez) en vez de contra los roles reales de Discord.
- Reescrito de raíz: el bonus de Feathers por rol, el ingreso pasivo de `/claim`, y los logros de "tené tal rol" ahora dependen 100% de qué roles tenés **en Discord en este momento**. Si te quitan un rol, perdés todo lo relacionado con él al instante — el historial (cuántas veces lo ganaste) se conserva solo como estadística, ya no da ningún beneficio por sí solo.
- `/profile` ahora muestra un ✅ al lado de cada rol que tenés activo ahora mismo, para que quede claro qué te está dando beneficio y qué es solo historial.

## Groq: modelo muerto arreglado

- `llama-3.1-8b-instant` fue descontinuado por Groq el 16 de agosto — se cambió al reemplazo oficial recomendado, `openai/gpt-oss-20b` (más rápido y más barato todavía).

## La IA ya no narra eliminaciones sola

- Se sacó por completo la narración automática de eliminaciones con IA. Ahora la IA **solo** se activa si mencionás a `@Xerion` directamente o respondés a uno de sus propios mensajes — nunca se mete sola en ningún otro flujo del juego.

## Bugs de seguridad: botones usables por cualquiera

- `/leaderboard`, `/shop`, `/notification` y `/streak` (y sus versiones `xn`) tenían botones que cualquiera podía tocar, no solo quien pidió el panel — alguien más podía pasar de página tu leaderboard, o pisar tu panel de tienda con el suyo. Ahora cada panel queda bloqueado a quien lo pidió; si otra persona lo toca, le sale un aviso pidiéndole que use el comando por su cuenta.

---

# Xerion v1.8.2 — Qué cambió

## Arreglo: el bot podía quedarse trabado conectando a Discord, en silencio

- Se detectó (con los logs reales de un deploy) que `client.login()` podía quedarse esperando para siempre sin conectar y **sin producir ningún error** — el proceso seguía "vivo" (por eso la web funcionaba normal), pero el bot nunca terminaba de conectarse a Discord ni aparecía online.
- Ahora hay un límite de 30 segundos: si Discord no responde en ese tiempo, se loguea un error claro y explicando la causa más probable (token mal copiado con espacios/saltos de línea, o una falla de red saliente hacia Discord), y el proceso se reinicia — dejando que Render lo intente de nuevo automáticamente, en vez de quedar trabado sin avisar.
- No cambia nada más del comportamiento del bot.

---

# Xerion v1.8.1 — Qué cambió

## Ritmo de eliminación

- Cuando el cofre se cierra, ahora hay **10 segundos** de pausa antes de la primera eliminación (para que la gente alcance a leer quién entró), y de ahí en adelante sigue a 3s por ronda como ya estaba.
- Probabilidad de aparición un poco más difícil (100 → 115 mensajes por cada +1%), ya que ahora el owner puede forzar cofres también.

## `/claim` — ahora es ingreso pasivo por rol

- Como el auto re-sorteo (de la 1.8.0) ya resuelve el problema de cofres sin reclamar, `/claim` se repropuso: cada rol que tengas te da Feathers cada cierto tiempo, solo por tenerlo.
- Mínimo 3h entre cobros. Entre más raro el rol, más da y más hay que esperar: STAR X (4 · 3h), Aura Infinite (15 · 10h), GOAT (40 · 20h), KING (100 · 48h), ARISE (160 · 72h).
- El reloj de cada rol arranca la primera vez que lo ganas, no en cada re-victoria del mismo rol.

## Logros más difíciles, con beneficio

- 14 logros (antes 9), con umbrales más altos (ej. ganar 25 y 75 cofres, 1,000 y 10,000 Feathers totales, rachas de 7 y 30 días, tener los 5 roles a la vez).
- Cada logro desbloqueado suma +0.5% Feathers permanente (tope +5%), sumado al bonus de rareza de rol. Se ve todo en `/profile` y `/achievements`.

## Contador en el cofre ganado

- El embed del ganador ahora muestra cuánto tiempo le queda para abrirlo, con el mismo tipo de contador en vivo que ya tenía el cofre al aparecer.

## Canvas con diseño brutal

- Rediseño completo de la ruleta de recompensas: bisel metálico en cada celda, rayos de luz y resplandor dorado detrás de la celda ganadora, esquinas acentuadas estilo carta premium, y un tratamiento propio para "Nothing" (ya no se ve apagada). El mismo estilo se aplicó a la ruleta de jugadores del re-sorteo.

## `/spawn` sin restricciones (solo owner)

- El comando de spawn del owner ahora **ignora** la regla de "ya hay un cofre activo" — puede forzar hasta 5 cofres a la vez, uno cada 30 segundos, cada uno corriendo de forma independiente (sus propios botones, su propio ciclo de vida) sin chocar entre sí ni con el cofre normal del canal si lo hay.
- Los cofres forzados no se guardan en base de datos (son de prueba) — si el bot se reinicia se pierden, pero el cofre normal del canal nunca se ve afectado por esto.
- El spawn automático por actividad de mensajes sigue exactamente igual que siempre (un cofre a la vez).

## Chat con IA (Groq)

- Menciona a `@Xerion` en cualquier canal (o responde a uno de sus mensajes generados por IA) para charlar. No hace falta comando — es directo por mención, para no gastar de los 20 comandos disponibles.
- Tiene personalidad: responde con humor según cómo lo traten, escribe corto y casual como una persona real, en el mismo idioma en que le escriban.
- **Nunca pinguea a nadie, bajo ninguna circunstancia** — ni con `@everyone`, ni si se lo piden directamente, ni disfrazado de otra forma. Esto está garantizado a nivel de código (todo mensaje de la IA se manda con `allowedMentions` desactivado, que es lo que Discord usa para decidir si algo notifica o no), no solo con instrucciones al modelo — así que es imposible que falle aunque alguien intente convencer a la IA de lo contrario.
- Los resúmenes de eliminación con humor solo se generan en la ronda decisiva de cada batalla (no en cada ronda) para cuidar los tokens — el resto de rondas sigue usando las frases normales del bot.
- Si no configuras `GROQ_API_KEY`, el bot sigue funcionando exactamente igual, solo sin estas dos cosas — nunca rompe nada por no tenerla.
- Nota técnica: se implementó con el `fetch` nativo de Node contra la API de Groq (compatible con OpenAI) en vez del paquete `groq-sdk`, para no depender de una librería nueva que no se pudiera verificar en este entorno — el resultado es idéntico, solo más liviano.

---

# Xerion v1.8.0 — Qué cambió

## Rol nuevo: STAR X (el más básico)

- Se agregó <@&1489704408538415184> **STAR X** ⭐ como el rol más común de todos, justo después de AURA INFINITE. Orden de rareza completo: ARISE > KING > GOAT > AURA INFINITE > STAR X.
- Probabilidad propia por tier (Ceniza 1.2% · Brasa 3.2% · Abismo 8.6%), con las 3 tablas rebalanceadas para seguir sumando exactamente 100%.

## Beneficios por rareza de rol

- Cada rol de cofre ahora da un bonus permanente de Feathers, según qué tan raro sea: **ARISE +25%**, **KING +18%**, **GOAT +12%**, **AURA INFINITE +6%**, **STAR X +2%**.
- Solo cuenta el rol más raro que tengas (no se suman varios a la vez). Se aplica tanto en premios de cofre como en `/daily`, y se muestra en `/profile`.

## Black List

- <@&1501082061166084237> ahora bloquea la participación: quien tenga ese rol recibe un aviso privado al intentar unirse a un cofre y no entra al sorteo.

## Cofres que ya no se quedan trabados

- Si el ganador no reclama su cofre en **5 minutos**, el bot re-sortea automáticamente entre el resto de quienes participaron — con una ruleta nueva que gira con **avatares y nombres reales**, no con iconos genéricos.
- Si nadie más queda disponible, el cofre se pierde y el canal queda libre al instante para que aparezca uno nuevo — antes se quedaba bloqueado indefinidamente esperando a alguien que nunca volvía.
- El re-sorteo sobrevive a un reinicio del bot: si el plazo ya venció mientras estaba caído, se resuelve apenas vuelve a conectar.

## Iconos reales en el Canvas de apertura

- Cada recompensa (ARISE, KING, GOAT, AURA INFINITE, STAR X, Feathers, Nothing) ahora muestra su propio icono a color en la ruleta del cofre, además del texto.
- Los iconos se cargan como imágenes (el mismo estilo de emoji que ya usa Discord en toda su app), nunca como texto dibujado a mano — así se evita por completo el bug de glifos rotos que podía salir según la fuente instalada en el servidor. Si un icono no llega a cargar por cualquier motivo, esa celda simplemente se ve como antes (solo texto) — nunca rompe la animación.

## Canvas con más impacto y más fluido

- La celda ganadora ahora tiene resplandor de color y un brillo diagonal para que se sienta más "premio".
- La animación de apertura pasó de 7 a 11 frames (giro más fluido, sin alargar la espera) y usa la misma mejora la nueva ruleta de re-sorteo de jugadores.

---

# Xerion v1.7.5 — Qué cambió

## Rol nuevo: GOAT

- Se agregó <@&1537232162246496346> **GOAT** 🐐 como tercer mejor rol del cofre, justo después de KING (y antes de AURA INFINITE). Orden de rareza: ARISE > KING > GOAT > AURA INFINITE.
- Probabilidad propia por tier (Ceniza 0.48% · Brasa 1.2% · Abismo 3.3%) — cada tabla se rebalanceó restándole ese porcentaje a "Nothing", así que las 3 tablas siguen sumando exactamente 100%.
- Aparece ya en `/profile`, `/inventory`, `/achievements`, `/rates`, en el flujo de apertura y en la asignación de rol — todo ordenado por rareza en cada panel.

## Tienda más difícil, con 3 objetos

- Escudo de Xerion: 100 → **140** plumas. Amuleto de Suerte: 150 → **220** plumas.
- Objeto nuevo: **Pluma Fénix** 🪶 (400 plumas) — si te eliminan en la batalla, revives una vez y sigues en juego hasta la siguiente ronda. Se consume al usarse, funcione o no.

## `/claim` ahora reclama cofres, no el daily

- Antes `/claim` y `/daily` eran literalmente el mismo comando por error — ya están separados.
- `/claim` (y `xn claim`) busca si ganaste un cofre que no habías abierto (aunque el mensaje original ya haya quedado arriba en el chat) y lo abre directo. Sigue funcionando incluso si el bot se reinició mientras tanto.
- Para que exista algo que reclamar, primero hay que haber participado y sobrevivido a la eliminación — `/claim` no es un atajo para saltarse el juego.

## Racha de `/daily` en el apodo

- `/daily` ahora calcula una racha real (se mantiene si reclamas dentro de 48h del último claim, se reinicia a 1 si dejas pasar más).
- Si la visibilidad está activada (por defecto sí), tu apodo se actualiza solo a algo como `nombre (🔥3)`.
- Panel `/streak` nuevo: muestra racha actual, mejor racha, y un botón para activar/desactivar que se muestre en tu apodo.

## Top sin bugs

- El leaderboard ahora verifica en un solo llamado a Discord quién sigue realmente en el servidor. A quien ya no está se le excluye del top y se le reinician sus datos por completo (incluye historial de cofres y notificaciones) — si vuelve a entrar, arranca limpio, sin filas fantasma ni "Usuario no disponible".

## Tips aleatorios

- Nueve tips distintos sobre `/notification`, `/claim`, `/streak`, la tienda, etc. Aparecen con ~20% de probabilidad al final de varios paneles (perfil, inventario, ayuda, historial, logros, rango, recompensas, daily, streak, stats...) — nunca siempre, para que no se sienta como un manual pegado.

## Eliminación a ritmo de 3 segundos

- Cada ronda de eliminación ahora hace una pausa fija de 3s antes de la siguiente — le da tiempo a la gente de leer quién cayó.

---

# Xerion v1.7.0 — Qué cambió

## Corrección de compatibilidad con bases existentes

- Se corrigió el `ReportNotNullViolationError` de `xerion_users.guild_id` que aparecía en producción cuando la tabla provenía de una versión antigua.
- La migración detecta esa columna solo si existe y le asigna un valor por defecto estable para usuarios nuevos; no modifica ni elimina filas existentes.
- El alta de usuarios usa una inserción compatible con esquemas antiguos y actualiza nombres sin depender de que exista exactamente un índice único sobre `user_id`.
- Se mantiene el esquema aditivo: no hay `DROP`, truncados ni reinicios de contadores, tienda, logros, recompensas o cofres activos.

## Estructura (5 archivos, como pediste)

- **config.js** — CONFIG del servidor, los 3 tipos de cofre y sus tablas de recompensa, la tienda, y utilidades puras.
- **database.js** — todo Postgres/Neon. Esquema 100% aditivo (`CREATE TABLE IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS`) — tu base de datos actual se autorepara al arrancar, nunca se borra nada.
- **visuals.js** — el motor de canvas y **todos** los paneles Components V2.
- **game.js** — spawns, batalla de eliminación, tienda, notificaciones, y los 20 comandos (slash + prefix).
- **index.js** — cliente de Discord, la página web informativa, y el arranque.

Reemplaza tu `index.js` actual por estos 5 archivos (mismo `package.json`, actualicé solo la versión — no necesitas instalar nada nuevo).

## Los 20 comandos (slash + `xn ...`)

| Comando | Prefix | Qué hace |
|---|---|---|
| `/spawn` | `xn spawn [tipo]` | Solo tú — fuerza un cofre, opcionalmente eligiendo el tipo |
| `/profile` | `xn profile` / `perfil` | Estadísticas completas |
| `/inventory` | `xn inv` | Balance rápido — **este era el que fallaba**; lo reescribí, ver nota abajo |
| `/leaderboard` | `xn top` | Top de Feathers |
| `/rates` | `xn rates` / `odds` | Probabilidades de los 3 cofres |
| `/shop` | `xn shop` / `tienda` | Comprar Escudo/Amuleto con Feathers |
| `/notification` | `xn notification` / `notif` | Panel para activar/desactivar el aviso por DM |
| `/stats` | `xn stats` | Estadísticas del servidor |
| `/help` | `xn help` | Lista de comandos |

## Lo que pediste, uno por uno

- **La tienda es más difícil** → `/shop`: **Escudo de Xerion** (🛡️ 100 plumas, te salva de la ronda 1 de eliminación) y **Amuleto de Suerte** (🍀 150 plumas, +50% probabilidad de rol en tu próxima apertura). Ambos son objetos escasos y se consumen al usarse.
- **3 tipos de cofre** (inventé los nombres): 🩶 Cofre de Ceniza (común), 🔥 Cofre de Brasa (raro), 🌑 Cofre del Abismo (legendario). Cada uno con su propia tabla de probabilidad — **incluso el Abismo sigue siendo mayormente "Nothing"**, el sistema es difícil a propósito.
- **Probabilidad dinámica v1.6.9**: empieza en 0% y sube +1% cada 100 mensajes del canal de cofres, hasta 100%. Cada canal tiene su propio contador persistente.
- **Panel Components V2 del cofre** con estadísticas en tiempo real (tipo, mejor recompensa, rango de plumas, % de nada, cierre, participantes, cofres abiertos del canal, última aparición, mensajes procesados, probabilidad siguiente y tip de tienda).
- **Sin ping al usar comandos**: todo pasa por `allowedMentions` suprimidos por defecto (`parse: []`) + `repliedUser: false` en prefix.
- **Ping real al eliminar y al ganador**: las líneas de eliminación y el anuncio del ganador ahora sí traen la mención en el `content` del mensaje (los mentions dentro de un *embed* nunca pingan en Discord — por eso antes probablemente no pingaban de verdad).
- **`/notification`**: panel con botón activar/desactivar; cuando aparece un cofre (automático o forzado), se manda un DM a todos los que lo activaron.
- **Clear de slash commands**: en cada arranque, el bot borra TODOS los comandos globales y del guild configurado antes de re-registrar solo estos 9 — así no quedan comandos clonados de proyectos anteriores.
- **Nunca resets**: esquema aditivo, y absolutamente todo lo que toca Discord o la base de datos está en `try/catch` — un error nunca tumba el proceso ni pide reiniciar nada. Los cofres activos se guardan por canal.
- **Components V2 + Markdown de Discord** en todos los paneles, incluido el flujo completo del cofre. Las estadísticas del cofre se editan inmediatamente al entrar un participante.
- **Top 100**: ranking paginado de 10 en 10 con botones; resuelve nombres desde Discord y nunca muestra `unknown-user`.

## Sobre los "comandos que no funcionaban"

No encontré un bug reproducible en el código del zip para `xn inv` — sintácticamente estaba bien. Reescribí todo el flujo de comandos con manejo de errores defensivo de punta a punta, así que si era un problema de timing/permisos en producción debería estar cubierto ahora. Corrí una prueba end-to-end simulada completa (spawn → participar → batalla con escudo → abrir con amuleto → recompensa de rol → tienda → notificaciones → clear de comandos) sin ninguna excepción — pero no reemplaza probarlo con tu bot y tu Postgres reales.

## Antes de subirlo a producción

1. `npm install` (por si acaso) y `npm start` en un entorno de pruebas primero si puedes.
2. Prueba `/spawn` con cada tipo de cofre.
3. Revisa que el bot tenga el permiso **Manage Roles** y que su rol esté por encima de AURA INFINITE / KING / ARISE en la jerarquía — si no, el bot te avisa en el resultado pero no puede asignar el rol.
4. Si usas `GUILD_ID` en `.env`, los slash commands se actualizan al instante; si no, tardan hasta 1 hora la primera vez.
