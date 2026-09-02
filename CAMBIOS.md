# Xerion v2.0.5 ULTRA — Qué cambió

## 🎰 `/roll` sin Canvas — ahora es pura animación de embeds

Se sacó el Canvas del todo de `/roll`: ya no genera ni sube ninguna imagen en cada tirada. La animación de "girando" ahora cambia de texto y color en cada frame usando solo Components V2 — mucho más liviano en CPU y en ancho de banda, no debería notarse lag ni comerse de más tu plan de hosting.

De paso, las probabilidades ahora se muestran como **"1 en X"** en vez de porcentaje (igual que los juegos de RNG de Roblox en los que te inspiraste) — se ve en cada tirada, junto con la rareza y cuántos Fragmentos vale. Mantuve las mismas 7 probabilidades que ya estaban probadas y balanceadas (Común 1 en 2, hasta Secreto 1 en 10.000) — ninguna cae justo en "1 en 300", así que si querías ese número específico para algún tramo en particular, decime cuál y lo ajusto.

## 🌀 Arreglé la ruleta de eventos del owner — el bug de los iconos era real

Tenías razón, y encontré la causa exacta: los iconos SÍ se dibujaban, pero giraban junto con toda la ruleta — en la mayoría de los frames terminaban de costado o boca abajo contra el fondo de color, prácticamente invisibles. Ahora cada icono se contra-rota para quedar siempre derecho, gire lo que gire la ruleta por detrás. De paso encontré y arreglé 2 iconos que tenían el código equivocado (Lluvia de Plumas usaba un águila en vez de la pluma con fuego que usa el resto del bot, y Cofres Abundantes no coincidía con su propio emoji).

---

## 🔴 Arreglo urgente: el bot no arrancaba

La página de estado (`index.js`) armaba las tarjetas de cofres buscando el rol "ARISE" a mano para mostrar el porcentaje — el Cofre OG no tiene ningún rol con esa key, así que apenas cargaba `index.js` (antes incluso de conectar con Discord) el bot explotaba con `Cannot read properties of undefined (reading 'chance')`. Es el mismo tipo de bug que ya había arreglado en `visuals.js`, pero en otro archivo que no había revisado con el mismo detalle. Arreglado igual que el otro: busca la recompensa con menos % en la tabla de cada cofre, sin asumir ningún rol fijo. Agregué `require('./index.js')` a mi batería de pruebas para que esto no se me vuelva a pasar — antes solo probaba los módulos que `index.js` usa, no `index.js` en sí.

## 🔒 Los roles ahora solo dan beneficio si los ganaste en un cofre

Tenías razón en que mucha gente ya tenía los roles puestos de antes. Ahora, tener el rol en Discord ya NO alcanza — además tiene que constar que lo ganaste en un cofre de Xerion al menos una vez (el conteo que ya se guardaba por cada rol). Si un admin te lo pone a mano, o te lo agregás vos, no vas a recibir el ingreso pasivo, el bonus de Feathers, ni se te va a contar para logros — hasta que lo saques de un cofre de verdad. Esto se aplicó a los 8 roles por igual (los 5 originales y los 3 del Cofre OG), y a todos los lugares donde importa: `/claim`, `/daily`, `/profile`, `/cooldowns`, `/achievements`, y el bonus de Feathers al abrir un cofre. `/claim` y `/profile` ahora te avisan explícitamente si tenés un rol puesto que no te está dando nada, y por qué.

## 📬 Notificaciones por DM también para portales

`/notification` ahora te avisa por DM tanto cuando aparece un cofre como cuando se abre un portal — mismo toggle, no hace falta activar nada aparte.

## 🎰 RNG: confirmado el ritmo que pediste

El canje ya estaba exactamente en la proporción que diste de ejemplo: 1000 Fragmentos = 500 Feathers (0.5 por Fragmento). No hizo falta tocar nada ahí — sigue siendo difícil de acumular porque los objetos comunes solo dan 2–6 Fragmentos cada uno.

---



- El Boss ahora elimina en **rondas reales** (hasta 4), cada una con su propio mensaje tipo "El Boss ataca a **@fulano** — ¡eliminado!", con pausa entre ronda y ronda — mismo ritmo dramático que ya tenía la eliminación de los cofres, pero con canvas en vez de solo texto.
- El canvas del portal ahora tiene **iconos de verdad**: una cara de Boss sobre la silueta central, un ícono de KO sobre cada participante eliminado, y una corona sobre el ganador en el frame final — nada de esto estaba antes, era solo círculos y colores.
- El frame de apertura muestra a todos de pie antes de que empiece la pelea, para que se sienta como el inicio de algo, no un resultado instantáneo.

## 🕶️ Cofre OG — nuevo, mucho más raro que el Abismo

- 4to tipo de cofre. Su probabilidad de aparecer es ~16 veces menor que la del Abismo, y tiene su color propio, totalmente distinto de los otros 3.
- 3 roles exclusivos y propios — **9K**, **3K** y **OG** — que no comparten nada con ARISE/KING/GOAT/AURA INFINITE/STAR X. Menos probabilidad de rol que el Abismo, más probabilidad de Feathers (y en mayor cantidad), tal cual pediste.
- Los 3 tienen beneficios reales integrados en todo el bot — ingreso pasivo por `/claim`, bonus de Feathers, se muestran en `/profile` y `/cooldowns` — exactamente igual que los otros 5, no un sistema aparte.
- 4 logros nuevos: uno por cada rol del OG, y uno extra ("La Triple Corona") por tener los 3 a la vez. El logro "Coleccionista" viejo se dejó tal cual estaba (los 5 roles originales) — de otra forma, con 8 roles en vez de 5, se hubiera vuelto casi imposible de conseguir.
- 🐛 **Bug real que encontré y arreglé antes de que llegara a tus manos:** el mensaje de resultado del cofre tenía un mapa de "frase de sabor" por rol que no incluía a los 3 nuevos — abrir el Cofre OG y ganar un rol iba a mostrar literalmente `*undefined*` en el mensaje. Lo detecté con una prueba que arma cada combinación posible de cofre+recompensa y revisa el texto real, no solo si tira error. Encontré y arreglé 3 mapas de roles más con el mismo problema (etiquetas de perfil, iconos de la ruleta) antes de que ninguno llegara a mostrarse roto.

## 🎰 Minijuego de RNG — `/roll`, `/sell`, `/redeem`

- `/roll` (15 Feathers): 7 niveles de rareza, desde Común hasta **Secreto** — 1 entre 10.000 tiradas, extremadamente difícil a propósito. Animación de carta tipo gacha, cuarta identidad visual de canvas del bot (vertical, con orbe y destellos — nada que ver con la tira de cofres, el ring de portales o la ruleta de eventos).
- `/sell`: vende todo tu inventario de RNG de una sola vez por Fragmentos.
- `/redeem`: canjea todos tus Fragmentos por Feathers.
- Balance probado con 500.000 tiradas simuladas: el valor esperado de una tirada (en Feathers, vendiendo y canjeando todo) es menor al costo de tirar — es un sumidero de Feathers, no una forma de generarlas gratis.

## Limpieza de comandos

- Afuera: `/ping` (se fusionó dentro de `/about`, que ahora también muestra la latencia) y `/rules` (ya lo dijiste — comando de relleno).
- Adentro: `/roll`, `/sell`, `/redeem`.

## Tienda

- Precios subidos: Escudo 220, Amuleto de Suerte 350, Pluma Fénix 650, Amuleto contra el Vacío 750, Acelerador Temporal 500.

## Cómo se probó esta vez

Además de lo de siempre (sintaxis, requires), esta vez la prueba incluyó: 200.000 tiradas simuladas de probabilidad de cofres/RNG comparando el resultado real contra el esperado, cada combinación de cofre × recompensa posible (incluido el Cofre OG) revisando el texto real en busca de "undefined"/"NaN", una pelea de portal completa con 5 participantes verificando que el pozo se reparte exacto, y los 3 comandos de RNG de punta a punta.

---



La v2.0.2 se probó leyendo el código y con requires/sintaxis, pero no ejecutando cada flujo con datos reales — por eso se colaron estos bugs. Para esta versión, cada arreglo de abajo se confirmó corriendo el código de verdad (no solo revisándolo), incluyendo un barrido que construye los ~30 paneles del bot con datos de prueba y busca literalmente "NaN"/"undefined" en el texto que arman.

## 🔴 El bug grande: 3 constantes de portal se leían mal, y explican todo lo que reportaste

En `config.js`, `PORTAL_SPAWN_CHANCE`, `PORTAL_CHECK_INTERVAL_MS` y `PORTAL_JOIN_WINDOW_MS` viven como constantes propias — **no** dentro del objeto `CONFIG`. El código (ya desde antes de esta ronda) las leía como `CONFIG.PORTAL_SPAWN_CHANCE` etc., que siempre da `undefined`. Eso causaba, en cadena:

- **La probabilidad en `/portals` salía como NaN** — `undefined * 100` es literalmente `NaN`. Confirmado y arreglado: ahora muestra el % real.
- **El portal se cerraba solo y no dejaba entrar** — el cierre se agenda con `setTimeout(fn, undefined)`, y JavaScript trata un delay inválido como `0`. El portal se resolvía casi al instante en vez de esperar los 10 minutos reales, así que para cuando alguien completaba el modal de apuesta, ya se había cerrado. Confirmado con un test que agenda el timer de verdad: antes hubiera cerrado en ~0ms, ahora cierra a los 600000ms (10 min) exactos.
- **El chequeo de "cada 1 hora" tampoco frenaba nada**, así que el bot intentaba tirar el dado de spawn de portal muchas más veces de lo debido.
- Como bonus del mismo chequeo: la animación de batalla del portal le pasaba solo el color (un número) a la función de canvas en vez del tipo de portal completo — no explotaba, pero pintaba el resplandor en negro en vez del color real del rango.

Las tres constantes ahora se importan correctamente y se usan sin el prefijo `CONFIG.` en los 5 lugares donde estaban mal.

## `/spawn` fuera, `/cooldowns` adentro

Tenías razón — con `/panel-owner` ya cubriendo forzar cofres, `/spawn` no aportaba nada que el panel no hiciera. Se lo saca del todo (la función interna que usa el panel para forzar cofres sigue intacta, solo se quitó el comando duplicado). En su lugar, `/cooldowns` (`xn cooldowns`): de un vistazo, cuándo se recarga tu `/daily` y el ingreso pasivo de cada rol que tenés ahora mismo — no tocaba ningún dato nuevo, así que es de bajo riesgo.

---

# Xerion v2.0.2 ULTRA — Qué cambió

## 🔴 Arreglo: la IA dejaba de responder cuando Groq retiraba un modelo

- Confirmado: Groq retiró `llama-3.1-8b-instant` **y** `llama-3.3-70b-versatile` el 16 de agosto de 2026 (lo del "16" era correcto). El modelo que ya tenías configurado (`openai/gpt-oss-20b`) es justamente el reemplazo oficial y sigue activo — no estaba roto.
- Por las dudas de que esto vuelva a pasar (o de que `GROQ_MODEL` quede apuntando a algo viejo en Render), `ai.js` ahora reintenta automáticamente una vez con un modelo de respaldo fijo si detecta que el modelo configurado fue descontinuado, y loguea el error real de Groq (no solo el código HTTP) para que se pueda diagnosticar sin adivinar.

## Sistema de Eventos Globales (nuevo, completo)

- **10 eventos**, elegidos con una ruleta ponderada — mismo mecanismo que un rol de cofre — para que la probabilidad de cada uno sea real y no se pueda romper la economía: Suerte Ancestral 🍀, Lluvia de Plumas 🐦‍🔥, Vacío Debilitado 💨, Portales Inestables 🌀, Cofres Abundantes 🩶, Presagio del Abismo 🌑, Racha Bendecida 🔥, Ingreso Real 👑, Mercado Generoso 🛒 y Portal Dorado 🔴.
- Un evento a la vez, dura entre 10 y 20 minutos, y sus multiplicadores son moderados a propósito (1.5x–2x) — un empujón, no un atajo.
- **Ruleta en Canvas totalmente nueva y distinta** a las otras dos del bot: un círculo real dividido en 10 gajos de color (como una ruleta de casino), con un puntero fijo y el gajo ganador resaltado — nada de reciclar el diseño de cofres ni el de portales.
- Todo cofre que aparezca mientras el evento está activo muestra el aviso en su propio embed ("🎉 Evento activo: ..."), la tienda muestra el precio tachado si hay descuento, y `/event` (`xn event`) deja ver en cualquier momento si hay uno activo y cuánto le queda.
- Se activa (aleatorio o forzado) y se cancela desde `/panel-owner` — ver abajo.
- Persiste igual que los cofres y portales: si el bot se reinicia a mitad de un evento, lo retoma exacto (o lo limpia solo si ya había vencido mientras estuvo caído) — nunca se pierde ni se reinicia nada.

## `/panel-owner` (nuevo — la pieza que quedó pendiente en la v1.9.3)

- Panel Ephemeral Components V2 único para el owner: forzar cualquier tipo de cofre, forzar cualquier rango de portal, y activar/cancelar un evento global — todo desde el mismo mensaje, que se actualiza solo después de cada acción.
- `/spawn` se mantiene tal cual para no romper nada que ya tuvieras automatizado, pero `/panel-owner` es ahora el centro de control completo.

## Portales: ya estaban, ahora conectados

- El motor de portales (3 rangos, apuesta con modal, Boss eliminando gente, reparto real por cuánto apostó cada uno) ya estaba completo desde la v1.9.3 — lo que faltaba era conectarlo al panel del owner y avisar que existía. Ambas cosas, resueltas: `/panel-owner` fuerza portales, y `/portals` (`xn portals`) muestra las probabilidades y el reparto de los 3 rangos en cualquier momento.

## Limpieza de comandos

- **Fuera:** `/rank` y `/rewards` — el primero ya estaba casi entero duplicado en `/profile` (se le sumó ahí la única parte que le faltaba: cuánto te falta para subir un puesto); el segundo era un resumen más corto de lo que `/rates` ya muestra completo.
- **Nuevos:** `/portals`, `/event`, `/panel-owner`.
- Con esto el bot queda en 7 archivos (antes 5 — se sumó `admin-panel.js` para el panel nuevo) y 21 comandos — bien por debajo del nuevo techo de 15 archivos / 39 comandos: se prefirió sumar lo que de verdad suma en vez de rellenar hasta el número.

## Tienda: techo de 5 items, ahora explícito

- Ya estaba en exactamente 5 (Escudo, Amuleto, Pluma Fénix, Amuleto contra el Vacío, Acelerador Temporal) — coincidía con el máximo de 5 botones por fila de Discord, pero era casualidad, no una regla. Ahora es una constante (`SHOP_MAX_ITEMS`) que además avisa fuerte en el arranque si algún día se agrega un sexto por error.

## Ya estaba resuelto (verificado de nuevo en esta pasada, sin tocar)

Revisando el código a fondo para esta actualización, esto ya estaba andando bien desde antes y no hizo falta arreglarlo:

- Los beneficios de rol (`/claim`, logros, income pasivo) se calculan contra los roles reales de Discord del usuario en este momento, no contra el historial — si se te quita el rol, se te corta el beneficio al instante.
- Las probabilidades de rol de los 3 tipos de cofre suman exactamente 100% cada una.
- Los botones de `/leaderboard` (y los de tienda, notificaciones y racha) ya estaban bloqueados a quien los pidió — otra persona que los toque recibe un aviso, no puede usarlos.
- La IA solo responde a un `@Xerion` explícito o a una respuesta directa a uno de sus propios mensajes — nunca a mensajes de eliminación ni a `@everyone`/`@here`.
- Nada del estado del bot (cofres activos, portales activos, y ahora también eventos) se pierde ni se reinicia si el bot se reinicia — todo vive en Postgres.

## Pendiente de tu parte

- **DNS/dominio para la verificación de Render:** no llegó ninguna imagen en el mensaje, así que no se tocó nada de esto — mandá la captura y se resuelve puntual.

---



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
