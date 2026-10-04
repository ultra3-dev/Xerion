'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = process.env.ECONOMY_DATA_FILE || path.join(DATA_DIR, 'economy.json');
const PG_TABLE = 'public.xerion_economy_users';
const PG_CODE_TABLE = 'public.xerion_redeem_codes';
const PG_REDEMPTION_TABLE = 'public.xerion_redeem_redemptions';
const PG_RESET_TOKEN_TABLE = 'public.xerion_dashboard_reset_tokens';
const PG_DISCORD_EVENT_TABLE = 'public.xerion_processed_discord_events';

let db = { users: {}, redeemCodes: {}, redeemRedemptions: {}, resetTokens: {} };
let dirty = false;
let dirtyAll = false;
let postgresPool = null;
let postgresEnabled = false;
let saveInProgress = null;
let exclusiveReset = false;
let activeCriticalOperations = 0;
const resetWaiters = [];
const operationWaiters = [];
const dirtyUserIds = new Set();
const persistedSnapshots = new Map();
const userIds = new WeakMap();
const claimedDiscordEventIds = new Set();

// ---------- Persistencia ----------

function attachUserId(id, user) {
  userIds.set(user, String(id));
  return user;
}

function markDirty(...users) {
  dirty = true;
  if (!users.length) {
    dirtyAll = true;
    return;
  }
  for (const user of users) {
    const id = user && userIds.get(user);
    if (id) dirtyUserIds.add(id);
    else dirtyAll = true;
  }
}

function ensureDataFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ users: {} }, null, 2));
  }
}

function readLocalDB() {
  ensureDataFile();
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    db = JSON.parse(raw);
    if (!db || typeof db !== 'object' || Array.isArray(db)) db = { users: {} };
    if (!db.users || typeof db.users !== 'object' || Array.isArray(db.users)) db.users = {};
    if (!db.redeemCodes || typeof db.redeemCodes !== 'object' || Array.isArray(db.redeemCodes)) db.redeemCodes = {};
    if (!db.redeemRedemptions || typeof db.redeemRedemptions !== 'object' || Array.isArray(db.redeemRedemptions)) db.redeemRedemptions = {};
    if (!db.resetTokens || typeof db.resetTokens !== 'object' || Array.isArray(db.resetTokens)) db.resetTokens = {};
  } catch (err) {
    console.error('[DB] No se pudo leer economy.json, se inicia una base vacía:', err);
    db = { users: {}, redeemCodes: {}, redeemRedemptions: {}, resetTokens: {} };
  }
  dirty = false;
  for (const [id, user] of Object.entries(db.users)) {
    if (!user || typeof user !== 'object' || Array.isArray(user)) {
      db.users[id] = attachUserId(id, defaultUser());
      markDirty(db.users[id]);
      continue;
    }
    const before = JSON.stringify(user);
    attachUserId(id, user);
    ensureShape(user);
    if (JSON.stringify(user) !== before) markDirty(user);
  }
}

async function saveLocalDB() {
  try {
    if (!dirty) return true;
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const tempFile = `${DATA_FILE}.tmp`;
    fs.writeFileSync(tempFile, JSON.stringify(db, null, 2));
    fs.renameSync(tempFile, DATA_FILE);
    dirty = false;
    dirtyAll = false;
    dirtyUserIds.clear();
    return true;
  } catch (err) {
    console.error('[DB] Error al guardar economy.json:', err);
    try { fs.unlinkSync(`${DATA_FILE}.tmp`); } catch (_) { /* noop */ }
    return false;
  }
}

async function savePostgresDB() {
  if (!postgresPool || saveInProgress) return saveInProgress || true;
  const ids = dirtyAll ? Object.keys(db.users) : [...dirtyUserIds];
  dirtyAll = false;
  dirtyUserIds.clear();

  const changed = [];
  for (const id of ids) {
    const user = db.users[id];
    if (!user) continue;
    const snapshot = JSON.stringify(user);
    if (persistedSnapshots.get(id) !== snapshot) changed.push({ id, snapshot });
  }
  if (!changed.length) {
    dirty = dirtyAll || dirtyUserIds.size > 0;
    return true;
  }

  saveInProgress = (async () => {
    try {
      const batchSize = 100;
      for (let offset = 0; offset < changed.length; offset += batchSize) {
        const batch = changed.slice(offset, offset + batchSize);
        const values = [];
        const placeholders = batch.map((row, index) => {
          const base = index * 2;
          values.push(row.id, row.snapshot);
          return `($${base + 1}, $${base + 2}::jsonb, NOW())`;
        });
        await postgresPool.query(
          `INSERT INTO ${PG_TABLE} (user_id, user_data, updated_at)
           VALUES ${placeholders.join(', ')}
           ON CONFLICT (user_id) DO UPDATE
           SET user_data = EXCLUDED.user_data, updated_at = NOW()`,
          values,
        );
        for (const row of batch) {
          persistedSnapshots.set(row.id, row.snapshot);
          if (db.users[row.id] && JSON.stringify(db.users[row.id]) !== row.snapshot) {
            dirtyUserIds.add(row.id);
          }
        }
      }
      dirty = dirtyAll || dirtyUserIds.size > 0;
      return true;
    } catch (err) {
      for (const row of changed) dirtyUserIds.add(row.id);
      dirty = true;
      console.error('[DB] Error al guardar usuarios en Neon; se reintentará:', err.message);
      return false;
    } finally {
      saveInProgress = null;
    }
  })();
  return saveInProgress;
}

async function saveDB() {
  return withCriticalOperation(async () => {
    if (postgresEnabled) return savePostgresDB();
    return saveLocalDB();
  });
}

async function withCriticalOperation(operation) {
  while (exclusiveReset) await new Promise((resolve) => operationWaiters.push(resolve));
  activeCriticalOperations += 1;
  try {
    return await operation();
  } finally {
    activeCriticalOperations -= 1;
    if (activeCriticalOperations === 0) {
      while (resetWaiters.length) resetWaiters.shift()();
    }
  }
}

async function withExclusiveReset(operation) {
  while (exclusiveReset) await new Promise((resolve) => operationWaiters.push(resolve));
  exclusiveReset = true;
  while (activeCriticalOperations > 0) {
    await new Promise((resolve) => resetWaiters.push(resolve));
  }
  try {
    return await operation();
  } finally {
    exclusiveReset = false;
    while (operationWaiters.length) operationWaiters.shift()();
  }
}

async function loadDB() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString && process.env.NODE_ENV === 'production') {
    throw new Error('DATABASE_URL es obligatorio en producción; no se iniciará usando almacenamiento efímero.');
  }

  if (connectionString) {
    const { Pool } = require('pg');
    postgresPool = new Pool({
      connectionString,
      ssl: { rejectUnauthorized: false },
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
      allowExitOnIdle: false,
    });
    postgresPool.on('error', (err) => console.error('[DB] Error inesperado del pool Neon:', err.message));
    await postgresPool.query(
      `CREATE TABLE IF NOT EXISTS ${PG_TABLE} (
        user_id TEXT PRIMARY KEY,
        user_data JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
    );
    await postgresPool.query(
      `CREATE TABLE IF NOT EXISTS ${PG_CODE_TABLE} (
        normalized_code TEXT PRIMARY KEY,
        display_code TEXT NOT NULL,
        reward BIGINT NOT NULL CHECK (reward > 0),
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
    );
    await postgresPool.query(
      `CREATE TABLE IF NOT EXISTS ${PG_REDEMPTION_TABLE} (
        normalized_code TEXT NOT NULL REFERENCES ${PG_CODE_TABLE}(normalized_code) ON DELETE CASCADE,
        user_id TEXT NOT NULL,
        redeemed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (normalized_code, user_id)
      )`,
    );
    await postgresPool.query(
      `CREATE TABLE IF NOT EXISTS ${PG_RESET_TOKEN_TABLE} (
        token_hash TEXT PRIMARY KEY,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
    );
    await postgresPool.query(
      `CREATE TABLE IF NOT EXISTS ${PG_DISCORD_EVENT_TABLE} (
        event_id TEXT PRIMARY KEY,
        processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
    );
    await postgresPool.query(
      `CREATE INDEX IF NOT EXISTS xerion_processed_discord_events_processed_at_idx
       ON ${PG_DISCORD_EVENT_TABLE} (processed_at)`,
    );
    await postgresPool.query(
      `DELETE FROM ${PG_DISCORD_EVENT_TABLE}
       WHERE processed_at < NOW() - INTERVAL '7 days'`,
    );
    const result = await postgresPool.query(`SELECT user_id, user_data FROM ${PG_TABLE}`);
    db = { users: {} };
    dirty = false;
    dirtyAll = false;
    dirtyUserIds.clear();
    persistedSnapshots.clear();
    for (const row of result.rows) {
      const user = typeof row.user_data === 'string' ? JSON.parse(row.user_data) : row.user_data;
      const before = JSON.stringify(user);
      attachUserId(row.user_id, user);
      ensureShape(user);
      db.users[row.user_id] = user;
      persistedSnapshots.set(row.user_id, before);
      if (JSON.stringify(user) !== before) markDirty(user);
    }
    postgresEnabled = true;
    console.log(`[DB] Neon listo: ${result.rowCount} perfiles cargados.`);

    // Importa una copia local antigua solo si la tabla remota está vacía.
    if (result.rowCount === 0 && fs.existsSync(DATA_FILE)) {
      let localUsers = {};
      try {
        const local = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        if (local && local.users && typeof local.users === 'object' && !Array.isArray(local.users)) {
          localUsers = local.users;
        }
      } catch (err) {
        console.error('[DB] No se pudo importar el JSON local:', err.message);
      }
      for (const [id, rawUser] of Object.entries(localUsers)) {
        if (!rawUser || typeof rawUser !== 'object' || Array.isArray(rawUser)) continue;
        const user = attachUserId(id, rawUser);
        ensureShape(user);
        db.users[id] = user;
        markDirty(user);
      }
      if (dirtyUserIds.size) await saveDB();
    }
    return db;
  }

  postgresEnabled = false;
  readLocalDB();
  return db;
}

function startAutoSave() {
  const interval = setInterval(() => {
    if (dirty) void saveDB();
  }, 3000);
  if (typeof interval.unref === 'function') interval.unref();
  return interval;
}

async function closeDB() {
  await saveDB();
  if (postgresPool) {
    const pool = postgresPool;
    postgresPool = null;
    await pool.end();
  }
}

async function claimDiscordEvent(eventType, eventId) {
  const id = `${eventType}:${String(eventId || '')}`;
  if (!/^(message|interaction):\d{1,32}$/.test(id)) return false;
  return withCriticalOperation(async () => {
    if (postgresEnabled && postgresPool) {
      const result = await postgresPool.query(
        `INSERT INTO ${PG_DISCORD_EVENT_TABLE} (event_id)
         VALUES ($1)
         ON CONFLICT (event_id) DO NOTHING
         RETURNING event_id`,
        [id],
      );
      return result.rowCount === 1;
    }

    if (claimedDiscordEventIds.has(id)) return false;
    claimedDiscordEventIds.add(id);
    while (claimedDiscordEventIds.size > 5000) {
      claimedDiscordEventIds.delete(claimedDiscordEventIds.values().next().value);
    }
    return true;
  });
}

// ---------- Usuarios ----------

function defaultStats() {
  return {
    totalWorked: 0,
    totalScavenged: 0,
    totalHarvested: 0,
    eventCollects: 0,
    candyRaids: 0,
    robWins: 0,
    huntWins: 0,
    dungeonClears: 0,
    bossWins: 0,
    duelWins: 0,
    casinoWins: 0,
  };
}

function defaultUser() {
  return {
    cash: 0,
    bank: 0,
    debt: 0,
    displayName: '',
    cooldowns: {},
    cooldownCycles: {},
    inventory: {},
    materials: {},
    effects: {},
    class: null,
    classChangedAt: 0,
    eventRolesPurchased: [],
    eventRolesActivated: [],
    activeQuest: null,
    completedQuestIds: [],
    completedQuestActions: [],
    xp: 0,
    weapons: [],
    equippedWeapon: null,
    bountyOn: 0,
    stats: defaultStats(),
    createdAt: Date.now(),
  };
}

// Rellena campos nuevos en usuarios creados por versiones anteriores del bot,
// para que nunca truene por un campo que no existía todavía (sin errores).
function ensureShape(user) {
  for (const key of ['cash', 'bank', 'debt', 'xp', 'classChangedAt', 'bountyOn', 'createdAt']) {
    if (!Number.isFinite(user[key])) user[key] = key === 'createdAt' ? Date.now() : 0;
  }
  user.cash = Math.max(0, user.cash);
  user.bank = Math.max(0, user.bank);
  user.debt = Math.max(0, user.debt);
  if (typeof user.displayName !== 'string') user.displayName = '';
  user.xp = Math.max(0, user.xp);
  if (!user.cooldowns || typeof user.cooldowns !== 'object' || Array.isArray(user.cooldowns)) user.cooldowns = {};
  if (!user.cooldownCycles || typeof user.cooldownCycles !== 'object' || Array.isArray(user.cooldownCycles)) user.cooldownCycles = {};
  if (!user.inventory || typeof user.inventory !== 'object' || Array.isArray(user.inventory)) user.inventory = {};
  if (!user.materials || typeof user.materials !== 'object' || Array.isArray(user.materials)) user.materials = {};
  if (!user.effects || typeof user.effects !== 'object' || Array.isArray(user.effects)) user.effects = {};
  if (user.class === undefined) user.class = null;
  if (typeof user.classChangedAt !== 'number') user.classChangedAt = 0;
  if (typeof user.xp !== 'number') user.xp = 0;
  if (!Array.isArray(user.eventRolesPurchased)) user.eventRolesPurchased = [];
  if (!Array.isArray(user.eventRolesActivated)) user.eventRolesActivated = [...user.eventRolesPurchased];
  if (!user.activeQuest || typeof user.activeQuest !== 'object' || Array.isArray(user.activeQuest)) user.activeQuest = null;
  if (!Array.isArray(user.completedQuestIds)) user.completedQuestIds = [];
  if (!Array.isArray(user.completedQuestActions)) user.completedQuestActions = [];
  if (!Array.isArray(user.weapons)) user.weapons = [];
  if (user.equippedWeapon === undefined) user.equippedWeapon = null;
  if (typeof user.bountyOn !== 'number') user.bountyOn = 0;
  if (!user.stats || typeof user.stats !== 'object' || Array.isArray(user.stats)) user.stats = defaultStats();
  else {
    const defaults = defaultStats();
    for (const key of Object.keys(defaults)) {
      if (typeof user.stats[key] !== 'number') user.stats[key] = defaults[key];
    }
  }
  return user;
}

function getUser(id) {
  if (!db.users[id] || typeof db.users[id] !== 'object' || Array.isArray(db.users[id])) {
    db.users[id] = attachUserId(id, defaultUser());
    markDirty(db.users[id]);
  } else if (!userIds.has(db.users[id])) {
    attachUserId(id, db.users[id]);
  }
  return ensureShape(db.users[id]);
}

function getAllUsers() {
  for (const [id, user] of Object.entries(db.users)) {
    if (!user || typeof user !== 'object' || Array.isArray(user)) {
      db.users[id] = attachUserId(id, defaultUser());
      markDirty(db.users[id]);
    } else {
      if (!userIds.has(user)) attachUserId(id, user);
      ensureShape(user);
    }
  }
  return db.users;
}

function resetUser(id) {
  db.users[id] = attachUserId(id, defaultUser());
  markDirty(db.users[id]);
  return db.users[id];
}

function normalizeCode(code) {
  return String(code || '').trim().toUpperCase();
}

async function createRedeemCodeUnsafe(code, reward, expiresAt) {
  const normalizedCode = normalizeCode(code);
  if (!/^[A-Z0-9_-]{3,32}$/.test(normalizedCode)) return { error: 'invalid_code' };
  if (!Number.isSafeInteger(reward) || reward < 1) return { error: 'invalid_reward' };
  const expiry = new Date(expiresAt);
  if (!Number.isFinite(expiry.getTime()) || expiry.getTime() <= Date.now()) return { error: 'invalid_expiry' };

  if (postgresPool) {
    const result = await postgresPool.query(
      `INSERT INTO ${PG_CODE_TABLE} (normalized_code, display_code, reward, expires_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (normalized_code) DO NOTHING
       RETURNING normalized_code`,
      [normalizedCode, String(code).trim(), reward, expiry.toISOString()],
    );
    return result.rowCount ? { ok: true } : { error: 'already_exists' };
  }

  if (db.redeemCodes[normalizedCode]) return { error: 'already_exists' };
  db.redeemCodes[normalizedCode] = {
    normalizedCode,
    displayCode: String(code).trim(),
    reward,
    expiresAt: expiry.toISOString(),
    createdAt: new Date().toISOString(),
  };
  dirty = true;
  if (!await saveLocalDB()) {
    delete db.redeemCodes[normalizedCode];
    return { error: 'storage' };
  }
  return { ok: true };
}

async function createRedeemCode(code, reward, expiresAt) {
  return withCriticalOperation(() => createRedeemCodeUnsafe(code, reward, expiresAt));
}

async function listRedeemCodes() {
  if (postgresPool) {
    const result = await postgresPool.query(
      `SELECT normalized_code, display_code, reward, expires_at, created_at
       FROM ${PG_CODE_TABLE}
       ORDER BY created_at DESC`,
    );
    return result.rows.map((row) => ({
      normalizedCode: row.normalized_code,
      displayCode: row.display_code,
      reward: Number(row.reward),
      expiresAt: new Date(row.expires_at).toISOString(),
      createdAt: new Date(row.created_at).toISOString(),
    }));
  }
  return Object.values(db.redeemCodes).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

async function deleteRedeemCodeUnsafe(code) {
  const normalizedCode = normalizeCode(code);
  if (postgresPool) {
    const result = await postgresPool.query(
      `DELETE FROM ${PG_CODE_TABLE} WHERE normalized_code = $1`,
      [normalizedCode],
    );
    return { deleted: result.rowCount > 0 };
  }
  if (!db.redeemCodes[normalizedCode]) return { deleted: false };
  const existing = db.redeemCodes[normalizedCode];
  delete db.redeemCodes[normalizedCode];
  const removedRedemptions = {};
  for (const key of Object.keys(db.redeemRedemptions)) {
    if (key.startsWith(`${normalizedCode}:`)) {
      removedRedemptions[key] = db.redeemRedemptions[key];
      delete db.redeemRedemptions[key];
    }
  }
  dirty = true;
  if (!await saveLocalDB()) {
    db.redeemCodes[normalizedCode] = existing;
    Object.assign(db.redeemRedemptions, removedRedemptions);
    return { error: 'storage' };
  }
  return { deleted: true };
}

async function deleteRedeemCode(code) {
  return withCriticalOperation(() => deleteRedeemCodeUnsafe(code));
}

async function redeemCodeUnsafe(userId, user, code, now = new Date()) {
  const normalizedCode = normalizeCode(code);
  if (!/^[A-Z0-9_-]{3,32}$/.test(normalizedCode)) return { error: 'notfound' };
  if (getLevel(user.xp) < 10) return { error: 'level_required', level: 10 };

  if (postgresPool && !await savePostgresDB()) return { error: 'storage' };

  if (!postgresPool) {
    const record = db.redeemCodes[normalizedCode];
    if (!record) return { error: 'notfound' };
    if (new Date(record.expiresAt).getTime() <= now.getTime()) return { error: 'expired' };
    const redemptionKey = `${normalizedCode}:${userId}`;
    if (db.redeemRedemptions[redemptionKey]) return { error: 'already_redeemed' };
    const newCash = user.cash + Number(record.reward);
    if (!Number.isSafeInteger(newCash)) return { error: 'balance_limit' };
    const previousCash = user.cash;
    user.cash = newCash;
    db.redeemRedemptions[redemptionKey] = { code: normalizedCode, userId: String(userId), redeemedAt: now.toISOString() };
    markDirty(user);
    if (!await saveLocalDB()) {
      user.cash = previousCash;
      delete db.redeemRedemptions[redemptionKey];
      return { error: 'storage' };
    }
    return { reward: Number(record.reward), code: record.displayCode };
  }

  const client = await postgresPool.connect();
  try {
    await client.query('BEGIN');
    const codeResult = await client.query(
      `SELECT display_code, reward, expires_at FROM ${PG_CODE_TABLE}
       WHERE normalized_code = $1 FOR UPDATE`,
      [normalizedCode],
    );
    if (!codeResult.rowCount) {
      await client.query('ROLLBACK');
      return { error: 'notfound' };
    }
    const record = codeResult.rows[0];
    if (new Date(record.expires_at).getTime() <= now.getTime()) {
      await client.query('ROLLBACK');
      return { error: 'expired' };
    }
    const existing = await client.query(
      `SELECT 1 FROM ${PG_REDEMPTION_TABLE} WHERE normalized_code = $1 AND user_id = $2`,
      [normalizedCode, String(userId)],
    );
    if (existing.rowCount) {
      await client.query('ROLLBACK');
      return { error: 'already_redeemed' };
    }

    const currentSnapshot = JSON.stringify(user);
    await client.query(
      `INSERT INTO ${PG_TABLE} (user_id, user_data, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (user_id) DO NOTHING`,
      [String(userId), currentSnapshot],
    );
    const profileResult = await client.query(
      `SELECT user_data FROM ${PG_TABLE} WHERE user_id = $1 FOR UPDATE`,
      [String(userId)],
    );
    const storedUser = typeof profileResult.rows[0].user_data === 'string'
      ? JSON.parse(profileResult.rows[0].user_data)
      : profileResult.rows[0].user_data;

    const reward = Number(record.reward);
    const newCash = Number(storedUser.cash) + reward;
    if (!Number.isSafeInteger(newCash)) {
      await client.query('ROLLBACK');
      return { error: 'balance_limit' };
    }
    const updatedUser = { ...storedUser, cash: newCash };
    const snapshot = JSON.stringify(updatedUser);
    await client.query(
      `UPDATE ${PG_TABLE} SET user_data = $2::jsonb, updated_at = NOW() WHERE user_id = $1`,
      [String(userId), snapshot],
    );
    await client.query(
      `INSERT INTO ${PG_REDEMPTION_TABLE} (normalized_code, user_id, redeemed_at)
       VALUES ($1, $2, $3)`,
      [normalizedCode, String(userId), now.toISOString()],
    );
    await client.query('COMMIT');

    for (const key of Object.keys(user)) {
      if (!Object.prototype.hasOwnProperty.call(updatedUser, key)) delete user[key];
    }
    Object.assign(user, updatedUser);
    attachUserId(String(userId), user);
    persistedSnapshots.set(String(userId), JSON.stringify(user));
    dirtyUserIds.delete(String(userId));
    dirty = dirtyAll || dirtyUserIds.size > 0;
    return { reward, code: record.display_code };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function redeemCode(userId, user, code, now = new Date()) {
  return withCriticalOperation(() => redeemCodeUnsafe(userId, user, code, now));
}

async function createResetTokenUnsafe(tokenHash, expiresAt) {
  const expiry = new Date(expiresAt);
  if (!Number.isFinite(expiry.getTime()) || expiry.getTime() <= Date.now()) return false;
  if (postgresPool) {
    await postgresPool.query(
      `DELETE FROM ${PG_RESET_TOKEN_TABLE} WHERE expires_at <= NOW()`,
    );
    await postgresPool.query(
      `INSERT INTO ${PG_RESET_TOKEN_TABLE} (token_hash, expires_at) VALUES ($1, $2)`,
      [tokenHash, expiry.toISOString()],
    );
    return true;
  }
  db.resetTokens[tokenHash] = expiry.toISOString();
  dirty = true;
  if (!await saveLocalDB()) {
    delete db.resetTokens[tokenHash];
    return false;
  }
  return true;
}

async function createResetToken(tokenHash, expiresAt) {
  return withCriticalOperation(() => createResetTokenUnsafe(tokenHash, expiresAt));
}

async function deleteResetTokenUnsafe(tokenHash) {
  if (postgresPool) {
    await postgresPool.query(`DELETE FROM ${PG_RESET_TOKEN_TABLE} WHERE token_hash = $1`, [tokenHash]);
    return;
  }
  const existing = db.resetTokens[tokenHash];
  delete db.resetTokens[tokenHash];
  dirty = true;
  if (!await saveLocalDB()) {
    if (existing) db.resetTokens[tokenHash] = existing;
    return false;
  }
  return true;
}

async function deleteResetToken(tokenHash) {
  return withCriticalOperation(() => deleteResetTokenUnsafe(tokenHash));
}

async function consumeResetTokenAndResetAllUnsafe(tokenHash, now = new Date()) {
  if (!postgresPool) {
    const expiresAt = db.resetTokens[tokenHash];
    if (!expiresAt || new Date(expiresAt).getTime() <= now.getTime()) {
      delete db.resetTokens[tokenHash];
      dirty = true;
      await saveLocalDB();
      return { error: 'invalid_token' };
    }
    const previous = JSON.stringify(db.users);
    const tokenExpiresAt = expiresAt;
    delete db.resetTokens[tokenHash];
    for (const id of Object.keys(db.users)) {
      db.users[id] = attachUserId(id, defaultUser());
    }
    dirty = true;
    dirtyAll = true;
    if (!await saveLocalDB()) {
      db.users = JSON.parse(previous);
      for (const [id, user] of Object.entries(db.users)) attachUserId(id, user);
      db.resetTokens[tokenHash] = tokenExpiresAt;
      return { error: 'storage' };
    }
    return { ok: true, count: Object.keys(db.users).length };
  }

  const client = await postgresPool.connect();
  try {
    await client.query('BEGIN');
    const token = await client.query(
      `SELECT token_hash FROM ${PG_RESET_TOKEN_TABLE}
       WHERE token_hash = $1 AND expires_at > $2 FOR UPDATE`,
      [tokenHash, now.toISOString()],
    );
    if (!token.rowCount) {
      await client.query('ROLLBACK');
      await postgresPool.query(`DELETE FROM ${PG_RESET_TOKEN_TABLE} WHERE token_hash = $1`, [tokenHash]);
      return { error: 'invalid_token' };
    }

    await client.query(`LOCK TABLE ${PG_TABLE} IN SHARE ROW EXCLUSIVE MODE`);
    const persisted = await client.query(`SELECT user_id FROM ${PG_TABLE}`);
    const ids = new Set([...persisted.rows.map((row) => String(row.user_id)), ...Object.keys(db.users)]);
    const resetUsers = [...ids].map((id) => ({ id, user: attachUserId(id, defaultUser()) }));
    const batchSize = 500;
    for (let offset = 0; offset < resetUsers.length; offset += batchSize) {
      const batch = resetUsers.slice(offset, offset + batchSize);
      const values = [];
      const placeholders = batch.map((entry, index) => {
        const base = index * 2;
        const snapshot = JSON.stringify(entry.user);
        values.push(entry.id, snapshot);
        return `($${base + 1}, $${base + 2}::jsonb, NOW())`;
      });
      await client.query(
        `INSERT INTO ${PG_TABLE} (user_id, user_data, updated_at)
         VALUES ${placeholders.join(', ')}
         ON CONFLICT (user_id) DO UPDATE
         SET user_data = EXCLUDED.user_data, updated_at = NOW()`,
        values,
      );
    }
    await client.query(`DELETE FROM ${PG_RESET_TOKEN_TABLE} WHERE token_hash = $1`, [tokenHash]);
    await client.query('COMMIT');

    db.users = {};
    persistedSnapshots.clear();
    for (const { id, user } of resetUsers) {
      db.users[id] = user;
      persistedSnapshots.set(id, JSON.stringify(user));
    }
    dirtyUserIds.clear();
    dirtyAll = false;
    dirty = false;
    return { ok: true, count: resetUsers.length };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function consumeResetTokenAndResetAll(tokenHash, now = new Date()) {
  return withExclusiveReset(() => consumeResetTokenAndResetAllUnsafe(tokenHash, now));
}

function getTotal(user) {
  return user.cash + user.bank - user.debt;
}

// ---------- Utilidades numéricas ----------

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function fmt(n) {
  const rounded = Math.round(n);
  return rounded.toLocaleString('en-US');
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomFloat(min, max) {
  return Math.random() * (max - min) + min;
}

function formatDuration(ms) {
  if (ms <= 0) return '0s';
  const totalSeconds = Math.ceil(ms / 1000);
  const d = Math.floor(totalSeconds / 86400);
  const h = Math.floor((totalSeconds % 86400) / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const parts = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (d === 0 && m > 0) parts.push(`${m}m`);
  if (d === 0 && h === 0 && (s > 0 || parts.length === 0)) parts.push(`${s}s`);
  return parts.join(' ');
}

// ---------- Nivel / experiencia ----------
// Curva: nivel = floor(sqrt(xp / 50)) → nivel 1 a los 50xp, nivel 10 a los 5,000xp.

function getLevel(xp) {
  return Math.floor(Math.sqrt(Math.max(0, xp || 0) / 50));
}

function xpForLevel(level) {
  return level * level * 50;
}

function addXp(user, amount) {
  user.xp = Math.max(0, (user.xp || 0) + amount);
  markDirty(user);
}

function incrementStat(user, key, amount = 1) {
  if (!user.stats) user.stats = defaultStats();
  user.stats[key] = (user.stats[key] || 0) + amount;
  markDirty(user);
}

// ---------- Efectos de pociones ----------

function cleanEffects(user) {
  const now = Date.now();
  let changed = false;
  for (const key of Object.keys(user.effects)) {
    const e = user.effects[key];
    if (!e || e.expiresAt <= now) {
      delete user.effects[key];
      changed = true;
    }
  }
  if (changed) markDirty(user);
}

function getStacks(user, effectId) {
  cleanEffects(user);
  const e = user.effects[effectId];
  return e ? e.stacks : 0;
}

function getEffectRemaining(user, effectId) {
  cleanEffects(user);
  const e = user.effects[effectId];
  if (!e) return 0;
  return Math.max(0, e.expiresAt - Date.now());
}

function applyPotionEffect(user, potionDef) {
  cleanEffects(user);
  const cur = user.effects[potionDef.id];
  const newStacks = Math.min((cur ? cur.stacks : 0) + 1, potionDef.maxStacks);
  user.effects[potionDef.id] = {
    stacks: newStacks,
    expiresAt: Date.now() + potionDef.durationMs * newStacks,
  };
  markDirty(user);
  return newStacks;
}

function consumeRevive(user) {
  cleanEffects(user);
  const e = user.effects.revive;
  if (!e || e.stacks <= 0) return false;
  e.stacks -= 1;
  if (e.stacks <= 0) delete user.effects.revive;
  markDirty(user);
  return true;
}

// ---------- Cooldowns ----------

function isOnCooldown(user, key) {
  return Date.now() < (user.cooldowns[key] || 0);
}

function getCooldownRemaining(user, key) {
  return Math.max(0, (user.cooldowns[key] || 0) - Date.now());
}

function setCooldown(user, key, durationMs) {
  user.cooldowns[key] = Date.now() + durationMs;
  markDirty(user);
}

function consumeCooldownUse(user, key, policy, now = Date.now()) {
  const remaining = Math.max(0, (user.cooldowns[key] || 0) - now);
  if (remaining > 0) return { error: 'cooldown', remaining };

  const uses = Math.max(1, Math.floor(policy.uses || 1));
  const cycle = user.cooldownCycles[key] || { uses: 0 };
  if (!Number.isInteger(cycle.uses) || cycle.uses < 0 || cycle.uses >= uses) cycle.uses = 0;
  cycle.uses += 1;
  const isRest = cycle.uses >= uses;
  const durationMs = Math.max(0, isRest ? policy.restMs : policy.intervalMs);
  if (isRest) cycle.uses = 0;
  user.cooldownCycles[key] = cycle;
  user.cooldowns[key] = now + durationMs;
  markDirty(user);
  return { durationMs, isRest };
}

// ---------- Inventario ----------

function addInventory(user, potionId, qty = 1) {
  user.inventory[potionId] = (user.inventory[potionId] || 0) + qty;
  markDirty(user);
}

function removeInventory(user, potionId, qty = 1) {
  if (!user.inventory[potionId] || user.inventory[potionId] < qty) return false;
  user.inventory[potionId] -= qty;
  if (user.inventory[potionId] <= 0) delete user.inventory[potionId];
  markDirty(user);
  return true;
}

function addMaterial(user, materialId, qty = 1) {
  if (!user.materials || typeof user.materials !== 'object' || Array.isArray(user.materials)) user.materials = {};
  user.materials[materialId] = (user.materials[materialId] || 0) + qty;
  markDirty(user);
}

// ---------- Armas (permanentes, no se consumen) ----------

function hasWeapon(user, weaponId) {
  return Array.isArray(user.weapons) && user.weapons.includes(weaponId);
}

function addWeapon(user, weaponId) {
  if (!Array.isArray(user.weapons)) user.weapons = [];
  if (!user.weapons.includes(weaponId)) user.weapons.push(weaponId);
  markDirty(user);
}

module.exports = {
  loadDB, saveDB, closeDB, markDirty, startAutoSave,
  claimDiscordEvent,
  getUser, getAllUsers, getTotal, resetUser,
  createRedeemCode, listRedeemCodes, deleteRedeemCode, redeemCode,
  createResetToken, deleteResetToken, consumeResetTokenAndResetAll,
  clamp, fmt, randomInt, randomFloat, formatDuration,
  getLevel, xpForLevel, addXp, incrementStat,
  cleanEffects, getStacks, getEffectRemaining, applyPotionEffect, consumeRevive,
  isOnCooldown, getCooldownRemaining, setCooldown,
  consumeCooldownUse,
  addInventory, removeInventory, addMaterial,
  hasWeapon, addWeapon,
};
