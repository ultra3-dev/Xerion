# Xerion v2.0.2 ULTRA

Bot de Discord (`index.js` + módulos): un cofre puede aparecer en cualquier momento, todos entran pensando que es un sorteo normal, pero en realidad es una eliminación tipo "último en pie" — solo quien sobrevive tiene la oportunidad de abrirlo. Además, cada hora puede abrirse un **Portal** (apuesta con Feathers, estilo Solo Leveling) y el owner puede activar **Eventos Globales** temporales desde `/panel-owner`. Hecho con **discord.js v14 (Components V2)**, **Express**, **PostgreSQL (Neon)** y **@napi-rs/canvas**.

## Cómo funciona

1. En el canal configurado la probabilidad empieza en 0% y sube 1% por cada 100 mensajes sin cofre. El contador es exclusivo de ese canal y se conserva en PostgreSQL.
2. Todos pulsan **Participate**. Tienen 5 minutos.
3. Cuando el tiempo se acaba, empieza la eliminación: uno por uno (o por lotes si hay mucha gente), narrada mensaje por mensaje, hasta que queda un solo sobreviviente.
4. El sobreviviente pulsa **Open**: animación de ruleta con canvas y un resultado — un rol exclusivo, algo de la moneda del bot (Feathers 🐦‍🔥), o nada.
5. Además, cada hora hay una probabilidad de que se abra un **Portal** (3 rangos: E/B/S) en su propio canal — se apuesta Feathers para entrar, el Boss va eliminando participantes, y quien sobrevive se lleva la mayor parte del pozo. El owner puede forzar uno específico desde `/panel-owner`.
6. El owner también puede activar un **Evento Global** (10 posibles, ponderados como los roles) desde `/panel-owner` — una ruleta Canvas distinta anuncia cuál tocó, y su efecto (más suerte, más Feathers, cofres más frecuentes, etc.) dura entre 10 y 20 minutos para todo el servidor.

## 1. Crear la aplicación en Discord

1. Ve a [discord.com/developers/applications](https://discord.com/developers/applications) y crea una aplicación nueva.
2. En **Bot**, crea el bot y copia el token (`DISCORD_TOKEN`).
3. En la misma página, activa estos dos **Privileged Gateway Intents** (son obligatorios, si no los activas el bot no podrá leer mensajes con prefijo ni asignar roles):
   - **MESSAGE CONTENT INTENT**
   - **SERVER MEMBERS INTENT**
4. En **General Information**, copia el **Application ID** (`CLIENT_ID`).
5. En **OAuth2 > URL Generator**, marca los scopes `bot` y `applications.commands`, y en permisos marca al menos:
   - View Channels, Send Messages, Embed Links, Read Message History, Use External Emojis, **Manage Roles**
6. Abre la URL generada e invita el bot a tu servidor.
7. **Importante:** en la lista de roles de tu servidor, el rol del bot debe quedar **por encima** de los cinco roles de recompensa (AURA INFINITE, KING, GOAT, ARISE, STAR X), o no podrá asignarlos — Discord no deja que un bot otorgue un rol más alto que el suyo. El rol de **Black List** no necesita ninguna posición especial: el bot solo lo lee, nunca lo asigna ni lo quita.

## 2. Base de datos (Neon)

1. Crea un proyecto gratis en [neon.tech](https://neon.tech).
2. Copia el **Connection string** (con `?sslmode=require`) → esa es tu `DATABASE_URL`.
3. No necesitas crear tablas a mano: el bot las crea solo la primera vez que arranca.

## 3. Variables de entorno

En Render, estas se ponen directo en el dashboard del servicio (**Environment**) — no hace falta ningún archivo:

```
DISCORD_TOKEN=
CLIENT_ID=
GUILD_ID=        # opcional, solo para pruebas — ver abajo
DATABASE_URL=
GROQ_API_KEY=    # opcional — activa el chat de IA (solo si le mencionás o respondés a sus mensajes)
GROQ_MODEL=      # opcional, por defecto openai/gpt-oss-20b (reemplazo oficial de Groq desde el 16 ago 2026)
```

`GUILD_ID` es opcional: si lo pones, los slash commands se registran al instante pero **solo en ese servidor** (ideal mientras pruebas). Sin él, el registro es global y la primera vez puede tardar hasta 1 hora en aparecer en todos los servidores.

`GROQ_API_KEY` también es opcional: sin ella, el bot funciona exactamente igual, simplemente sin el chat de IA. El chat SOLO responde si lo mencionás (`@Xerion hola`) o si respondés a uno de sus propios mensajes — nunca a mensajes sueltos ni de eliminación. Groq retiró `llama-3.1-8b-instant` y `llama-3.3-70b-versatile` el 16 de agosto de 2026; si en el futuro vuelve a pasar con el modelo configurado, `ai.js` reintenta automáticamente con el modelo de respaldo antes de rendirse — revisá los logs si el chat deja de responder. Sacá tu key gratis en [console.groq.com](https://console.groq.com).

Todo lo específico de tu servidor (canal del cofre, ID del dueño, IDs de los roles, probabilidades, prefijo) vive en el objeto `CONFIG` al principio de `index.js` — no en variables de entorno, para que sea fácil de editar de un vistazo.

## 4. Correr en local

```
npm install
npm start
```

## 5. Desplegar en Render

1. Sube este proyecto a un repositorio de GitHub.
2. En Render, crea un **Web Service** (no "Background Worker" — necesitas el puerto HTTP para el paso 6) apuntando a tu repo.
3. Build command: `npm install`
4. Start command: `npm start`
5. En **Environment**, añade `DISCORD_TOKEN`, `CLIENT_ID` y `DATABASE_URL` (Render define `PORT` solo). Si quieres el chat de IA, añade también `GROQ_API_KEY`.
6. Node: este proyecto pide Node **22.12 o superior** (ya está declarado en `package.json`, Render lo detecta solo).

## 6. UptimeRobot (para que no se duerma)

Los Web Services gratuitos de Render se suspenden tras ~15 minutos sin tráfico. Para evitarlo:

1. Crea un monitor **HTTP(s)** en [uptimerobot.com](https://uptimerobot.com).
2. URL: `https://tu-servicio.onrender.com/health`
3. Intervalo: 5 minutos.

Esa misma URL sirve para comprobar de un vistazo que el bot sigue conectado a Discord (`discordReady: true` en la respuesta).

La página principal (`/`) es la web informativa — solo información sobre el bot, sin panel ni login, tal como se pidió.

## Decisiones de diseño (por si tocas el código)

- **Embeds clásicos vs. Components V2:** Discord no permite mezclar embeds con Components V2 en un mismo mensaje. El flujo del cofre (aparición, eliminación, apertura) usa embeds clásicos + botones porque se edita muchas veces en poco tiempo y es más predecible. Los paneles de información (`/profile`, `/leaderboard`, `/rates`, `/help`, `xn inv`) usan Components V2 real.
- **Estado en memoria vs. base de datos:** las estadísticas de cada jugador, el contador de mensajes y los cofres activos viven en Postgres y sobreviven a reinicios. El bot reconstruye la partida por canal y continúa la fase pendiente sin borrar el progreso.
- **Canvas:** la animación de apertura dibuja solo formas, degradados y texto — nunca emojis dentro de la imagen. Los emojis siempre los pone Discord de forma nativa en el texto de los mensajes (o se cargan como imagen PNG desde Twemoji para los que sí van dentro del canvas, como los iconos de rol y de evento), así nunca salen "bugueados". Si el motor de canvas llegara a fallar en tu entorno por lo que sea, el bot lo detecta y sigue con un resultado en texto en vez de romper la secuencia.
- **Eventos globales:** cada uno tiene un multiplicador moderado (1.5x–2x, nunca más) y dura 10–20 minutos, a propósito — la idea es un empujón temporal, no romper la rareza de los roles. Se eligen con una ruleta ponderada igual que un rol de cofre (ver `EVENT_TYPES` en `config.js`), y un solo evento puede estar activo a la vez.

## Comandos

**Slash:** `/spawn` (solo dueño), `/panel-owner` (solo dueño — forzar cofres, forzar portales, activar/cancelar evento), `/profile [usuario]`, `/inventory`, `/leaderboard`, `/rates`, `/portals`, `/event`, `/shop`, `/notification`, `/stats`, `/help`, `/chest`, `/daily`, `/claim`, `/history`, `/achievements`, `/streak`, `/ping`, `/about`, `/rules`
**Prefijo (`xn`):** todos los comandos anteriores también funcionan con `xn` y alias en español como `xn top`, `xn cofre`, `xn diario`, `xn logros`, `xn portales`, `xn evento` y `xn reglas`.
