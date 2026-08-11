# Xerion v1.5.0 — Qué cambió

## Estructura (5 archivos, como pediste)

- **config.js** — CONFIG del servidor, los 3 tipos de cofre y sus tablas de recompensa, la tienda, y utilidades puras.
- **database.js** — todo Postgres/Neon. Esquema 100% aditivo (`CREATE TABLE IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS`) — tu base de datos actual se autorepara al arrancar, nunca se borra nada.
- **visuals.js** — el motor de canvas y **todos** los embeds/paneles Components V2.
- **game.js** — spawns, batalla de eliminación, tienda, notificaciones, y los 9 comandos (slash + prefix).
- **index.js** — cliente de Discord, la página web informativa, y el arranque.

Reemplaza tu `index.js` actual por estos 5 archivos (mismo `package.json`, actualicé solo la versión — no necesitas instalar nada nuevo).

## Los 9 comandos (slash + `xn ...`, tú decidiste el número dentro de tu tope de 20)

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

- **Las plumas ahora sirven para algo** → `/shop`: **Escudo de Xerion** (🛡️ 40 plumas, te salva de la ronda 1 de eliminación) y **Amuleto de Suerte** (🍀 60 plumas, +50% probabilidad de rol en tu próxima apertura). Ambos se consumen al usarse.
- **3 tipos de cofre** (inventé los nombres): 🩶 Cofre de Ceniza (común), 🔥 Cofre de Brasa (raro), 🌑 Cofre del Abismo (legendario). Cada uno con su propia tabla de probabilidad — **incluso el Abismo sigue siendo mayormente "Nothing"**, el sistema es difícil a propósito.
- **Probabilidad dinámica**: empieza en 2% y sube +10% cada 20 mensajes sin cofre, hasta 95% tope. Se guarda en Postgres, sobrevive reinicios.
- **Embed del cofre con 10 estadísticas** exactas (tipo, mejor recompensa, rango de plumas, % de nada, cierre, participantes, cofres abiertos del server, última aparición, mensajes procesados, y un tip sobre la tienda).
- **Sin ping al usar comandos**: todo pasa por `allowedMentions` suprimidos por defecto (`parse: []`) + `repliedUser: false` en prefix.
- **Ping real al eliminar y al ganador**: las líneas de eliminación y el anuncio del ganador ahora sí traen la mención en el `content` del mensaje (los mentions dentro de un *embed* nunca pingan en Discord — por eso antes probablemente no pingaban de verdad).
- **`/notification`**: panel con botón activar/desactivar; cuando aparece un cofre (automático o forzado), se manda un DM a todos los que lo activaron.
- **Clear de slash commands**: en cada arranque, el bot borra TODOS los comandos globales y del guild configurado antes de re-registrar solo estos 9 — así no quedan comandos clonados de proyectos anteriores.
- **Nunca resets**: esquema aditivo, y absolutamente todo lo que toca Discord o la base de datos está en `try/catch` — un error nunca tumba el proceso ni pide reiniciar nada.
- **Components V2 + Markdown de Discord** en todos los paneles de información (encabezados, subtexto, blockquotes, código, timestamps). El flujo del cofre usa embeds clásicos a propósito (es lo que Discord permite editar rápido y sin que las menciones pinguen accidentalmente).

## Sobre los "comandos que no funcionaban"

No encontré un bug reproducible en el código del zip para `xn inv` — sintácticamente estaba bien. Reescribí todo el flujo de comandos con manejo de errores defensivo de punta a punta, así que si era un problema de timing/permisos en producción debería estar cubierto ahora. Corrí una prueba end-to-end simulada completa (spawn → participar → batalla con escudo → abrir con amuleto → recompensa de rol → tienda → notificaciones → clear de comandos) sin ninguna excepción — pero no reemplaza probarlo con tu bot y tu Postgres reales.

## Antes de subirlo a producción

1. `npm install` (por si acaso) y `npm start` en un entorno de pruebas primero si puedes.
2. Prueba `/spawn` con cada tipo de cofre.
3. Revisa que el bot tenga el permiso **Manage Roles** y que su rol esté por encima de AURA INFINITE / KING / ARISE en la jerarquía — si no, el bot te avisa en el resultado pero no puede asignar el rol.
4. Si usas `GUILD_ID` en `.env`, los slash commands se actualizan al instante; si no, tardan hasta 1 hora la primera vez.
