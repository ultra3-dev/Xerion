/**
 * ============================================================================
 *  XERION v2.0.2 ULTRA — database.js
 * ----------------------------------------------------------------------------
 *  Todo lo persistente vive aquí (PostgreSQL / Neon): usuarios, contador de
 *  mensajes, probabilidad dinámica, notificaciones de cofre y tienda.
 *
 *  Regla de oro de este archivo: NUNCA se hace DROP ni se borra nada al
 *  arrancar. El esquema solo crece — CREATE TABLE IF NOT EXISTS y ADD COLUMN
 *  IF NOT EXISTS — así que si la tabla ya existía de una versión anterior del
 *  bot (con menos columnas), el arranque se autorepara en vez de romper cada
 *  query que toque una columna nueva. La base de datos no se reinicia jamás.
 * ============================================================================
 */

'use strict';

const { Pool } = require('pg');
const { CONFIG, SHOP_ITEMS, totalFeatherMultiplier, ROLE_PASSIVE_INCOME } = require('./config.js');

const pool = new Pool({
  connectionString: CONFIG.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // requerido por Neon
  max: 5,
});

pool.on('error', (err) => {
  // Un error en una conexión inactiva del pool no debe tumbar el proceso.
  console.error('[Xerion][DB] Error inesperado en el pool de Postgres:', err.message);
});

// Columnas de xerion_users fuera de la definición de la tabla, para poder
// añadirlas con ALTER TABLE ... ADD COLUMN IF NOT EXISTS en initDatabase().
const XERION_USERS_COLUMNS = [
  ['username', 'TEXT'],
  ['display_name', 'TEXT'],
  ['feathers', 'INTEGER NOT NULL DEFAULT 0'],
  ['total_feathers_earned', 'INTEGER NOT NULL DEFAULT 0'],
  ['total_feathers_spent', 'INTEGER NOT NULL DEFAULT 0'],
  ['chests_participated', 'INTEGER NOT NULL DEFAULT 0'],
  ['chests_won', 'INTEGER NOT NULL DEFAULT 0'],
  ['aura_infinite_count', 'INTEGER NOT NULL DEFAULT 0'],
  ['king_count', 'INTEGER NOT NULL DEFAULT 0'],
  ['goat_count', 'INTEGER NOT NULL DEFAULT 0'],
  ['star_x_count', 'INTEGER NOT NULL DEFAULT 0'],
  ['arise_count', 'INTEGER NOT NULL DEFAULT 0'],
  ['shields', 'INTEGER NOT NULL DEFAULT 0'],
  ['luck_charms', 'INTEGER NOT NULL DEFAULT 0'],
  ['revives', 'INTEGER NOT NULL DEFAULT 0'],
  ['void_wards', 'INTEGER NOT NULL DEFAULT 0'],
  ['time_skips', 'INTEGER NOT NULL DEFAULT 0'],
  ['last_daily_claim_at', 'TIMESTAMPTZ'],
  ['daily_claims', 'INTEGER NOT NULL DEFAULT 0'],
  ['current_streak', 'INTEGER NOT NULL DEFAULT 0'],
  ['best_streak', 'INTEGER NOT NULL DEFAULT 0'],
  ['streak_visible', 'BOOLEAN NOT NULL DEFAULT TRUE'],
  ['star_x_income_at', 'TIMESTAMPTZ'],
  ['aura_infinite_income_at', 'TIMESTAMPTZ'],
  ['goat_income_at', 'TIMESTAMPTZ'],
  ['king_income_at', 'TIMESTAMPTZ'],
  ['arise_income_at', 'TIMESTAMPTZ'],
  ['created_at', 'TIMESTAMPTZ NOT NULL DEFAULT NOW()'],
];

// Mapeo rol -> { columna de conteo, columna del reloj de ingreso pasivo }.
const ROLE_INCOME_COLUMNS = {
  STAR_X: { count: 'star_x_count', at: 'star_x_income_at' },
  AURA_INFINITE: { count: 'aura_infinite_count', at: 'aura_infinite_income_at' },
  GOAT: { count: 'goat_count', at: 'goat_income_at' },
  KING: { count: 'king_count', at: 'king_income_at' },
  ARISE: { count: 'arise_count', at: 'arise_income_at' },
};

const XERION_STATE_COLUMNS = [
  ['message_counter', 'INTEGER NOT NULL DEFAULT 0'],
  ['messages_since_chest', 'INTEGER NOT NULL DEFAULT 0'],
  ['chests_spawned_total', 'INTEGER NOT NULL DEFAULT 0'],
  ['chests_opened_total', 'INTEGER NOT NULL DEFAULT 0'],
  ['last_chest_at', 'TIMESTAMPTZ'],
  // Snapshot aditivo del cofre actual. Nunca se usa para reiniciar la base:
  // solo permite reconstruir una partida si el proceso pierde la conexión.
  ['active_chest', 'JSONB'],
  ['active_chest_updated_at', 'TIMESTAMPTZ'],
  ['last_portal_check_at', 'TIMESTAMPTZ'],
  // Evento global activo (ver EVENT_TYPES en config.js) — igual que
  // last_portal_check_at, vive en la fila única de xerion_state para que un
  // reinicio del bot nunca lo pierda ni lo reinicie a mitad de camino.
  ['active_event_key', 'TEXT'],
  ['active_event_ends_at', 'TIMESTAMPTZ'],
];

/**
 * La tabla de usuarios de versiones muy antiguas tenía `guild_id NOT NULL`,
 * aunque el modelo actual es global por usuario. PostgreSQL exige rellenar
 * esa columna incluso cuando el INSERT solo usa `user_id`, que es el
 * ReportNotNullViolationError de las capturas.
 *
 * Esta migración es deliberadamente aditiva: no borra filas, no cambia
 * identificadores existentes y solo añade un valor por defecto para los
 * usuarios nuevos. Se usa GUILD_ID cuando existe; si no, el canal principal
 * del juego funciona como un identificador estable de instalación.
 */
function sqlStringLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

async function ensureLegacyUsersCompatibility() {
  const { rows } = await pool.query(`
    SELECT is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'xerion_users'
      AND column_name = 'guild_id'
    LIMIT 1;
  `);
  const legacyGuildColumn = rows[0];
  if (!legacyGuildColumn || legacyGuildColumn.is_nullable !== 'NO' || legacyGuildColumn.column_default) {
    return;
  }

  const fallbackGuildId = CONFIG.GUILD_ID || CONFIG.CHEST_CHANNEL_ID;
  await pool.query(
    `ALTER TABLE xerion_users ALTER COLUMN guild_id SET DEFAULT ${sqlStringLiteral(fallbackGuildId)};`,
  );
  console.log('[Xerion][DB] Compatibilidad legacy aplicada: guild_id conserva su obligación con un valor por defecto.');
}

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS xerion_users (
      user_id TEXT PRIMARY KEY
    );
  `);
  for (const [name, definition] of XERION_USERS_COLUMNS) {
    await pool.query(`ALTER TABLE xerion_users ADD COLUMN IF NOT EXISTS ${name} ${definition};`);
  }
  await ensureLegacyUsersCompatibility();

  await pool.query(`
    CREATE TABLE IF NOT EXISTS xerion_state (
      id SMALLINT PRIMARY KEY DEFAULT 1
    );
  `);
  for (const [name, definition] of XERION_STATE_COLUMNS) {
    await pool.query(`ALTER TABLE xerion_state ADD COLUMN IF NOT EXISTS ${name} ${definition};`);
  }
  await pool.query(`
    INSERT INTO xerion_state (id)
    SELECT 1
    WHERE NOT EXISTS (SELECT 1 FROM xerion_state WHERE id = 1);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS xerion_channel_state (
      channel_id TEXT PRIMARY KEY,
      message_counter INTEGER NOT NULL DEFAULT 0,
      messages_since_chest INTEGER NOT NULL DEFAULT 0,
      chests_spawned_total INTEGER NOT NULL DEFAULT 0,
      chests_opened_total INTEGER NOT NULL DEFAULT 0,
      last_chest_at TIMESTAMPTZ
    );
  `);
  await pool.query(
    `INSERT INTO xerion_channel_state
       (channel_id, message_counter, messages_since_chest, chests_spawned_total, chests_opened_total, last_chest_at)
     SELECT $1, message_counter, messages_since_chest, chests_spawned_total, chests_opened_total, last_chest_at
     FROM xerion_state
     WHERE id = 1
     ON CONFLICT (channel_id) DO NOTHING;`,
    [CONFIG.CHEST_CHANNEL_ID],
  );

  await pool.query(`
    CREATE TABLE IF NOT EXISTS xerion_active_chests (
      channel_id TEXT PRIMARY KEY,
      snapshot JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(
    `INSERT INTO xerion_active_chests (channel_id, snapshot, updated_at)
     SELECT COALESCE(active_chest->>'channelId', $1), active_chest, COALESCE(active_chest_updated_at, NOW())
     FROM xerion_state
     WHERE id = 1 AND active_chest IS NOT NULL
     ON CONFLICT (channel_id) DO NOTHING;`,
    [CONFIG.CHEST_CHANNEL_ID],
  );

  // Mismo patrón que xerion_active_chests, pero para portales — un snapshot
  // JSONB genérico es suficiente para reconstruir todo tras un reinicio.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS xerion_active_portals (
      channel_id TEXT PRIMARY KEY,
      snapshot JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS xerion_notifications (
      user_id TEXT PRIMARY KEY,
      enabled BOOLEAN NOT NULL DEFAULT FALSE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS xerion_chest_awards (
      chest_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      reward_key TEXT NOT NULL,
      reward_amount INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Versiones antiguas podían tener las columnas correctas sin una
  // restricción UNIQUE. La migración nunca borra datos; si hay duplicados,
  // se deja constancia y el código usa la ruta compatible de abajo.
  for (const [indexName, tableName, columnName] of [
    ['xerion_users_user_id_unique', 'xerion_users', 'user_id'],
    ['xerion_state_id_unique', 'xerion_state', 'id'],
    ['xerion_notifications_user_id_unique', 'xerion_notifications', 'user_id'],
    ['xerion_chest_awards_chest_id_unique', 'xerion_chest_awards', 'chest_id'],
  ]) {
    try {
      await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS ${indexName} ON ${tableName} (${columnName});`);
    } catch (err) {
      console.error(`[Xerion][DB] No se pudo verificar el índice ${indexName}; se conserva la información existente:`, err.message);
    }
  }

  console.log('[Xerion][DB] Esquema listo (columnas verificadas/creadas si faltaban).');
}

// ============================================================================
// USUARIOS
// ============================================================================

async function ensureUser(userId, identity = {}) {
  await pool.query(
    `INSERT INTO xerion_users (user_id, username, display_name)
     VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING;`,
    [userId, identity.username || null, identity.displayName || null],
  );
  await pool.query(
    `UPDATE xerion_users
     SET username = COALESCE(NULLIF($2, ''), username),
         display_name = COALESCE(NULLIF($3, ''), display_name)
     WHERE user_id = $1;`,
    [userId, identity.username || null, identity.displayName || null],
  );
}

async function incrementChestsParticipated(userId) {
  await ensureUser(userId);
  await pool.query(
    `UPDATE xerion_users SET chests_participated = chests_participated + 1 WHERE user_id = $1;`,
    [userId],
  );
}

async function incrementChestsWon(userId) {
  await ensureUser(userId);
  await pool.query(
    `UPDATE xerion_users SET chests_won = chests_won + 1 WHERE user_id = $1;`,
    [userId],
  );
}

/** Aplica el resultado (ya resuelto) de abrir un cofre a las stats del usuario. */
async function applyRewardToUser(userId, reward) {
  await ensureUser(userId);
  if (reward.kind === 'currency') {
    await pool.query(
      `UPDATE xerion_users
       SET feathers = feathers + $2, total_feathers_earned = total_feathers_earned + $2
       WHERE user_id = $1;`,
      [userId, reward.amount],
    );
  } else if (reward.kind === 'role') {
    const column = {
      AURA_INFINITE: 'aura_infinite_count',
      KING: 'king_count',
      GOAT: 'goat_count',
      ARISE: 'arise_count',
      STAR_X: 'star_x_count',
    }[reward.key];
    if (column) await pool.query(`UPDATE xerion_users SET ${column} = ${column} + 1 WHERE user_id = $1;`, [userId]);
  }
  // 'none' no toca la fila — no le tocó nada, literalmente.
}

/**
 * Liquida una recompensa exactamente una vez por cofre. La clave primaria
 * evita duplicados si el proceso cae entre el premio y el mensaje final.
 * La tabla es nueva y aditiva: nunca se borra ni se reinicia.
 */
async function settleChestReward(chestId, userId, reward, channelId = null, heldRoleKeys = []) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Bloqueo transaccional por cofre: conserva la idempotencia aunque una
    // base antigua aún no tenga el índice UNIQUE.
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1));`, [String(chestId)]);
    const { rows: existingAwards } = await client.query(
      `SELECT chest_id FROM xerion_chest_awards WHERE chest_id = $1 LIMIT 1;`,
      [chestId],
    );

    if (existingAwards.length > 0) {
      await client.query('COMMIT');
      return false;
    }

    // Beneficios de rol (según lo que el usuario tenga AHORA en Discord, no
    // historial) + logros: suben tus Feathers ganados. Se calcula antes de
    // guardar el historial para que quede el monto real acreditado.
    if (reward.kind === 'currency') {
      const { rows: bonusRows } = await client.query(`SELECT * FROM xerion_users WHERE user_id = $1;`, [userId]);
      const multiplier = totalFeatherMultiplier(heldRoleKeys, bonusRows[0] || {});
      reward.amount = Math.round((reward.amount || 0) * multiplier); // el llamador reutiliza este objeto para el embed de resultado
    }

    await client.query(
      `INSERT INTO xerion_chest_awards (chest_id, user_id, reward_key, reward_amount)
       VALUES ($1, $2, $3, $4);`,
      [chestId, userId, reward.key, reward.amount || 0],
    );
    await client.query(
      `INSERT INTO xerion_users (user_id)
       SELECT $1
       WHERE NOT EXISTS (SELECT 1 FROM xerion_users WHERE user_id = $1);`,
      [userId],
    );

    if (reward.kind === 'currency') {
      await client.query(
        `UPDATE xerion_users
         SET feathers = feathers + $2, total_feathers_earned = total_feathers_earned + $2
         WHERE user_id = $1;`,
        [userId, reward.amount],
      );
    } else if (reward.kind === 'role') {
      const roleColumn = {
        AURA_INFINITE: 'aura_infinite_count',
        KING: 'king_count',
        GOAT: 'goat_count',
        ARISE: 'arise_count',
        STAR_X: 'star_x_count',
      }[reward.key];
      if (roleColumn) {
        // El reloj de ingreso pasivo arranca la primera vez que se gana el rol
        // (COALESCE no lo toca en victorias siguientes del mismo rol).
        const incomeColumn = ROLE_INCOME_COLUMNS[reward.key]?.at;
        const incomeSet = incomeColumn ? `, ${incomeColumn} = COALESCE(${incomeColumn}, NOW())` : '';
        await client.query(`UPDATE xerion_users SET ${roleColumn} = ${roleColumn} + 1${incomeSet} WHERE user_id = $1;`, [userId]);
      }
    }

    await client.query(`UPDATE xerion_state SET chests_opened_total = chests_opened_total + 1 WHERE id = 1;`);
    if (channelId) {
      await client.query(
        `UPDATE xerion_channel_state
         SET chests_opened_total = chests_opened_total + 1
         WHERE channel_id = $1;`,
        [channelId],
      );
    }
    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function getUserStats(userId, identity = {}) {
  await ensureUser(userId, identity);
  const { rows } = await pool.query(`SELECT * FROM xerion_users WHERE user_id = $1;`, [userId]);
  const user = rows[0];

  const { rows: rankRows } = await pool.query(
    `SELECT COUNT(*) + 1 AS rank FROM xerion_users WHERE feathers > $1;`,
    [user.feathers],
  );
  const { rows: nextRows } = await pool.query(
    `SELECT MIN(feathers) AS next_feathers FROM xerion_users WHERE feathers > $1;`,
    [user.feathers],
  );
  const { rows: totalRows } = await pool.query(`SELECT COUNT(*) AS total FROM xerion_users;`);

  return {
    ...user,
    rank: Number(rankRows[0].rank),
    totalPlayers: Number(totalRows[0].total),
    nextRankFeathers: nextRows[0].next_feathers ? Number(nextRows[0].next_feathers) - Number(user.feathers) : 0,
  };
}

async function getLeaderboard(limit = 10) {
  const { rows } = await pool.query(
    `SELECT user_id, username, display_name, feathers
     FROM xerion_users
     ORDER BY feathers DESC, user_id ASC
     LIMIT $1;`,
    [limit],
  );
  return rows;
}

// ============================================================================
// ESTADO GLOBAL / PROBABILIDAD DINÁMICA
// ============================================================================

/** Incrementa el contador histórico total de mensajes (solo estadística). */
async function ensureChannel(channelId) {
  await pool.query(
    `INSERT INTO xerion_channel_state (channel_id)
     VALUES ($1)
     ON CONFLICT (channel_id) DO NOTHING;`,
    [channelId],
  );
}

async function incrementMessageCounter(channelId = CONFIG.CHEST_CHANNEL_ID) {
  await ensureChannel(channelId);
  const { rows } = await pool.query(
    `UPDATE xerion_channel_state
     SET message_counter = message_counter + 1
     WHERE channel_id = $1
     RETURNING message_counter;`,
    [channelId],
  );
  return rows[0].message_counter;
}

/** Incrementa el contador de mensajes desde el último cofre — esto es lo que alimenta la probabilidad dinámica. */
async function incrementMessagesSinceChest(channelId = CONFIG.CHEST_CHANNEL_ID) {
  await ensureChannel(channelId);
  const { rows } = await pool.query(
    `UPDATE xerion_channel_state
     SET messages_since_chest = messages_since_chest + 1
     WHERE channel_id = $1
     RETURNING messages_since_chest;`,
    [channelId],
  );
  return rows[0].messages_since_chest;
}

/**
 * Registra que un cofre acaba de aparecer: guarda cuántos mensajes llevaba
 * el canal en silencio (para mostrarlo como estadística), resetea ese
 * contador a 0, suma al total de cofres aparecidos y actualiza la fecha del
 * último cofre. Devuelve el estado ANTERIOR (antes de resetear) para poder
 * mostrar "última aparición" en el embed del cofre nuevo.
 */
async function recordChestSpawn(channelId = CONFIG.CHEST_CHANNEL_ID) {
  await ensureChannel(channelId);
  const { rows: beforeRows } = await pool.query(`SELECT * FROM xerion_channel_state WHERE channel_id = $1;`, [channelId]);
  const before = beforeRows[0];

  await pool.query(
    `UPDATE xerion_channel_state
     SET messages_since_chest = 0, chests_spawned_total = chests_spawned_total + 1, last_chest_at = NOW()
     WHERE channel_id = $1;`,
    [channelId],
  );

  return before;
}

async function recordChestOpened(channelId = CONFIG.CHEST_CHANNEL_ID) {
  await ensureChannel(channelId);
  await pool.query(`UPDATE xerion_channel_state SET chests_opened_total = chests_opened_total + 1 WHERE channel_id = $1;`, [channelId]);
}

async function getState(channelId = CONFIG.CHEST_CHANNEL_ID) {
  await ensureChannel(channelId);
  const { rows } = await pool.query(`SELECT * FROM xerion_channel_state WHERE channel_id = $1;`, [channelId]);
  return rows[0];
}

async function getActiveChest() {
  const { rows } = await pool.query(`SELECT active_chest FROM xerion_state WHERE id = 1;`);
  return rows[0]?.active_chest || null;
}

async function saveActiveChest(channelId, snapshot) {
  await pool.query(
    `INSERT INTO xerion_active_chests (channel_id, snapshot, updated_at)
     VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (channel_id) DO UPDATE SET snapshot = EXCLUDED.snapshot, updated_at = NOW();`,
    [channelId, JSON.stringify(snapshot)],
  );
}

async function clearActiveChest(channelId) {
  if (channelId) {
    await pool.query(`DELETE FROM xerion_active_chests WHERE channel_id = $1;`, [channelId]);
    return;
  }
  await pool.query(`DELETE FROM xerion_active_chests;`);
}

async function getActiveChests() {
  const { rows } = await pool.query(`SELECT channel_id, snapshot FROM xerion_active_chests;`);
  return rows;
}

// ============================================================================
// PORTALES — persistencia (mismo patrón que los cofres) + apuestas y pagos.
// ============================================================================

async function savePortal(channelId, snapshot) {
  await pool.query(
    `INSERT INTO xerion_active_portals (channel_id, snapshot, updated_at)
     VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (channel_id) DO UPDATE SET snapshot = EXCLUDED.snapshot, updated_at = NOW();`,
    [channelId, JSON.stringify(snapshot)],
  );
}

async function clearPortal(channelId) {
  await pool.query(`DELETE FROM xerion_active_portals WHERE channel_id = $1;`, [channelId]);
}

async function getActivePortals() {
  const { rows } = await pool.query(`SELECT channel_id, snapshot FROM xerion_active_portals;`);
  return rows;
}

/** Hora del último chequeo de spawn de portal (para no perder el reloj de 1h si el bot se reinicia). */
async function getLastPortalCheckAt() {
  const { rows } = await pool.query(`SELECT last_portal_check_at FROM xerion_state WHERE id = 1;`);
  return rows[0]?.last_portal_check_at || null;
}

async function setLastPortalCheckAt(date = new Date()) {
  await pool.query(`UPDATE xerion_state SET last_portal_check_at = $1 WHERE id = 1;`, [date]);
}

/** Descuenta la apuesta si tiene suficientes Feathers. Devuelve el saldo resultante, o null si no le alcanzaba. */
async function stakePortalEntry(userId, amount) {
  await ensureUser(userId);
  const { rows } = await pool.query(
    `UPDATE xerion_users SET feathers = feathers - $2 WHERE user_id = $1 AND feathers >= $2 RETURNING feathers;`,
    [userId, amount],
  );
  return rows[0]?.feathers ?? null;
}

/** Devuelve una apuesta si el portal se cancela (nadie más entró, etc.) — no cuenta como ganancia. */
async function refundPortalEntry(userId, amount) {
  await pool.query(`UPDATE xerion_users SET feathers = feathers + $2 WHERE user_id = $1;`, [userId, amount]);
}

/** Aplica el reparto final de un portal. `payouts` es [{ userId, amount }] (ganador + demás, ya calculado). */
async function payoutPortalResults(payouts) {
  for (const p of payouts) {
    if (p.amount <= 0) continue;
    await pool.query(
      `UPDATE xerion_users SET feathers = feathers + $2, total_feathers_earned = total_feathers_earned + $2 WHERE user_id = $1;`,
      [p.userId, p.amount],
    );
  }
}

// ============================================================================
// EVENTOS GLOBALES — un solo evento activo a la vez, para todo el servidor.
// Mismo patrón que last_portal_check_at: una sola fila en xerion_state.
// ============================================================================

/** Devuelve { key, endsAt } del evento activo, o null si no hay ninguno guardado. */
async function getActiveEvent() {
  const { rows } = await pool.query(`SELECT active_event_key, active_event_ends_at FROM xerion_state WHERE id = 1;`);
  const row = rows[0];
  if (!row?.active_event_key) return null;
  return { key: row.active_event_key, endsAt: row.active_event_ends_at };
}

async function setActiveEvent(key, endsAt) {
  await pool.query(`UPDATE xerion_state SET active_event_key = $1, active_event_ends_at = $2 WHERE id = 1;`, [key, endsAt]);
}

async function clearActiveEvent() {
  await pool.query(`UPDATE xerion_state SET active_event_key = NULL, active_event_ends_at = NULL WHERE id = 1;`);
}

async function getServerStats(channelId = CONFIG.CHEST_CHANNEL_ID) {
  const state = await getState(channelId);
  const { rows } = await pool.query(
    `SELECT COUNT(*) AS players, COALESCE(SUM(feathers), 0) AS total_feathers FROM xerion_users;`,
  );
  return {
    ...state,
    totalPlayers: Number(rows[0].players),
    totalFeathersInCirculation: Number(rows[0].total_feathers),
  };
}

// ============================================================================
// NOTIFICACIONES DE COFRE (DM)
// ============================================================================

async function getNotificationEnabled(userId) {
  const { rows } = await pool.query(`SELECT enabled FROM xerion_notifications WHERE user_id = $1;`, [userId]);
  return rows.length > 0 ? rows[0].enabled : false;
}

async function setNotificationEnabled(userId, enabled) {
  const { rowCount } = await pool.query(
    `UPDATE xerion_notifications
     SET enabled = $2, updated_at = NOW()
     WHERE user_id = $1;`,
    [userId, enabled],
  );
  if (rowCount === 0) {
    await pool.query(
      `INSERT INTO xerion_notifications (user_id, enabled, updated_at)
       SELECT $1, $2, NOW()
       WHERE NOT EXISTS (SELECT 1 FROM xerion_notifications WHERE user_id = $1);`,
      [userId, enabled],
    );
  }
  return enabled;
}

async function getEnabledNotificationUserIds() {
  const { rows } = await pool.query(`SELECT user_id FROM xerion_notifications WHERE enabled = TRUE;`);
  return rows.map((r) => r.user_id);
}

// ============================================================================
// TIENDA / OBJETOS
// ============================================================================

async function getShopCounts(userId) {
  await ensureUser(userId);
  const { rows } = await pool.query(
    `SELECT feathers, shields, luck_charms, revives, void_wards, time_skips FROM xerion_users WHERE user_id = $1;`,
    [userId],
  );
  return rows[0];
}

/** Compra atómica: solo descuenta y entrega si el usuario tiene feathers suficientes. */
async function buyShopItem(userId, column, cost) {
  await ensureUser(userId);
  const { rows } = await pool.query(
    `UPDATE xerion_users
     SET feathers = feathers - $2, total_feathers_spent = total_feathers_spent + $2, ${column} = ${column} + 1
     WHERE user_id = $1 AND feathers >= $2
     RETURNING feathers, shields, luck_charms, revives, void_wards, time_skips;`,
    [userId, cost],
  );
  return rows[0] || null; // null = no tenía suficientes feathers
}

async function buyShield(userId, cost = SHOP_ITEMS.SHIELD.cost) {
  return buyShopItem(userId, 'shields', cost);
}

async function buyCharm(userId, cost = SHOP_ITEMS.CHARM.cost) {
  return buyShopItem(userId, 'luck_charms', cost);
}

async function buyRevive(userId, cost = SHOP_ITEMS.REVIVE.cost) {
  return buyShopItem(userId, 'revives', cost);
}

async function buyVoidWard(userId, cost = SHOP_ITEMS.WARD.cost) {
  return buyShopItem(userId, 'void_wards', cost);
}

async function buyTimeSkip(userId, cost = SHOP_ITEMS.TIME_SKIP.cost) {
  return buyShopItem(userId, 'time_skips', cost);
}

/** Consume un Amuleto contra el Vacío si tiene uno disponible. Devuelve true si se consumió (y por lo tanto aplica). */
async function consumeVoidWardIfAvailable(userId) {
  const { rows } = await pool.query(
    `UPDATE xerion_users SET void_wards = void_wards - 1 WHERE user_id = $1 AND void_wards > 0 RETURNING void_wards;`,
    [userId],
  );
  return rows.length > 0;
}

async function getShieldCounts(userIds) {
  if (userIds.length === 0) return new Map();
  const { rows } = await pool.query(
    `SELECT user_id, shields FROM xerion_users WHERE user_id = ANY($1::text[]);`,
    [userIds],
  );
  return new Map(rows.map((r) => [r.user_id, r.shields]));
}

async function consumeShields(userIds) {
  if (userIds.length === 0) return;
  await pool.query(
    `UPDATE xerion_users SET shields = GREATEST(shields - 1, 0) WHERE user_id = ANY($1::text[]);`,
    [userIds],
  );
}

async function getReviveCounts(userIds) {
  if (userIds.length === 0) return new Map();
  const { rows } = await pool.query(
    `SELECT user_id, revives FROM xerion_users WHERE user_id = ANY($1::text[]);`,
    [userIds],
  );
  return new Map(rows.map((r) => [r.user_id, r.revives]));
}

async function consumeRevives(userIds) {
  if (userIds.length === 0) return;
  await pool.query(
    `UPDATE xerion_users SET revives = GREATEST(revives - 1, 0) WHERE user_id = ANY($1::text[]);`,
    [userIds],
  );
}

/** Consume un amuleto de suerte de forma atómica. Devuelve true si tenía uno disponible. */
async function consumeLuckCharmIfAvailable(userId) {
  await ensureUser(userId);
  const { rowCount } = await pool.query(
    `UPDATE xerion_users SET luck_charms = luck_charms - 1 WHERE user_id = $1 AND luck_charms > 0;`,
    [userId],
  );
  return rowCount > 0;
}

/**
 * Reclama la recompensa diaria y actualiza la racha:
 * - Si el último claim fue hace menos de 48h, la racha continúa (+1).
 * - Si no (o es el primer claim de todos), la racha se reinicia a 1.
 * El cooldown de 24h para poder reclamar de nuevo no cambia.
 */
async function claimDaily(userId, identity = {}, heldRoleKeys = [], eventMultiplier = 1) {
  await ensureUser(userId, identity);
  const { rows: bonusRows } = await pool.query(`SELECT * FROM xerion_users WHERE user_id = $1;`, [userId]);
  const dailyReward = Math.round(25 * totalFeatherMultiplier(heldRoleKeys, bonusRows[0] || {}) * eventMultiplier);
  const { rows } = await pool.query(
    `UPDATE xerion_users
     SET feathers = feathers + $2,
         total_feathers_earned = total_feathers_earned + $2,
         daily_claims = daily_claims + 1,
         current_streak = CASE
           WHEN last_daily_claim_at IS NOT NULL AND last_daily_claim_at >= NOW() - INTERVAL '48 hours'
             THEN current_streak + 1
           ELSE 1
         END,
         best_streak = GREATEST(
           best_streak,
           CASE
             WHEN last_daily_claim_at IS NOT NULL AND last_daily_claim_at >= NOW() - INTERVAL '48 hours'
               THEN current_streak + 1
             ELSE 1
           END
         ),
         last_daily_claim_at = NOW()
     WHERE user_id = $1
       AND (last_daily_claim_at IS NULL OR last_daily_claim_at <= NOW() - INTERVAL '24 hours')
     RETURNING feathers, daily_claims, last_daily_claim_at, current_streak, best_streak, streak_visible;`,
    [userId, dailyReward],
  );
  if (rows[0]) return { claimed: true, reward: dailyReward, ...rows[0] };
  const { rows: current } = await pool.query(
    `SELECT feathers, daily_claims, last_daily_claim_at, current_streak, best_streak, streak_visible FROM xerion_users WHERE user_id = $1;`,
    [userId],
  );
  return { claimed: false, reward: 0, ...current[0] };
}

/** Activa o desactiva que la racha se muestre en el apodo del usuario. */
async function setStreakVisible(userId, visible) {
  await ensureUser(userId);
  await pool.query(`UPDATE xerion_users SET streak_visible = $2 WHERE user_id = $1;`, [userId, visible]);
}

/**
 * Recolecta el ingreso pasivo de todos los roles que el usuario tenga
 * listos para cobrar. Cada rol cobra como máximo una vez por intervalo
 * (no se acumulan periodos atrasados) — así el sistema sigue siendo justo
 * y difícil, sin premiar a quien se desconecta mucho tiempo.
 */
async function collectRoleIncome(userId, heldRoleKeys = [], eventMultiplier = 1) {
  await ensureUser(userId);
  const { rows } = await pool.query(`SELECT * FROM xerion_users WHERE user_id = $1;`, [userId]);
  const row = rows[0];
  const now = Date.now();

  const claimed = [];
  const pending = [];
  const setClauses = [];
  const params = [userId];
  let totalAmount = 0;

  for (const [key, cols] of Object.entries(ROLE_INCOME_COLUMNS)) {
    if (!heldRoleKeys.includes(key)) continue; // ya no tiene el rol AHORA — sin ingreso, tenga o no historial
    const { intervalMs, amount: baseAmount } = ROLE_PASSIVE_INCOME[key];
    const amount = Math.round(baseAmount * eventMultiplier);
    const lastAt = row[cols.at] ? new Date(row[cols.at]).getTime() : null;
    if (lastAt === null || now - lastAt >= intervalMs) {
      claimed.push({ key, amount });
      totalAmount += amount;
      params.push(new Date(now));
      setClauses.push(`${cols.at} = $${params.length}`);
    } else {
      pending.push({ key, amount, cols, readyAt: new Date(lastAt + intervalMs) });
    }
  }

  // Acelerador Temporal: si tiene uno y hay algo pendiente, lo completa todo al instante.
  let usedTimeSkip = false;
  if (pending.length > 0 && (row.time_skips || 0) > 0) {
    usedTimeSkip = true;
    for (const p of pending) {
      claimed.push({ key: p.key, amount: p.amount });
      totalAmount += p.amount;
      params.push(new Date(now));
      setClauses.push(`${p.cols.at} = $${params.length}`);
    }
    pending.length = 0;
  }

  if (claimed.length > 0) {
    params.push(totalAmount);
    const timeSkipSet = usedTimeSkip ? `, time_skips = time_skips - 1` : '';
    await pool.query(
      `UPDATE xerion_users
       SET feathers = feathers + $${params.length},
           total_feathers_earned = total_feathers_earned + $${params.length},
           ${setClauses.join(', ')}${timeSkipSet}
       WHERE user_id = $1;`,
      params,
    );
  }

  return { claimed, pending, totalAmount, hasAnyRole: heldRoleKeys.length > 0, usedTimeSkip };
}

/**
 * Reinicia por completo los datos de alguien que ya no está en el servidor,
 * para que el top nunca lo muestre y no arrastre errores si vuelve a entrar
 * más adelante — arranca desde cero, como un usuario nuevo.
 */
async function resetUserData(userId) {
  await pool.query(`DELETE FROM xerion_chest_awards WHERE user_id = $1;`, [userId]);
  await pool.query(`DELETE FROM xerion_notifications WHERE user_id = $1;`, [userId]);
  await pool.query(`DELETE FROM xerion_users WHERE user_id = $1;`, [userId]);
}

async function getRecentAwards(userId, limit = 10) {
  const { rows } = await pool.query(
    `SELECT reward_key, reward_amount, created_at
     FROM xerion_chest_awards
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT $2;`,
    [userId, limit],
  );
  return rows;
}

module.exports = {
  pool,
  initDatabase,
  ensureUser,
  incrementChestsParticipated,
  incrementChestsWon,
  applyRewardToUser,
  settleChestReward,
  getUserStats,
  getLeaderboard,
  ensureChannel,
  incrementMessageCounter,
  incrementMessagesSinceChest,
  recordChestSpawn,
  recordChestOpened,
  getState,
  getActiveChest,
  getActiveChests,
  saveActiveChest,
  clearActiveChest,
  savePortal,
  clearPortal,
  getActivePortals,
  getLastPortalCheckAt,
  setLastPortalCheckAt,
  getActiveEvent,
  setActiveEvent,
  clearActiveEvent,
  stakePortalEntry,
  refundPortalEntry,
  payoutPortalResults,
  getServerStats,
  getNotificationEnabled,
  setNotificationEnabled,
  getEnabledNotificationUserIds,
  getShopCounts,
  buyShield,
  buyCharm,
  buyRevive,
  buyVoidWard,
  buyTimeSkip,
  consumeVoidWardIfAvailable,
  getShieldCounts,
  consumeShields,
  getReviveCounts,
  consumeRevives,
  consumeLuckCharmIfAvailable,
  claimDaily,
  setStreakVisible,
  collectRoleIncome,
  resetUserData,
  getRecentAwards,
};
