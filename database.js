'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = process.env.ECONOMY_DATA_FILE || path.join(DATA_DIR, 'economy.json');
const PG_TABLE = 'public.xerion_economy_users';
const PG_CODES_TABLE = 'public.xerion_redeem_codes';
const PG_REDEMPTIONS_TABLE = 'public.xerion_redeem_code_redemptions';

let db = { users: {} };
let dirty = false;
let dirtyAll = false;
let postgresPool = null;
let postgresEnabled = false;
let saveInProgress = null;
let resetInProgress = false;
const dirtyUserIds = new Set();
const persistedSnapshots = new Map();
const userIds = new WeakMap();
let activeRedemptions = 0;

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
    if (!db.redeemCodeClaims || typeof db.redeemCodeClaims !== 'object' || Array.isArray(db.redeemCodeClaims)) db.redeemCodeClaims = {};
  } catch (err) {
    console.error('[DB] No se pudo leer economy.json, se inicia una base vacía:', err);
    db = { users: {}, redeemCodes: {}, redeemCodeClaims: {} };
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
  if (resetInProgress) return true;
  if (postgresEnabled) return savePostgresDB();
  return saveLocalDB();
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
      `CREATE TABLE IF NOT EXISTS ${PG_CODES_TABLE} (
        code_key TEXT PRIMARY KEY,
        code_text TEXT NOT NULL,
        reward BIGINT NOT NULL CHECK (reward > 0),
        expires_at TIMESTAMPTZ NOT NULL,
        created_by TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
    );
    await postgresPool.query(
      `CREATE TABLE IF NOT EXISTS ${PG_REDEMPTIONS_TABLE} (
        code_key TEXT NOT NULL REFERENCES ${PG_CODES_TABLE}(code_key) ON DELETE CASCADE,
        user_id TEXT NOT NULL,
        redeemed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (code_key, user_id)
      )`,
    );
    const result = await postgresPool.query(`SELECT user_id, user_data FROM ${PG_TABLE}`);
    db = { users: {}, redeemCodes: {}, redeemCodeClaims: {} };
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
    lastMessageAt: 0,
    cooldowns: {},
    cooldownCycles: {},
    inventory: {},
    effects: {},
    class: null,
    classChangedAt: 0,
    eventRolesPurchased: [],
    materials: {},
    activeQuest: null,
    questHistory: [],
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
  for (const key of ['cash', 'bank', 'debt', 'lastMessageAt', 'xp', 'classChangedAt', 'bountyOn', 'createdAt']) {
    if (!Number.isFinite(user[key])) user[key] = key === 'createdAt' ? Date.now() : 0;
  }
  user.cash = Math.max(0, user.cash);
  user.bank = Math.max(0, user.bank);
  user.debt = Math.max(0, user.debt);
  user.xp = Math.max(0, user.xp);
  if (!user.cooldowns || typeof user.cooldowns !== 'object' || Array.isArray(user.cooldowns)) user.cooldowns = {};
  if (!user.cooldownCycles || typeof user.cooldownCycles !== 'object' || Array.isArray(user.cooldownCycles)) user.cooldownCycles = {};
  if (!user.inventory || typeof user.inventory !== 'object' || Array.isArray(user.inventory)) user.inventory = {};
  if (!user.materials || typeof user.materials !== 'object' || Array.isArray(user.materials)) user.materials = {};
  for (const [id, quantity] of Object.entries(user.materials)) {
    if (!Number.isSafeInteger(quantity) || quantity <= 0) delete user.materials[id];
  }
  if (!user.effects || typeof user.effects !== 'object' || Array.isArray(user.effects)) user.effects = {};
  if (user.class === undefined) user.class = null;
  if (typeof user.classChangedAt !== 'number') user.classChangedAt = 0;
  if (typeof user.xp !== 'number') user.xp = 0;
  if (!Array.isArray(user.eventRolesPurchased)) user.eventRolesPurchased = [];
  if (!Array.isArray(user.questHistory)) user.questHistory = [];
  if (user.activeQuest !== null && (!user.activeQuest || typeof user.activeQuest !== 'object' || Array.isArray(user.activeQuest))) {
    user.activeQuest = null;
  }
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
  const quantity = Math.floor(Number(qty));
  if (!Number.isSafeInteger(quantity) || quantity < 1) return false;
  if (!user.materials || typeof user.materials !== 'object') user.materials = {};
  const current = user.materials[materialId] || 0;
  if (!Number.isSafeInteger(current + quantity)) return false;
  user.materials[materialId] = current + quantity;
  markDirty(user);
  return true;
}

function removeMaterial(user, materialId, qty = 1) {
  const quantity = Math.floor(Number(qty));
  if (!Number.isSafeInteger(quantity) || quantity < 1 || !user.materials || user.materials[materialId] < quantity) {
    return false;
  }
  user.materials[materialId] -= quantity;
  if (user.materials[materialId] <= 0) delete user.materials[materialId];
  markDirty(user);
  return true;
}

function normalizeRedeemCode(code) {
  return String(code || '').trim().toUpperCase();
}

async function createRedeemCode(code, reward, expiresAt, createdBy) {
  const key = normalizeRedeemCode(code);
  const expiration = new Date(expiresAt);
  if (!/^[A-Z0-9_-]{3,32}$/.test(key)
    || !Number.isSafeInteger(reward) || reward < 1
    || !Number.isFinite(expiration.getTime()) || expiration.getTime() <= Date.now()) {
    return { error: 'invalid' };
  }
  const record = {
    code: key,
    reward,
    expiresAt: expiration.toISOString(),
    createdBy: String(createdBy),
    createdAt: new Date().toISOString(),
  };
  if (postgresPool) {
    try {
      await postgresPool.query(
        `INSERT INTO ${PG_CODES_TABLE} (code_key, code_text, reward, expires_at, created_by)
         VALUES ($1, $1, $2, $3, $4)`,
        [key, reward, expiration, record.createdBy],
      );
    } catch (err) {
      if (err.code === '23505') return { error: 'exists' };
      throw err;
    }
    return { code: record };
  }
  if (db.redeemCodes[key]) return { error: 'exists' };
  db.redeemCodes[key] = record;
  markDirty();
  await saveLocalDB();
  return { code: record };
}

async function listRedeemCodes() {
  if (postgresPool) {
    const result = await postgresPool.query(
      `SELECT c.code_text AS code, c.reward, c.expires_at AS "expiresAt",
              c.created_at AS "createdAt", COUNT(r.user_id)::int AS "redeemedCount"
       FROM ${PG_CODES_TABLE} c
       LEFT JOIN ${PG_REDEMPTIONS_TABLE} r ON r.code_key = c.code_key
       GROUP BY c.code_key
       ORDER BY c.created_at DESC`,
    );
    return result.rows.map((row) => ({
      code: row.code,
      reward: Number(row.reward),
      expiresAt: new Date(row.expiresAt).toISOString(),
      createdAt: new Date(row.createdAt).toISOString(),
      redeemedCount: row.redeemedCount,
    }));
  }
  return Object.values(db.redeemCodes || {})
    .map((entry) => ({
      ...entry,
      redeemedCount: Object.keys((db.redeemCodeClaims || {})[entry.code] || {}).length,
    }))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

async function deleteRedeemCode(code) {
  const key = normalizeRedeemCode(code);
  if (postgresPool) {
    const result = await postgresPool.query(`DELETE FROM ${PG_CODES_TABLE} WHERE code_key = $1`, [key]);
    return result.rowCount > 0;
  }
  if (!db.redeemCodes || !db.redeemCodes[key]) return false;
  delete db.redeemCodes[key];
  if (db.redeemCodeClaims) delete db.redeemCodeClaims[key];
  markDirty();
  await saveLocalDB();
  return true;
}

async function redeemCode(userId, code) {
  activeRedemptions += 1;
  try {
    return await redeemCodeUnlocked(userId, code);
  } finally {
    activeRedemptions -= 1;
  }
}

async function redeemCodeUnlocked(userId, code) {
  const key = normalizeRedeemCode(code);
  const cachedUser = getUser(String(userId));
  if (getLevel(cachedUser.xp) < 10) return { error: 'level_required', level: getLevel(cachedUser.xp) };

  if (!postgresPool) {
    const record = (db.redeemCodes || {})[key];
    if (!record) return { error: 'notfound' };
    if (new Date(record.expiresAt).getTime() <= Date.now()) return { error: 'expired' };
    if (!db.redeemCodeClaims) db.redeemCodeClaims = {};
    if (!db.redeemCodeClaims[key]) db.redeemCodeClaims[key] = {};
    if (db.redeemCodeClaims[key][userId]) return { error: 'used' };
    if (!Number.isSafeInteger(cachedUser.cash + record.reward)) return { error: 'balance_overflow' };
    cachedUser.cash += record.reward;
    db.redeemCodeClaims[key][userId] = new Date().toISOString();
    markDirty(cachedUser);
    await saveLocalDB();
    return { code: record.code, reward: record.reward, cash: cachedUser.cash };
  }

  if (!await saveDB()) return { error: 'storage_error' };
  const client = await postgresPool.connect();
  try {
    await client.query('BEGIN');
    const codeResult = await client.query(
      `SELECT code_text, reward, expires_at FROM ${PG_CODES_TABLE} WHERE code_key = $1 FOR UPDATE`,
      [key],
    );
    if (!codeResult.rowCount) {
      await client.query('ROLLBACK');
      return { error: 'notfound' };
    }
    const record = codeResult.rows[0];
    if (new Date(record.expires_at).getTime() <= Date.now()) {
      await client.query('ROLLBACK');
      return { error: 'expired' };
    }
    const claim = await client.query(
      `INSERT INTO ${PG_REDEMPTIONS_TABLE} (code_key, user_id)
       VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING user_id`,
      [key, String(userId)],
    );
    if (!claim.rowCount) {
      await client.query('ROLLBACK');
      return { error: 'used' };
    }
    const reward = Number(record.reward);
    if (!Number.isSafeInteger(cachedUser.cash + reward)) {
      await client.query('ROLLBACK');
      return { error: 'balance_overflow' };
    }
    const updatedUser = { ...cachedUser, cash: cachedUser.cash + reward };
    const snapshot = JSON.stringify(updatedUser);
    await client.query(
      `INSERT INTO ${PG_TABLE} (user_id, user_data, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (user_id) DO UPDATE SET user_data = EXCLUDED.user_data, updated_at = NOW()`,
      [String(userId), snapshot],
    );
    await client.query('COMMIT');
    Object.assign(cachedUser, updatedUser);
    persistedSnapshots.set(String(userId), JSON.stringify(cachedUser));
    dirtyUserIds.delete(String(userId));
    dirty = dirtyAll || dirtyUserIds.size > 0;
    return { code: record.code_text, reward, cash: cachedUser.cash };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function resetAllProgress() {
  while (activeRedemptions > 0) await new Promise((resolve) => setTimeout(resolve, 10));
  resetInProgress = true;
  try {
    if (saveInProgress) await saveInProgress;
    const usersReset = Object.keys(db.users || {}).length;
    if (postgresPool) {
      const client = await postgresPool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`DELETE FROM ${PG_REDEMPTIONS_TABLE}`);
        await client.query(`DELETE FROM ${PG_TABLE}`);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    }
    db.users = {};
    db.redeemCodeClaims = {};
    persistedSnapshots.clear();
    dirtyUserIds.clear();
    dirty = false;
    dirtyAll = false;
    if (!postgresPool) {
      dirty = true;
      dirtyAll = true;
      resetInProgress = false;
      await saveLocalDB();
    }
    return { usersReset };
  } finally {
    resetInProgress = false;
  }
}

function hasActiveRedemptions() {
  return activeRedemptions > 0;
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
  getUser, getAllUsers, getTotal, resetUser,
  clamp, fmt, randomInt, randomFloat, formatDuration,
  getLevel, xpForLevel, addXp, incrementStat,
  cleanEffects, getStacks, getEffectRemaining, applyPotionEffect, consumeRevive,
  isOnCooldown, getCooldownRemaining, setCooldown,
  consumeCooldownUse,
  addInventory, removeInventory,
  addMaterial, removeMaterial,
  hasWeapon, addWeapon,
  createRedeemCode, listRedeemCodes, deleteRedeemCode, redeemCode, resetAllProgress,
  hasActiveRedemptions,
};
