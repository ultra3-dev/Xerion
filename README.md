# Xerion v1.0

Bot de Discord de un solo archivo (`index.js`): sistema de cofres con aparición
aleatoria, minijuego de eliminación tipo "sobrevive el último", economía propia
y estadísticas. Hecho con discord.js v14 (Components V2), Express y Postgres
(Neon).

## Antes de arrancar

1. **Crea la aplicación** en el [Discord Developer Portal](https://discord.com/developers/applications).
2. En la pestaña **Bot**, activa estos dos *Privileged Gateway Intents*
   (son obligatorios, si no el bot no funcionará):
   - `MESSAGE CONTENT INTENT` (para los comandos con prefijo `xn`)
   - `SERVER MEMBERS INTENT` (para poder asignar los roles de recompensa)
3. **Invita el bot** con estos permisos mínimos: Ver canales, Enviar
   mensajes, Insertar enlaces, Leer historial de mensajes, Usar emojis
   externos, **Gestionar roles**. El rol del bot debe estar **por encima**
   en la jerarquía de los tres roles de recompensa (AURA INFINITE, KING,
   ARISE), o no podrá asignarlos.
4. Crea una base de datos gratuita en [Neon](https://neon.tech) y copia su
   cadena de conexión.

## Variables de entorno

Copia `.env.example` a `.env` y rellena:

- `DISCORD_TOKEN` — token del bot.
- `DATABASE_URL` — cadena de conexión de Neon.
- `GUILD_ID` — (opcional, recomendado) ID de tu servidor, para que los
  comandos slash se registren al instante en vez de tardar ~1 hora.
- `PORT` — solo en local; Render lo asigna automáticamente.

## Ejecutar en local

```bash
npm install
npm start
```

## Desplegar en Render

1. Sube este proyecto a un repositorio de GitHub.
2. En Render, crea un **Web Service** apuntando a ese repositorio.
3. Build command: `npm install` — Start command: `npm start`.
4. Añade las variables de entorno (`DISCORD_TOKEN`, `DATABASE_URL`,
   `GUILD_ID`) en la sección *Environment* de Render.
5. Una vez desplegado, Render te da una URL pública (algo como
   `https://xerion-bot.onrender.com`) — ahí vive la página informativa.

## Mantenerlo despierto con UptimeRobot

Los servicios gratuitos de Render se duermen tras un rato de inactividad.
Crea un monitor HTTP(s) en [UptimeRobot](https://uptimerobot.com) apuntando
a `https://tu-app.onrender.com/health` con un intervalo de 5 minutos.

## Ajustar el bot a tu servidor

Todo lo específico de tu servidor (canal del cofre, ID del dueño, roles,
probabilidades, prefijo) está centralizado al principio de `index.js`, en
el objeto `CONFIG`. Puedes editar ahí las probabilidades de recompensa,
el nombre de la moneda, los tiempos de espera, etc.

## Notas de diseño

- **Embeds clásicos vs. Components V2**: Discord no permite mezclar
  `embeds` con Components V2 en el mismo mensaje. El cofre, la
  eliminación y la apertura usan **embeds clásicos + botones** (más
  estables para algo tan dinámico). Los paneles de información
  (`/profile`, `/inventory`, `/leaderboard`, `/rates`, `/help`) usan
  **Components V2** (`Container`, `TextDisplay`, `Separator`,
  `ActionRow`) para mostrar esa parte del stack más moderno.
- El contador de mensajes y los datos de cada usuario viven en Postgres,
  así que sobreviven a reinicios del bot. El único estado que se pierde
  si el bot se reinicia a mitad de un cofre es ese cofre en curso.
- Solo hay un cofre activo a la vez por canal.
