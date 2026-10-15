# Registro de cambios

## 1.1.0

Base: `main` @ `8a8d56a` (v1.0.0 «Halloween Release», 50 comandos). **55 comandos reales** (los alias no cuentan).

### Nuevo
- **`xn give`** (`sell`, `trade`): venta/intercambio de pociones, materiales y armas con botones Aceptar / Rechazar / Cancelar, precio
  mínimo del 50% del valor base, expiración a 2 min y máquina de estados atómica. Valores base de materiales documentados
  (`docs/TRADING.md`).
- **`xn interest`**, **`xn train`**, **`xn skills`**, **`xn crash`** (ganancia, 2 RPG, casino).
- **Blackjack con canvas:** mesa dibujada (PNG indexado ≈74 KB) en Components V2, emojis Apple con respaldo vectorial, contador `n/15`,
  banner de resultado, frases del dealer y reparto animado. **Tiempo de mano: 150 s.** Respaldo automático al tablero de texto.
- **Límite estricto de 15 cartas** (jugador + banca): al colocar la 15ª se cierra la mano; si la banca no pudo completar, empate.
- **Eventshop / collect:** `collect` paga el mejor rol activado; el resto pasa de *Activado* a *Obtenido*; cooldown propio por rol; cooldowns
  más cortos en STAR X (3 h), AURA INFINITE (6 h), GOAT (11 h) y KING (17 h).
- **Inventario:** los artículos del eventshop comprados y sin activar aparecen junto a las pociones como *pendiente de activar*.
- **Owner:** ID corregido al configurado para el dueño; ∞ solo visual en Cash/Bank/Total, intocable (rob/bounty), fuera de los rankings.
- Opcional: keep-alive para el plan Free y `render.free.yaml` (apagados por defecto), `npm run bench:canvas`.

### Cambiado
- **XP:** aleatoria dentro de rangos acotados (base ±40%) y ajustada al nivel (`min(4, 1 + 0.06·nivel)`); curva de niveles intacta.
  `boss` sube de 10 a 150 XP por intento (cooldown de 3 h frente a 1 h para `dungeon`); nuevas acciones: `train` (30) e `interest` (6).
- **Casino:** rueda, ruleta, tragamonedas y crash dibujan la animación desde el mismo resultado que se pagó (posición, multiplicador, premio y
  mensaje coinciden); un premio que desbordaría el saldo se rechaza sin gastar cooldown.
- **Rankings:** `getRank` calcula el puesto en O(n) sin ordenar; el dueño queda fuera de las listas y de «usuario más rico».
- **Versión** 1.0.0 → 1.1.0 (`config.js`, `package.json`, `package-lock.json`, README).

### Corregido
- **Duelos:** aceptar dos veces seguidas podía resolver el duelo dos veces (apuesta y XP duplicados); ahora el reto se reclama de forma atómica.
- Un doble clic sobre un reto o una oferta ya resuelta ya no sobrescribe el resultado con un error: responde en privado o redibuja el estado final.
- Botones de blackjack tardíos o repetidos responden «Partida terminada» sin repetir efectos; resolver dos veces una mano nunca paga dos veces.
- Saldos: `addcandy`, `pay` y los pagos del casino respetan el rango de enteros seguros; antes de guardar se reparan valores no finitos o inseguros.
- `scripts/load-test.js` ya fallaba en `main` (esperaba 6 XP y el XP fijo de main era 6 + 6 = 12); ahora valida el rango de XP.
- Las pruebas ya no crean una carpeta `data/` vacía dentro del repositorio (`ECONOMY_DATA_FILE` decide dónde se escribe).

### Seguridad y compatibilidad
- Sin migraciones ni cambios de esquema: los campos nuevos viven dentro del JSON de cada perfil con valores por defecto.
- Sin dependencias nuevas (el motor gráfico es propio); `package-lock.json` solo cambia de versión.
- El cooldown antiguo de `collect` (clave única) se traslada al mejor rol actual: nadie obtiene un cobro extra por actualizar.
