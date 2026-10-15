# Auditoría y entrega — Xerion 1.1.0

**Base auditada:** `main` @ `8a8d56a62271a7b80cac15c4187c5fbd30589646` (v1.0.0, 50 comandos); coincide con el commit que indicaste como desplegado.
No comprobé el estado en Render, así que no afirmo que ese siga siendo el commit ejecutándose en producción.
**Probado:** la candidata del ZIP, extraída en una copia de trabajo local y comparada con `main`. Corregí el ID del owner y el XP de `boss`.
No cambié datos, esquema de base de datos ni infraestructura. Las ramas `agent/xerion-dashboard-improvements` y
`agent/xerion-gameplay-dashboard` y el PR #1 siguen intactos.

## Límites de esta auditoría (léelos)

- Revisé GitHub y confirmé que PR #2–#5 están fusionados; PR #1 permanece abierto y en borrador, sin revisión de código.
  Las dos ramas de respaldo conservan cada una un commit exclusivo. No las fusioné ni las modifiqué. El ZIP tiene un dashboard HTML generado
  dentro de `dashboard.js`; no incluye `public/dashboard.html` ni `scripts/dashboard.test.js` de la rama de dashboard, que permaneció intacta.
- `npm ci` terminó con el lockfile incluido y se probaron los builders reales de `discord.js`; no se usó un stub. Esto no comprueba llamadas
  contra Discord, Neon ni Render.
- Nada de lo dicho sobre rendimiento o costos son mediciones de producción.

## Estado por requisito (en `main` 8a8d56a → en 1.1.0)

| Req. | En main | Evidencia en main | En 1.1.0 |
|---|---|---|---|
| **A** 5 comandos (55) | **Pendiente**: 50 comandos | `index.js`: 50 `commands.* =` | `give` + `interest`, `train`, `skills`, `crash` = **55** (alias aparte); sintaxis y valores base en `docs/TRADING.md` |
| **B** Seguridad de ofertas | **Pendiente** (y un fallo en duelos) | `index.js:1059-1061`: `await` entre `getDuelChallenge` y resolver → doble clic duplicaba apuesta y XP | `trade.js`: sin escrow, revalidación atómica, estados finales inmutables; duelo con `claimDuelChallenge`; 25 pruebas de comercio (+ fuzz 4,000 pasos) |
| **C** XP | **Parcial**: curva y valores ya ajustados en main | `config.js` XP base; curva existente en `database.js` | Curva intacta; rangos aleatorios ±40% con factor `min(4, 1+0.06·nivel)`; `boss` sube de 10 a 150 para corregir la diferencia 10 XP/3 h frente a 160 XP/1 h de `dungeon`; sin XP por errores/duplicados |
| **D** Components V2 | **Completo** (patrones y leaderboard sin pings ya estaban) | `ui.js` `container/payload/lockedButton`; `leaderboard-names.js` | Todo lo nuevo sigue el patrón; botones por persona, `deferUpdate` primero, doble clic/expiración sin duplicar |
| **E** Pendientes del eventshop | **Pendiente** | `ui.js:438` `inventoryContainer` solo pociones/materiales/efectos/armas | Bloque «Pendientes de activar» junto a las pociones; solo lo comprado (9 pruebas) |
| **F** Versión | **Pendiente** | `config.js:35`, `package.json:3`, lockfile, README = 1.0.0 | 1.1.0 coherente (prueba de coherencia); lockfile solo cambia de versión |
| **G** Blackjack | **Pendiente** (sin tope) | `economy.js:848-878` | Tope estricto de 15 cartas, cierre seguro, empate si la banca no pudo completar; idempotente; 18 pruebas |
| **H** Animaciones | **Pendiente** | `ui.js:757-786` puntero `frame % largo`: el último fotograma no coincidía con el resultado | `casino-view.js` + resultados completos: el último fotograma **es** el sorteado y pagado (todas las combinaciones probadas) |
| **I** Owner | **Pendiente** | `config.js`; rankings incluían a todos; `rob`/`bounty` sin protección | ID corregido al valor explícito `106467807401005875`; ∞ solo visual, intocable, fuera de rankings, saldos finitos y seguros |
| **J** Rendimiento/costos | **Completo** (mejoras de latencia ya en main: `deferUpdate` antes de la base de datos) | `index.js:906` | Se conservan; `getRank` O(n) (local: 21.3→16.3 ms con 10 mil perfiles); canvas ≈74 KB/imagen; `docs/COSTOS.md` |

## Pedidos adicionales de esta ronda

| Pedido | Resultado |
|---|---|
| Blackjack con canvas, diseño llamativo, Components V2, emojis Apple sin bugs | `render/` (motor propio, **sin dependencias nuevas**): mesa de fieltro, cartas dibujadas, insignias, fichas, banner de resultado; PNG indexado ≈74 KB; **emojis Apple reales** descargados al arrancar con **respaldo vectorial estilo iOS** (nunca cuadros vacíos); respaldo al tablero de texto. Los PNG de Apple **no se incluyen** (derechos y no pude descargarlos): `docs/CANVAS.md` |
| Tiempo de mano 150 s | `BLACKJACK_TIMEOUT_MS = 150000`; prueba del cierre exacto (1 ms antes abierta, a los 150 s se planta y paga por las reglas) |
| `collect`: solo el mejor rol; Activado/Obtenido; menos cooldown a los bajos | Mejor rol paga; tienda muestra **Activado** (mejor) y **Obtenido** (resto); cooldown **por rol**; STAR X 4→3 h, AURA 8→6 h, GOAT 12→11 h, KING 18→17 h (nadie rinde más/hora que SPOOKY SEASON) (8 pruebas) |
| Costo ≤ US$7 y que baje | No cambié plan ni infraestructura. `render.yaml` sigue en Starter (≈US$7 según la documentación aportada); no comprobé la factura actual ni puedo garantizar un tope o ahorro. Free es una opción separada con posibles pausas y más latencia: requiere decisión explícita. |

## Otros hallazgos corregidos (no pedidos)

- `scripts/load-test.js` **ya fallaba en `main`** (esperaba 6 XP; el XP fijo era 12): corregido.
- Un doble clic sobre un duelo/oferta ya resuelto **sobrescribía el resultado con un error**: ahora responde en privado o redibuja el estado final.
- `pay` y `addcandy` podían superar el entero seguro; ruleta/rueda gastaban un uso de cooldown al rechazar por límite numérico.
- `database.js` creaba un `data/` vacío en el repo aun con `ECONOMY_DATA_FILE`.

## Verificación

| Comprobación | Resultado |
|---|---|
| `node --check` en todos los `.js` | OK (0 fallos) |
| `npm test` (11 archivos) | **196 / 196** con `discord.js` instalado desde el lockfile |
| Por archivo | logic 27 · trade 25 · xp 12 · owner 14 · blackjack 18 · casino 15 · inventory 9 · eventshop 8 · render 22 · handlers 35 · release 11 |
| `npm run load-test` (sintético) | passed: 10,000 perfiles, 20,000 acciones, 207.9 ms (no es capacidad de producción) |
| `npm run bench:canvas` | 74.4 KB; 103 ms de media por imagen con caché caliente; calentamiento 1,549 ms (local) |
| Conteo de comandos | **55** reales (sin alias) — comprobado por prueba |
| Límites de Discord | ≤ 40 componentes y ≤ 4000 caracteres en ayuda, eventshop, inventario y skills |
| Paquete | ZIP íntegro; `.env`, base privada, `node_modules`, `.git` y cachés excluidos; revisión automatizada en extracción limpia |
| Base de datos | Sin cambios de esquema respecto a `main`; campos nuevos usan valores por defecto en JSON. No se ejecutaron DDL ni borrados en producción |

## Preguntas / decisiones que necesito de ti

1. **∞ visual vs. gasto.** Con «∞ solo visual» el owner sigue necesitando Cash real para comprar/apostar (los datos guardados son finitos). Si quieres «gasto sin límite» o que pueda dar Candys a otros sin descontarse,
   eso **crea saldo** y altera la economía real: no lo hice; dime si lo quieres y bajo qué límites.
2. **Costo:** `render.yaml` conserva Starter y no se cambió la infraestructura. Para reducir el costo habría que decidir entre revisar/eliminar un cron no identificado o cambiar a Free, que puede dormir y responder más lento; no tuve acceso a Render para comprobar la factura ni el cron.
3. **Emojis Apple:** revisa la licencia de ese conjunto de imágenes antes de usarlo en un servicio público (`docs/CANVAS.md`).

## Publicación y estado de producción

- **Base de `main` antes de esta versión:** `8a8d56a`; se confirmó que el SHA remoto completo coincide con el snapshot revisado.
- **Ramas de respaldo y PR #1:** no se modificaron ni se fusionaron.
- **Producción:** no se consultó Render; no puedo confirmar qué commit está ejecutándose ni si el push activa un deploy automático.
- **Costos:** `render.yaml` conserva Starter; no se consultó la factura y esta versión no cambia el plan ni demuestra un ahorro.
