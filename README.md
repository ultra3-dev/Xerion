# 🍬 Halloween Economy Bot (Xn) — v1.1.3

Bot de Discord de economía de Halloween con RPG, casino y **55 comandos**. Usa Components V2 y el prefijo `xn`
(no distingue mayúsculas). Base: v1.1.2 (`main` en el commit `3e56581`).

**v1.1.3:** el leaderboard conserva la mención visual silenciosa cuando Discord o el servidor resuelven el perfil; solo
usa el nombre como texto cuando la API no encuentra la cuenta.

## Instalación local

Requiere Node.js 18 o superior para ejecutar el bot (**Node 22 recomendado** para las pruebas, que usan temporizadores simulados).

```sh
npm ci
cp .env.example .env
npm start
```

Configura `BOT_TOKEN` en `.env`. Para desarrollo puedes dejar `DATABASE_URL` vacío y se usará `data/economy.json`. En
producción, `DATABASE_URL` es obligatorio: el bot falla al iniciar si falta, en lugar de perder progreso en el disco efímero.

## Persistencia con Neon

Configura la URL de conexión como `DATABASE_URL` en el entorno del servicio. El bot usa la tabla existente
`public.xerion_economy_users` (JSONB por perfil) y la crea solo si no existe. v1.1.0 **no cambia el esquema ni requiere
migraciones**: los campos nuevos viven dentro del JSON de cada perfil y se rellenan solos con valores por defecto. Si la tabla
está vacía y encuentra un `data/economy.json` local, importa los perfiles una vez; nunca reemplaza una tabla que ya contiene datos.
Antes de guardar, el bot repara cualquier saldo no finito o fuera del rango seguro (`Infinity`, `NaN`, > 2^53−1).

## Preparación de Discord

En Discord Developer Portal → **Bot**, activa Message Content Intent y Server Members Intent. El bot necesita ver canales,
enviar mensajes, **adjuntar archivos** (la mesa del blackjack es una imagen), insertar enlaces y gestionar roles. Para entregar
roles, coloca el rol del bot por encima de los nueve roles del evento.

## Comandos (55)

**Economía (13):** `balance` (`bal`, acepta `@usuario`) · `profile` (acepta `@usuario`) · `deposit` (`dep`) · `withdraw` (`with`) ·
`pay` · **`give`** (`sell`, `trade`) · `debt` · `paydebt` (`pd`) · `bounty` (`bnt`) · `leaderboard` (`top`) · `serverstats` (`stats`) ·
`cooldowns` (`cd`) · `inventory` (`inv`, acepta `@usuario`)

**Ganancia (12):** `work` · `crime` · `beg` · `scavenge` (`scav`) · `harvest` · `candyraid` (`raid`) · `daily` · `collect` ·
`trickortreat` (`tot`) · `rob` · **`interest`** (`int`) · `redeem-code` (`rc`, disponible desde nivel 10)

**RPG (12):** `class` · `hunt` · `duel` · `dungeon` (`dg`) · `boss` · `quest` · `level` · **`train`** · **`skills`** (`sk`) ·
`achievements` (`ach`) · `armory` (`arm`) · `equip`

**Casino (7):** `gamble` (`sg`) · `slots` · `blackjack` (`bj`) · `dice` · `roulette` · `wheel` · **`crash`**

**Tiendas (5):** `shop` · `eventshop` (`evshop`) · `buy` · `use` · `potions`

**Información (2):** `eventinfo` (`einfo`) · `help`

**Administración (4, solo `OWNER_ID`):** `addcandy` (`add`) · `removecandy` (`rm`) · `setdebt` (`sd`) · `resetuser` (`reset`)

Los alias **no cuentan** como comandos: hay exactamente 55 comandos reales (una prueba lo verifica).

### Los 5 comandos nuevos de v1.1.0

| Comando | Qué hace |
|---|---|
| `xn give @usuario <artículo> [cantidad\|all] <precio total>` | Venta/intercambio de pociones, materiales y armas con botones **Aceptar / Rechazar** para el destinatario (y **Cancelar** para el vendedor). Precio mínimo = 50% del valor base. Sintaxis completa, reglas, seguridad y tabla de valores en [`docs/TRADING.md`](docs/TRADING.md). |
| `xn interest` | **Ganancia:** cobra el 1% de tu Bank (mínimo 1,000 en el Bank, tope 2,500) cada 12 h. Premia guardar Candys. |
| `xn train` | **RPG:** entrenamiento sin Candys que da XP (más una pieza de material a veces) cada 45 min. |
| `xn skills` (`sk`) | **RPG:** tu hoja de personaje: clase, arma, bonos acumulados y el rango de XP por acción a tu nivel (acepta `@usuario`). |
| `xn crash <cantidad\|all> <múltiplo>` | **Casino:** la escoba de la bruja sube hasta estrellarse en un múltiplo sorteado; eliges el tuyo (x1.10–x50) y cobras `apuesta × múltiplo` si no se estrella antes. Retorno esperado 96%. Mínimo 100; ciclo de 5 usos cada 2 min y 10 min de descanso. |

El dashboard privado en `/admin` permite crear y eliminar códigos con fecha de vencimiento, y solicitar un reinicio global. Para
habilitarlo, configura `DASHBOARD_SECRET` como variable secreta de al menos 32 bytes en el entorno del servicio. Los códigos se
canjean una sola vez por usuario; el reinicio global restablece perfiles, pero conserva los códigos. La confirmación del reinicio
requiere un token de un solo uso enviado por DM al dueño del bot.

## XP y niveles

La curva de niveles **no cambió** (`nivel = ⌊√(XP/50)⌋`, `XP del nivel n = 50·n²`). Se conservan los valores base de v1.0.0
excepto `boss`, que sube de 10 a 150 para corregir su recompensa desproporcionadamente baja frente a su cooldown de 3 horas
(`XP_PER_ACTION`; v1.1.0 también añade `train` e `interest`). Lo nuevo:

- **XP aleatoria y acotada:** cada acción exitosa da un entero sorteado en `[base × 0.6, base × 1.4]` (el promedio sigue siendo la base).
- **Ajuste por nivel:** ese rango se multiplica por `min(4, 1 + 0.06 × nivel)`. Así los niveles altos —que cuestan más XP— no se
  estancan: de L10 a L50 las acciones necesarias por nivel crecen menos de 2.2× (sin el ajuste serían ~4.8×).
- **Sin XP por errores:** cooldowns, comandos inválidos, intentos fallidos, apuestas rechazadas y clics repetidos nunca dan XP; el duelo se
  reclama de forma atómica, así que un doble clic ya no puede resolverlo dos veces ni duplicar el XP del ganador.

## Blackjack

- **Mesa dibujada con canvas propio** (imagen PNG indexada de ≈75 KB) dentro de un contenedor Components V2 con la imagen incrustada,
  puntos, contador de mesa y botones. Emojis Apple con respaldo vectorial; si el canvas falla o se apaga (`BLACKJACK_CANVAS=off`) se usa el
  tablero de texto de siempre. Detalles en [`docs/CANVAS.md`](docs/CANVAS.md).
- **Tiempo de la mano: 150 s**; al agotarse el bot se planta por ti.
- **Máximo estricto de 15 cartas entre jugador y banca**, contando las iniciales. Al colocar la 15ª el jugador se planta solo y la mano se
  cierra. Si la mesa se llena antes de que la banca complete su mano (< 17) la mano es **empate** y se devuelve la apuesta: el límite
  nunca favorece a nadie. Resolver dos veces la misma mano nunca paga dos veces.
- Blackjack natural paga 2.5×, victoria 2×, empate devuelve la apuesta.

## Casino: la animación termina donde se pagó

Rueda, ruleta, tragamonedas y crash dibujan su animación **a partir del mismo objeto de resultado que decidió el pago**
(`render` no sortea nada): la posición final, el multiplicador mostrado, el premio y el mensaje son siempre la misma jugada. Una
x0.5 sorteada nunca puede mostrarse como x1. Si el premio desbordaría el saldo seguro, la apuesta se rechaza **sin gastar** un uso del cooldown.

## Dueño del bot (`OWNER_ID`)

- No puede ser víctima de `rob`, `bounty` ni de ningún comando equivalente (`economy.isTheftProtected`).
- En las vistas de saldo (`balance`, `profile`) muestra **∞** en Cash, Bank y Total. El ∞ es **solo visual**: en la base de datos siempre se
  guardan números finitos y seguros. El dueño puede comprar, apostar, transferir y robar con su saldo real sin corromper saldos ni rankings.
- Queda fuera de los rankings globales (ricos y endeudados) sin afectar posiciones ni paginación.
- Con ∞ solo visual, el dueño sigue necesitando Cash real para gastar. Si quieres otro comportamiento (por ejemplo gasto sin límite), eso altera la
  economía real y requiere tu decisión explícita.

## Tienda e ingresos del evento

`xn shop` y `xn eventshop` publican un botón de acceso; el catálogo se abre en un mensaje privado (Ephemeral). Los recibos de compras con
botones también son privados. El evento está activo desde <t:1791081000:F> (**4 de octubre de 2026, 02:30 UTC**) hasta <t:1794256200:F>
(**9 de noviembre de 2026, 20:30 UTC**); el fin es exclusivo.

Abre `xn eventshop` para ver los nueve roles, sus costos y recetas. Cada rol se compra con Candys y materiales; luego se activa pagando la mitad
adicional de su precio. Si ya tienes ese rol de Discord, el bot no lo vuelve a asignar.

**`xn collect` paga el mejor rol activado** (el de mayor ingreso); los ingresos de varios roles no se suman. En la tienda:

- el mejor rol activado aparece como **Activado**;
- los demás roles activados pasan a **Obtenido** (siguen siendo tuyos y conservan su rol de Discord, pero ya no pagan ingresos);
- un rol comprado que no supera al mejor te lo avisa antes de activarlo.

Cada rol tiene su **propio cooldown** (`collect:<rol>`): al activar un rol mejor puedes cobrar su primer ingreso sin esperar el cooldown
del anterior. Los cooldowns de los roles que menos pagan bajaron un poco —ningún rol rinde más por hora que Spooky Season (≈5,125/h)—:

| Rol | Ingreso | Cooldown antes → ahora | Ingreso por hora |
|---|---:|---|---:|
| STAR X | 12,000 | 4 h → **3 h** | 4,000 |
| AURA INFINITE | 30,000 | 8 h → **6 h** | 5,000 |
| GOAT | 55,000 | 12 h → **11 h** | 5,000 |
| KING | 85,000 | 18 h → **17 h** | 5,000 |
| ARISE · 9K · 3K · OG · SPOOKY SEASON | 120,000 – 369,000 | sin cambios (24 h – 72 h) | 4,375 – 5,125 |

Los artículos de la tienda **comprados pero sin activar** aparecen en `xn inventory` junto a las pociones, marcados como
*pendiente de activar*; nunca se muestra como poseído algo que no compraste.

`xn top` muestra el top global paginado de ricos o endeudados, con nombres como texto literal `@nombre` (sin menciones ni notificaciones) y
`Jugador sin nombre` si no hay uno disponible. El dueño no aparece.

## Render y costos

`render.yaml` configura un servicio web **Starter** (≈ US$7/mes, precio fijo) y comprueba `/health`. v1.1.0 **no cambia el plan, los
recursos ni las variables de producción**. Detalle de qué entra en la factura, qué puedes bajar y a qué costo en
[`docs/COSTOS.md`](docs/COSTOS.md); incluye el perfil opcional [`render.free.yaml`](render.free.yaml) (plan Free + keep-alive) para quien
quiera bajar el costo aceptando sus contrapartidas.

Para crear el servicio desde el panel: **New → Blueprint** → conecta `ultra3-dev/Xerion` (rama `main`) → completa `BOT_TOKEN`,
`DATABASE_URL` y `DASHBOARD_SECRET` directamente en Render (nunca en GitHub ni en el chat) → espera **Live**.

## Verificación

```sh
npm test            # 196 pruebas (11 archivos)
npm run load-test   # simulación sintética de 10.000 perfiles (no mide producción)
npm run bench:canvas # peso y tiempo del canvas en TU máquina
```

Las pruebas no tocan Discord, Neon ni la red: usan una base local temporal y un `Client` falso. Cubren economía, comercio (transiciones,
conservación y fuzz), XP, owner/rankings, inventario, blackjack, casino, eventshop, el motor gráfico y los flujos de `index.js`.

## Archivos principales

| Archivo | Función |
|---|---|
| `config.js` | Recompensas, probabilidades, cooldowns, evento, tiendas, XP, comercio y valores base |
| `database.js` | Neon/PostgreSQL en producción; JSON local en desarrollo |
| `economy.js` | Lógica de economía, RPG, casino y tienda |
| `trade.js` | Ofertas de `xn give`: catálogo, validaciones y máquina de estados atómica |
| `casino-view.js` | Planes de animación de casino que terminan en el resultado pagado |
| `render/` | Motor gráfico propio (sin dependencias): PNG, rasterizador, texto, cartas, emojis y mesa de blackjack |
| `assets/fonts/` | Contornos de Erica One y Big Shoulders (SIL OFL 1.1, licencias incluidas) |
| `keepalive.js` | Opción de ahorro (apagada por defecto) para el plan Free |
| `ui.js` | Mensajes Components V2, menús y botones |
| `index.js` | Cliente Discord, listeners y comandos |
| `dashboard.js` | Dashboard privado, gestión de códigos y confirmación de reinicio |
| `docs/` | Comercio (`TRADING.md`), canvas (`CANVAS.md`), costos (`COSTOS.md`) y auditorías (`AUDITORIA-1.1.0.md`–`AUDITORIA-1.1.3.md`) |
