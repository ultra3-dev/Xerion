# Xerion v1.0

Bot de Discord de un solo archivo (`index.js`): un cofre puede aparecer en cualquier momento, todos entran pensando que es un sorteo normal, pero en realidad es una eliminación tipo "último en pie" — solo quien sobrevive tiene la oportunidad de abrirlo. Hecho con **discord.js v14 (Components V2)**, **Express** y **PostgreSQL (Neon)**.

## Cómo funciona

1. Cada 10 mensajes en el canal configurado, hay 0.3% de probabilidad de que aparezca un cofre (o se puede forzar con `/spawn`, solo para el dueño configurado).
2. Todos pulsan **Participate**. Tienen 5 minutos.
3. Cuando el tiempo se acaba, empieza la eliminación: uno por uno (o por lotes si hay mucha gente), narrada mensaje por mensaje, hasta que queda un solo sobreviviente.
4. El sobreviviente pulsa **Open**: animación de ruleta con canvas y un resultado — un rol exclusivo, algo de la moneda del bot (Feathers 🐦‍🔥), o nada.

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
7. **Importante:** en la lista de roles de tu servidor, el rol del bot debe quedar **por encima** de los tres roles de recompensa (AURA INFINITE, KING, ARISE), o no podrá asignarlos — Discord no deja que un bot otorgue un rol más alto que el suyo.

## 2. Base de datos (Neon)

1. Crea un proyecto gratis en [neon.tech](https://neon.tech).
2. Copia el **Connection string** (con `?sslmode=require`) → esa es tu `DATABASE_URL`.
3. No necesitas crear tablas a mano: el bot las crea solo la primera vez que arranca.

## 3. Variables de entorno

Copia `.env.example` a `.env` y rellena:

```
DISCORD_TOKEN=
CLIENT_ID=
GUILD_ID=        # opcional, solo para pruebas — ver abajo
DATABASE_URL=
```

`GUILD_ID` es opcional: si lo pones, los slash commands se registran al instante pero **solo en ese servidor** (ideal mientras pruebas). Sin él, el registro es global y la primera vez puede tardar hasta 1 hora en aparecer en todos los servidores.

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
5. En **Environment**, añade `DISCORD_TOKEN`, `CLIENT_ID` y `DATABASE_URL` (Render define `PORT` solo).
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
- **Estado en memoria vs. base de datos:** las estadísticas de cada jugador y el contador de mensajes viven en Postgres y sobreviven a reinicios. Lo único que se pierde si Render reinicia el proceso es el cofre que esté a mitad de partida en ese momento — es un caso extremadamente raro (la ventana de un cofre dura pocos minutos) y el bot lo maneja sin romperse: los botones de un cofre "huérfano" simplemente responden que ya no está activo.
- **Canvas:** la animación de apertura dibuja solo formas, degradados y texto — nunca emojis dentro de la imagen. Los emojis siempre los pone Discord de forma nativa en el texto de los mensajes, así nunca salen "bugueados". Si el motor de canvas llegara a fallar en tu entorno por lo que sea, el bot lo detecta y sigue con un resultado en texto en vez de romper la secuencia.

## Comandos

**Slash:** `/spawn` (solo dueño), `/profile [usuario]`, `/leaderboard`, `/rates`, `/help`
**Prefijo (`xn`):** `xn inv`, `xn top`, `xn help`
