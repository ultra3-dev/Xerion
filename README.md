# 🍬 Halloween Economy Bot (Xn) — v1.0.0 Halloween Release

Bot de Discord de economía de Halloween con RPG, casino y **50 comandos**. Usa
Components V2 y el prefijo `xn` (no distingue mayúsculas).

## Instalación local

Requiere Node.js 18 o superior.

```sh
npm ci
cp .env.example .env
npm start
```

Configura `BOT_TOKEN` en `.env`. Para desarrollo puedes dejar `DATABASE_URL`
vacío y se usará `data/economy.json`. En producción, `DATABASE_URL` es
obligatorio: el bot falla al iniciar si falta, en lugar de perder progreso en
el disco efímero.

## Persistencia con Neon

Configura la URL de conexión como `DATABASE_URL` en el entorno del servicio.
El bot usa la tabla existente `public.xerion_economy_users` (JSONB por perfil)
y la crea solo si no existe. No requiere copiar credenciales al código ni al
ZIP. Si la tabla está vacía y encuentra un `data/economy.json` local, importa
los perfiles una vez; nunca reemplaza una tabla que ya contiene datos.

## Preparación de Discord

En Discord Developer Portal → **Bot**, activa:

- Message Content Intent
- Server Members Intent

El bot necesita ver canales, enviar mensajes, insertar enlaces y gestionar
roles. Para entregar roles, coloca el rol del bot por encima de los nueve roles
del evento.

## Comandos (50)

**Economía (12):** `balance` (`bal`, acepta `@usuario`) · `profile` (acepta
`@usuario`) · `deposit` (`dep`) · `withdraw` (`with`) · `pay` · `debt` ·
`paydebt` (`pd`) · `bounty` (`bnt`) · `leaderboard` (`top`) · `serverstats`
(`stats`) · `cooldowns` (`cd`) · `inventory` (`inv`, acepta `@usuario`)

**Ganancia (11):** `work` · `crime` · `beg` · `scavenge` (`scav`) · `harvest` ·
`candyraid` (`raid`) · `daily` · `collect` · `trickortreat` (`tot`) · `rob` ·
`redeem-code` (`rc`, disponible desde nivel 10)

**RPG (10):** `class` · `hunt` · `duel` · `dungeon` (`dg`) · `boss` · `quest` ·
`level` · `achievements` (`ach`) · `armory` (`arm`) · `equip`

**Casino (6):** `gamble` (`sg`) · `slots` · `blackjack` (`bj`) · `dice` ·
`roulette` · `wheel`

**Tiendas (5):** `shop` · `eventshop` (`evshop`) · `buy` · `use` · `potions`

**Información (2):** `eventinfo` (`einfo`) · `help`

**Administración (4, solo `OWNER_ID`):** `addcandy` (`add`) · `removecandy`
(`rm`) · `setdebt` (`sd`) · `resetuser` (`reset`)

El dashboard privado en `/admin` permite crear y eliminar códigos con fecha de
vencimiento, y solicitar un reinicio global. Para habilitarlo, configura
`DASHBOARD_SECRET` como variable secreta de al menos 32 bytes en el entorno del
servicio. Los códigos se canjean una sola vez por usuario; el reinicio global
restablece perfiles, pero conserva los códigos. La confirmación del reinicio
requiere un token de un solo uso enviado por DM al dueño del bot.

`xn help` muestra las categorías y controles. `balance`, `profile` e
`inventory` consultan al usuario mencionado cuando se usa `@usuario`.

## Tienda e ingresos del evento

`xn shop` y `xn eventshop` publican un botón de acceso; el catálogo se abre en
un mensaje privado (Ephemeral). Los recibos de compras con botones también son
privados. Las respuestas normales de comandos de prefijo siguen siendo
públicas.

El evento está activo desde <t:1791081000:F> (**4 de octubre de 2026, 02:30 UTC**)
hasta <t:1794256200:F> (**9 de noviembre de 2026, 20:30 UTC**); el fin es
exclusivo. Discord convierte los timestamps a la zona horaria local de cada
persona.

Juega los comandos de economía para ganar Candys y encontrar los materiales de
Halloween; consulta tu inventario con `xn inventory`. Abre `xn eventshop` para
ver los nueve roles, sus costos y recetas. Cada rol se compra con Candys y
materiales; luego se activa pagando la mitad adicional de su precio. Si ya
tienes ese rol de Discord, el bot no lo vuelve a asignar.

`xn collect` entrega el ingreso del **mejor rol activado**: los ingresos de varios
roles no se suman y cada reclamo tiene el cooldown mostrado en la tienda. Por
ejemplo, STAR X entrega 12.000 Candys cada 4 horas y Spooky Season entrega
369.000 cada 72 horas. No se pueden comprar, activar ni reclamar ingresos nuevos
a partir del cierre exacto del evento. `xn daily` da el bono de cierre de
50.000 Candys en el último día UTC del evento, solo si se reclama antes del
cierre y el cooldown permite reclamarlo.

`xn top` muestra el top global paginado de ricos o endeudados. Usa nombres
guardados o ya disponibles en caché como texto literal `@nombre`, sin menciones ni
notificaciones; si no hay un nombre disponible, muestra `Jugador sin nombre`.

## Render

`render.yaml` configura un servicio web **Starter** y comprueba `/health`.
Para crearlo desde el panel:

1. Abre Render y elige **New → Blueprint**.
2. Conecta GitHub y selecciona `ultra3-dev/Xerion`, rama `main`.
3. Revisa el Blueprint que Render lee desde `render.yaml` y continúa con
   **Deploy Blueprint**.
4. Cuando Render pida las variables privadas, completa `BOT_TOKEN` con el token
   del bot de Discord, `DATABASE_URL` con la URL de conexión de Neon y
   `DASHBOARD_SECRET` con un secreto nuevo, aleatorio y de al menos 32 bytes.
   Escríbelas directamente en Render; nunca las guardes en GitHub ni las pegues
   en el chat.
5. Espera a que el servicio aparezca como **Live**. El build ejecuta `npm ci`,
   inicia con `npm start` y el health check usa `/health`.

El Blueprint fija `NODE_ENV=production`, por lo que el bot exige `DATABASE_URL`
y no cae en almacenamiento local efímero. Render publica Starter a US$7/mes;
Free puede suspenderse tras 15 minutos sin tráfico y desconectar el bot. Neon,
impuestos u otros recursos pueden sumar cargos: el código no garantiza un tope
total de facturación de US$9 ni capacidad para 10.000 usuarios reales.

## Verificación sintética

Las pruebas de lógica cubren el total de comandos, límites y fechas del evento:

```sh
npm test
```

La simulación de carga puede ejecutarse por separado:

```sh
npm run load-test
```

Genera 10.000 perfiles y ejecuta acciones económicas localmente en un archivo
temporal. No llama a Discord ni a Neon y **no** demuestra capacidad de
producción, usuarios concurrentes reales o latencia de red.

## Archivos principales

| Archivo | Función |
|---|---|
| `config.js` | Recompensas, probabilidades, cooldowns, evento y tiendas |
| `database.js` | Neon/PostgreSQL en producción; JSON local en desarrollo |
| `economy.js` | Lógica de economía, RPG, casino y tienda |
| `ui.js` | Mensajes Components V2, menús y botones |
| `index.js` | Cliente Discord, listeners y comandos |
| `dashboard.js` | Dashboard privado, gestión de códigos y confirmación de reinicio |