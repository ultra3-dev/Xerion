/**
 * ============================================================================
 *  XERION v1.5.0 — database.js
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
const { CONFIG, SHOP_ITEMS } = require('./config.js');

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
  ['feathers', 'INTEGER NOT NULL DEFAULT 0'],
  ['total_feathers_earned', 'INTEGER NOT NULL DEFAULT 0'],
  ['total_feathers_spent', 'INTEGER NOT NULL DEFAULT 0'],
  ['chests_participated', 'INTEGER NOT NULL DEFAULT 0'],
  ['chests_won', 'INTEGER NOT NULL DEFAULT 0'],
  ['aura_infinite_count', 'INTEGER NOT NULL DEFAULT 0'],
  ['king_count', 'INTEGER NOT NULL DEFAULT 0'],
  ['arise_count', 'INTEGER NOT NULL DEFAULT 0'],
  ['shields', 'INTEGER NOT NULL DEFAULT 0'],
  ['luck_charms', 'INTEGER NOT NULL DEFAULT 0'],
  ['created_at', 'TIMESTAMPTZ NOT NULL DEFAULT NOW()'],
];

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
];

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS xerion_users (
      user_id TEXT PRIMARY KEY
    );
  `);
  for (const [name, definition] of XERION_USERS_COLUMNS) {
    await pool.query(`ALTER TABLE xerion_users ADD COLUMN IF NOT EXISTS ${name} ${definition};`);
  }

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

async function ensureUser(userId) {
  await pool.query(
    `INSERT INTO xerion_users (user_id)
     SELECT $1
     WHERE NOT EXISTS (SELECT 1 FROM xerion_users WHERE user_id = $1);`,
    [userId],
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
    const column =
      reward.key === 'AURA_INFINITE' ? 'aura_infinite_count' : reward.key === 'KING' ? 'king_count' : 'arise_count';
    await pool.query(`UPDATE xerion_users SET ${column} = ${column} + 1 WHERE user_id = $1;`, [userId]);
  }
  // 'none' no toca la fila — no le tocó nada, literalmente.
}

/**
 * Liquida una recompensa exactamente una vez por cofre. La clave primaria
 * evita duplicados si el proceso cae entre el premio y el mensaje final.
 * La tabla es nueva y aditiva: nunca se borra ni se reinicia.
 */
async function settleChestReward(chestId, userId, reward) {
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
        ARISE: 'arise_count',
      }[reward.key];
      if (roleColumn) {
        await client.query(`UPDATE xerion_users SET ${roleColumn} = ${roleColumn} + 1 WHERE user_id = $1;`, [userId]);
      }
    }

    await client.query(`UPDATE xerion_state SET chests_opened_total = chests_opened_total + 1 WHERE id = 1;`);
    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function getUserStats(userId) {
  await ensureUser(userId);
  const { rows } = await pool.query(`SELECT * FROM xerion_users WHERE user_id = $1;`, [userId]);
  const user = rows[0];

  const { rows: rankRows } = await pool.query(
    `SELECT COUNT(*) + 1 AS rank FROM xerion_users WHERE feathers > $1;`,
    [user.feathers],
  );
  const { rows: totalRows } = await pool.query(`SELECT COUNT(*) AS total FROM xerion_users;`);

  return { ...user, rank: Number(rankRows[0].rank), totalPlayers: Number(totalRows[0].total) };
}

async function getLeaderboard(limit = 10) {
  const { rows } = await pool.query(
    `SELECT user_id, feathers FROM xerion_users ORDER BY feathers DESC, user_id ASC LIMIT $1;`,
    [limit],
  );
  return rows;
}

// ============================================================================
// ESTADO GLOBAL / PROBABILIDAD DINÁMICA
// ============================================================================

/** Incrementa el contador histórico total de mensajes (solo estadística). */
async function incrementMessageCounter() {
  const { rows } = await pool.query(
    `UPDATE xerion_state SET message_counter = message_counter + 1 WHERE id = 1 RETURNING message_counter;`,
  );
  return rows[0].message_counter;
}

/** Incrementa el contador de mensajes desde el último cofre — esto es lo que alimenta la probabilidad dinámica. */
async function incrementMessagesSinceChest() {
  const { rows } = await pool.query(
    `UPDATE xerion_state SET messages_since_chest = messages_since_chest + 1 WHERE id = 1 RETURNING messages_since_chest;`,
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
async function recordChestSpawn() {
  const { rows: beforeRows } = await pool.query(`SELECT * FROM xerion_state WHERE id = 1;`);
  const before = beforeRows[0];

  await pool.query(
    `UPDATE xerion_state
     SET messages_since_chest = 0, chests_spawned_total = chests_spawned_total + 1, last_chest_at = NOW()
     WHERE id = 1;`,
  );

  return before;
}

async function recordChestOpened() {
  await pool.query(`UPDATE xerion_state SET chests_opened_total = chests_opened_total + 1 WHERE id = 1;`);
}

async function getState() {
  const { rows } = await pool.query(`SELECT * FROM xerion_state WHERE id = 1;`);
  return rows[0];
}

async function getActiveChest() {
  const { rows } = await pool.query(`SELECT active_chest FROM xerion_state WHERE id = 1;`);
  return rows[0]?.active_chest || null;
}

async function saveActiveChest(snapshot) {
  await pool.query(
    `UPDATE xerion_state
     SET active_chest = $1::jsonb, active_chest_updated_at = NOW()
     WHERE id = 1;`,
    [JSON.stringify(snapshot)],
  );
}

async function clearActiveChest() {
  await pool.query(
    `UPDATE xerion_state
     SET active_chest = NULL, active_chest_updated_at = NOW()
     WHERE id = 1;`,
  );
}

async function getServerStats() {
  const state = await getState();
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
    `SELECT feathers, shields, luck_charms FROM xerion_users WHERE user_id = $1;`,
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
     RETURNING feathers, shields, luck_charms;`,
    [userId, cost],
  );
  return rows[0] || null; // null = no tenía suficientes feathers
}

async function buyShield(userId) {
  return buyShopItem(userId, 'shields', SHOP_ITEMS.SHIELD.cost);
}

async function buyCharm(userId) {
  return buyShopItem(userId, 'luck_charms', SHOP_ITEMS.CHARM.cost);
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

/** Consume un amuleto de suerte de forma atómica. Devuelve true si tenía uno disponible. */
async function consumeLuckCharmIfAvailable(userId) {
  await ensureUser(userId);
  const { rowCount } = await pool.query(
    `UPDATE xerion_users SET luck_charms = luck_charms - 1 WHERE user_id = $1 AND luck_charms > 0;`,
    [userId],
  );
  return rowCount > 0;
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
  incrementMessageCounter,
  incrementMessagesSinceChest,
  recordChestSpawn,
  recordChestOpened,
  getState,
  getActiveChest,
  saveActiveChest,
  clearActiveChest,
  getServerStats,
  getNotificationEnabled,
  setNotificationEnabled,
  getEnabledNotificationUserIds,
  getShopCounts,
  buyShield,
  buyCharm,
  getShieldCounts,
  consumeShields,
  consumeLuckCharmIfAvailable,
};
