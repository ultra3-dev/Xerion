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

**Ganancia (10):** `work` · `crime` · `beg` · `scavenge` (`scav`) · `harvest` ·
`candyraid` (`raid`) · `daily` · `collect` · `trickortreat` (`tot`) · `rob`

**RPG (11):** `class` · `hunt` · `duel` · `dungeon` (`dg`) · `boss` · `quest` ·
`redeem-code` (`rc`) · `level` · `achievements` (`ach`) · `armory` (`arm`) · `equip`

**Casino (6):** `gamble` (`sg`) · `slots` · `blackjack` (`bj`) · `dice` ·
`roulette` · `wheel`

**Tiendas (5):** `shop` · `eventshop` (`evshop`) · `buy` · `use` · `potions`

**Información (2):** `eventinfo` (`einfo`) · `help`

**Administración (4, solo `OWNER_ID`):** `addcandy` (`add`) · `removecandy`
(`rm`) · `setdebt` (`sd`) · `resetuser` (`reset`)

`xn help` muestra las categorías y controles. `balance`, `profile` e
`inventory` y `debt` consultan al usuario mencionado cuando se usa `@usuario`.

## Tienda e ingresos del evento

`xn shop` y `xn eventshop` publican un botón de acceso; el catálogo se abre en
un mensaje privado (Ephemeral). Los recibos de compras con botones también son
privados. Las respuestas normales de comandos de prefijo siguen siendo
públicas.

El evento corre en UTC desde el **3 de octubre hasta el 9 de noviembre de 2026,
inclusive**. Tener un rol en Discord no activa por sí solo su ingreso: se debe
activar en la tienda del bot durante el evento. La activación cuesta la mitad
del precio publicado y consume los materiales indicados en el catálogo. Si ya
tienes ese rol, el bot no lo vuelve a asignar. `xn collect` reclama el ingreso
del **mejor rol comprado**; no suma los ingresos de varios roles ni guarda
reclamos pendientes. Los cooldowns dependen del rol: el de mayor rango entrega
369.000 Candys y vuelve a estar disponible después de 3 días. El último `daily`
del evento es el 9 de noviembre UTC.

## Dashboard privado y canjes

El dashboard está disponible en `/dashboard` dentro del mismo servicio del bot.
Configura `DASHBOARD_PASSWORD` y `SESSION_SECRET` como variables privadas en
Render; usa una contraseña nueva y un secreto aleatorio largo, y no los guardes
en GitHub ni los pegues en el chat. El dashboard permite crear, ver y eliminar
códigos con fecha de vencimiento y recompensa en Candys. Un usuario puede
canjear cada código una sola vez desde nivel 10 con `xn redeem-code <código>` o
`xn rc <código>`.

El reinicio global exige iniciar sesión, solicitar un código por DM al dueño,
ingresarlo antes de que venza y confirmar el borrado en el panel. Borra el
progreso y los canjes de todas las cuentas; conserva la lista de códigos. Si la
cuenta del bot no puede enviar un DM al dueño, el reinicio no continúa.

## Render

`render.yaml` configura un servicio web **Starter** y comprueba `/health`.
Para crearlo desde el panel:

1. Abre Render y elige **New → Blueprint**.
2. Conecta GitHub y selecciona `ultra3-dev/Xerion`, rama `main`.
3. Revisa el Blueprint que Render lee desde `render.yaml` y continúa con
   **Deploy Blueprint**.
4. Cuando Render pida las variables privadas, completa `BOT_TOKEN` con el token
   del bot de Discord, `DATABASE_URL` con la URL de conexión de Neon,
   `DASHBOARD_PASSWORD` con una contraseña nueva y `SESSION_SECRET` con un valor
   aleatorio de al menos 32 bytes. Escríbelas directamente en Render; nunca las
   guardes en GitHub ni las pegues en el chat.
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