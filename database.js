'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = process.env.ECONOMY_DATA_FILE || path.join(DATA_DIR, 'economy.json');
const PG_TABLE = 'public.xerion_economy_users';
const PG_CODES_TABLE = 'public.xerion_redeem_codes';
const PG_CLAIMS_TABLE = 'public.xerion_code_redemptions';

let db = { users: {}, redeemCodes: [], codeRedemptions: [] };
let dirty = false;
let dirtyAll = false;
let postgresPool = null;
let postgresEnabled = false;
let saveInProgress = null;
let persistenceTail = Promise.resolve();
let resetEpoch = 0;
const dirtyUserIds = new Set();
const persistedSnapshots = new Map();
const userIds = new WeakMap();
const userEpochs = new WeakMap();

function runExclusive(operation) {
  const result = persistenceTail.then(operation, operation);
  persistenceTail = result.catch(() => {});
  return result;
}

// ---------- Persistencia ----------

function attachUserId(id, user) {
  userIds.set(user, String(id));
  userEpochs.set(user, resetEpoch);
  return user;
}

function markDirty(...users) {
  dirty = true;
  if (!users.length) {
    dirtyAll = true;
    return;
  }
  for (const user of users) {
    if (user && userEpochs.has(user) && userEpochs.get(user) !== resetEpoch) continue;
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
    if (!Array.isArray(db.redeemCodes)) db.redeemCodes = [];
    if (!Array.isArray(db.codeRedemptions)) db.codeRedemptions = [];
  } catch (err) {
    console.error('[DB] No se pudo leer economy.json, se inicia una base vacía:', err);
    db = { users: {}, redeemCodes: [], codeRedemptions: [] };
  }
  if (!Array.isArray(db.redeemCodes)) db.redeemCodes = [];
  if (!Array.isArray(db.codeRedemptions)) db.codeRedemptions = [];
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
  return runExclusive(() => (postgresEnabled ? savePostgresDB() : saveLocalDB()));
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
        code TEXT PRIMARY KEY,
        reward BIGINT NOT NULL CHECK (reward > 0),
        expires_at TIMESTAMPTZ NOT NULL,
        max_uses INTEGER NOT NULL CHECK (max_uses > 0),
        redeemed_count INTEGER NOT NULL DEFAULT 0 CHECK (redeemed_count >= 0),
        active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
    );
    await postgresPool.query(
      `CREATE TABLE IF NOT EXISTS ${PG_CLAIMS_TABLE} (
        code TEXT NOT NULL REFERENCES ${PG_CODES_TABLE}(code) ON DELETE RESTRICT,
        user_id TEXT NOT NULL,
        redeemed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (code, user_id)
      )`,
    );
    const result = await postgresPool.query(`SELECT user_id, user_data FROM ${PG_TABLE}`);
    db = { users: {}, redeemCodes: [], codeRedemptions: [] };
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
    let codesResult = await postgresPool.query(
      `SELECT code, reward, expires_at, max_uses, redeemed_count, active, created_at
       FROM ${PG_CODES_TABLE} ORDER BY created_at DESC`,
    );
    if (codesResult.rowCount === 0 && fs.existsSync(DATA_FILE)) {
      try {
        const local = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        const localCodes = Array.isArray(local.redeemCodes) ? local.redeemCodes : [];
        const localClaims = Array.isArray(local.codeRedemptions) ? local.codeRedemptions : [];
        const validCodes = localCodes.filter((item) => (
          item
          && /^[a-z0-9_-]{3,32}$/.test(String(item.code || ''))
          && Number.isSafeInteger(Number(item.reward))
          && Number(item.reward) > 0
          && Number.isSafeInteger(Number(item.maxUses))
          && Number(item.maxUses) > 0
          && Number.isSafeInteger(Number(item.redeemedCount || 0))
          && new Date(item.expiresAt).getTime() > 0
          && new Date(item.createdAt).getTime() > 0
        ));
        if (validCodes.length) {
          const client = await postgresPool.connect();
          try {
            await client.query('BEGIN');
            for (const item of validCodes) {
              await client.query(
                `INSERT INTO ${PG_CODES_TABLE}
                   (code, reward, expires_at, max_uses, redeemed_count, active, created_at)
                 VALUES ($1, $2, $3::timestamptz, $4, $5, $6, $7::timestamptz)
                 ON CONFLICT (code) DO NOTHING`,
                [
                  item.code,
                  Number(item.reward),
                  new Date(item.expiresAt).toISOString(),
                  Number(item.maxUses),
                  Number(item.redeemedCount || 0),
                  item.active !== false,
                  new Date(item.createdAt).toISOString(),
                ],
              );
            }
            const validCodeIds = new Set(validCodes.map((item) => item.code));
            for (const claim of localClaims) {
              if (
                !claim
                || !validCodeIds.has(claim.code)
                || !/^\d{1,32}$/.test(String(claim.userId || ''))
              ) continue;
              const redeemedAt = new Date(claim.redeemedAt);
              await client.query(
                `INSERT INTO ${PG_CLAIMS_TABLE} (code, user_id, redeemed_at)
                 VALUES ($1, $2, $3::timestamptz)
                 ON CONFLICT (code, user_id) DO NOTHING`,
                [claim.code, String(claim.userId), Number.isFinite(redeemedAt.getTime()) ? redeemedAt.toISOString() : new Date().toISOString()],
              );
            }
            await client.query('COMMIT');
          } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            throw err;
          } finally {
            client.release();
          }
        }
      } catch (err) {
        console.error('[DB] No se pudo importar el historial local de códigos:', err.message);
        throw err;
      }
      codesResult = await postgresPool.query(
        `SELECT code, reward, expires_at, max_uses, redeemed_count, active, created_at
         FROM ${PG_CODES_TABLE} ORDER BY created_at DESC`,
      );
    }
    db.redeemCodes = codesResult.rows.map((row) => ({
      code: row.code,
      reward: Number(row.reward),
      expiresAt: new Date(row.expires_at).toISOString(),
      maxUses: Number(row.max_uses),
      redeemedCount: Number(row.redeemed_count),
      active: row.active,
      createdAt: new Date(row.created_at).toISOString(),
    }));
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
    materials: {},
    effects: {},
    class: null,
    classChangedAt: 0,
    eventRolesPurchased: [],
    redeemedCodes: [],
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
  if (!user.effects || typeof user.effects !== 'object' || Array.isArray(user.effects)) user.effects = {};
  if (user.class === undefined) user.class = null;
  if (typeof user.classChangedAt !== 'number') user.classChangedAt = 0;
  if (typeof user.xp !== 'number') user.xp = 0;
  if (!Array.isArray(user.eventRolesPurchased)) user.eventRolesPurchased = [];
  if (!Array.isArray(user.redeemedCodes)) user.redeemedCodes = [];
  if (user.activeQuest !== null && (!user.activeQuest || typeof user.activeQuest !== 'object' || Array.isArray(user.activeQuest))) {
    user.activeQuest = null;
  }
  if (!Array.isArray(user.questHistory)) user.questHistory = [];
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

async function resetAllUsers() {
  return runExclusive(async () => {
    const count = Object.keys(db.users).length;
    if (postgresEnabled) {
      await savePostgresDB();
      const client = await postgresPool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`DELETE FROM ${PG_TABLE}`);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
      resetEpoch += 1;
      db.users = {};
      dirtyUserIds.clear();
      persistedSnapshots.clear();
      dirtyAll = false;
      dirty = false;
      return count;
    }

    const previousUsers = db.users;
    db.users = {};
    dirtyAll = true;
    dirtyUserIds.clear();
    dirty = true;
    if (!(await saveLocalDB())) {
      db.users = previousUsers;
      dirty = true;
      dirtyAll = true;
      throw new Error('No se pudo persistir el reinicio local.');
    }
    resetEpoch += 1;
    persistedSnapshots.clear();
    return count;
  });
}

function addMaterial(user, materialId, qty = 1) {
  if (!Number.isSafeInteger(qty) || qty < 1) return false;
  user.materials[materialId] = (user.materials[materialId] || 0) + qty;
  markDirty(user);
  return true;
}

function removeMaterial(user, materialId, qty = 1) {
  if (!Number.isSafeInteger(qty) || qty < 1 || (user.materials[materialId] || 0) < qty) return false;
  user.materials[materialId] -= qty;
  if (user.materials[materialId] <= 0) delete user.materials[materialId];
  markDirty(user);
  return true;
}

function normalizeRedeemCode(input) {
  return String(input || '').trim().toLowerCase();
}

function getRedeemCodes() {
  return db.redeemCodes.map((code) => ({ ...code }));
}

async function createRedeemCode({ code: rawCode, reward, expiresAt, maxUses = 1 }, now = new Date()) {
  const code = normalizeRedeemCode(rawCode);
  const expiry = new Date(expiresAt);
  const useLimit = Number(maxUses);
  const amount = Number(reward);
  if (!/^[a-z0-9_-]{3,32}$/.test(code)) return { error: 'invalid_code' };
  if (!Number.isSafeInteger(amount) || amount < 1) return { error: 'invalid_reward' };
  if (!Number.isFinite(expiry.getTime()) || expiry <= now) return { error: 'invalid_expiry' };
  if (!Number.isSafeInteger(useLimit) || useLimit < 1 || useLimit > 1000000) return { error: 'invalid_uses' };

  return runExclusive(async () => {
    if (db.redeemCodes.some((item) => item.code === code)) return { error: 'exists' };
    const newCode = {
      code,
      reward: amount,
      expiresAt: expiry.toISOString(),
      maxUses: useLimit,
      redeemedCount: 0,
      active: true,
      createdAt: now.toISOString(),
    };
    if (postgresEnabled) {
      try {
        await postgresPool.query(
          `INSERT INTO ${PG_CODES_TABLE} (code, reward, expires_at, max_uses)
           VALUES ($1, $2, $3::timestamptz, $4)`,
          [code, amount, expiry.toISOString(), useLimit],
        );
      } catch (err) {
        if (err.code === '23505') return { error: 'exists' };
        console.error('[DB] No se pudo crear el código:', err.message);
        return { error: 'persistence_error' };
      }
      db.redeemCodes.unshift(newCode);
    } else {
      db.redeemCodes.unshift(newCode);
      dirty = true;
      if (!(await saveLocalDB())) {
        db.redeemCodes = db.redeemCodes.filter((item) => item.code !== code);
        return { error: 'persistence_error' };
      }
    }
    return { code: { ...newCode } };
  });
}

async function deactivateRedeemCode(rawCode) {
  const code = normalizeRedeemCode(rawCode);
  return runExclusive(async () => {
    const entry = db.redeemCodes.find((item) => item.code === code);
    if (!entry) return { error: 'notfound' };
    if (!entry.active) return { code: { ...entry } };
    if (postgresEnabled) {
      const result = await postgresPool.query(
        `UPDATE ${PG_CODES_TABLE} SET active = FALSE WHERE code = $1
         RETURNING code, reward, expires_at, max_uses, redeemed_count, active, created_at`,
        [code],
      );
      const row = result.rows[0];
      if (!row) return { error: 'notfound' };
      Object.assign(entry, {
        reward: Number(row.reward),
        expiresAt: new Date(row.expires_at).toISOString(),
        maxUses: Number(row.max_uses),
        redeemedCount: Number(row.redeemed_count),
        active: row.active,
        createdAt: new Date(row.created_at).toISOString(),
      });
    } else {
      entry.active = false;
      dirty = true;
      if (!(await saveLocalDB())) {
        entry.active = true;
        return { error: 'persistence_error' };
      }
    }
    return { code: { ...entry } };
  });
}

async function redeemCode(userId, rawCode, now = new Date()) {
  const code = normalizeRedeemCode(rawCode);
  if (!/^[a-z0-9_-]{3,32}$/.test(code)) return { error: 'notfound' };
  return runExclusive(async () => {
    const user = getUser(String(userId));
    if (getLevel(user.xp) < 10) return { error: 'level_required', level: 10 };

    if (!postgresEnabled) {
      const codeEntry = db.redeemCodes.find((item) => item.code === code);
      if (!codeEntry || !codeEntry.active) return { error: 'notfound' };
      if (new Date(codeEntry.expiresAt) <= now) return { error: 'expired' };
      if (
        db.codeRedemptions.some((claim) => claim.code === code && claim.userId === String(userId))
        || (Array.isArray(user.redeemedCodes) && user.redeemedCodes.includes(code))
      ) return { error: 'already_redeemed' };
      if (codeEntry.redeemedCount >= codeEntry.maxUses) return { error: 'exhausted' };
      if (!Number.isSafeInteger(user.cash + codeEntry.reward)) return { error: 'balance_limit' };

      const oldCash = user.cash;
      const oldCodes = [...user.redeemedCodes];
      codeEntry.redeemedCount += 1;
      user.cash += codeEntry.reward;
      user.redeemedCodes.push(code);
      db.codeRedemptions.push({ code, userId: String(userId), redeemedAt: now.toISOString() });
      markDirty(user);
      if (!(await saveLocalDB())) {
        codeEntry.redeemedCount -= 1;
        db.codeRedemptions = db.codeRedemptions.filter(
          (claim) => !(claim.code === code && claim.userId === String(userId)),
        );
        user.cash = oldCash;
        user.redeemedCodes = oldCodes;
        markDirty(user);
        return { error: 'persistence_error' };
      }
      return { reward: codeEntry.reward, code };
    }

    const currentUser = db.users[String(userId)];
    const before = JSON.stringify(currentUser);
    await savePostgresDB();
    const client = await postgresPool.connect();
    let transactionOpen = false;
    let resultCode = null;
    try {
      await client.query('BEGIN');
      transactionOpen = true;
      const codeResult = await client.query(
        `SELECT code, reward, expires_at, max_uses, redeemed_count, active
         FROM ${PG_CODES_TABLE} WHERE code = $1 FOR UPDATE`,
        [code],
      );
      const codeEntry = codeResult.rows[0];
      if (!codeEntry || !codeEntry.active) return { error: 'notfound' };
      if (new Date(codeEntry.expires_at) <= now) return { error: 'expired' };
      const claimed = await client.query(
        `SELECT 1 FROM ${PG_CLAIMS_TABLE} WHERE code = $1 AND user_id = $2`,
        [code, String(userId)],
      );
      if (claimed.rowCount) return { error: 'already_redeemed' };
      if (Number(codeEntry.redeemed_count) >= Number(codeEntry.max_uses)) return { error: 'exhausted' };
      const reward = Number(codeEntry.reward);
      if (!Number.isSafeInteger(currentUser.cash + reward)) return { error: 'balance_limit' };

      const updatedUser = JSON.parse(before);
      updatedUser.cash += reward;
      if (!Array.isArray(updatedUser.redeemedCodes)) updatedUser.redeemedCodes = [];
      updatedUser.redeemedCodes.push(code);
      const snapshot = JSON.stringify(updatedUser);
      await client.query(
        `INSERT INTO ${PG_TABLE} (user_id, user_data, updated_at)
         VALUES ($1, $2::jsonb, NOW())
         ON CONFLICT (user_id) DO UPDATE
         SET user_data = EXCLUDED.user_data, updated_at = NOW()`,
        [String(userId), snapshot],
      );
      await client.query(
        `INSERT INTO ${PG_CLAIMS_TABLE} (code, user_id) VALUES ($1, $2)`,
        [code, String(userId)],
      );
      await client.query(
        `UPDATE ${PG_CODES_TABLE} SET redeemed_count = redeemed_count + 1 WHERE code = $1`,
        [code],
      );
      await client.query('COMMIT');
      transactionOpen = false;
      resultCode = { reward, code };

      const latestUser = db.users[String(userId)];
      if (JSON.stringify(latestUser) === before) {
        const savedUser = attachUserId(String(userId), updatedUser);
        db.users[String(userId)] = savedUser;
        persistedSnapshots.set(String(userId), snapshot);
        dirtyUserIds.delete(String(userId));
        dirty = dirtyAll || dirtyUserIds.size > 0;
      } else {
        latestUser.cash += reward;
        if (!Array.isArray(latestUser.redeemedCodes)) latestUser.redeemedCodes = [];
        if (!latestUser.redeemedCodes.includes(code)) latestUser.redeemedCodes.push(code);
        markDirty(latestUser);
      }
      const cachedCode = db.redeemCodes.find((item) => item.code === code);
      if (cachedCode) cachedCode.redeemedCount += 1;
      return resultCode;
    } catch (err) {
      if (err.code === '23505') return { error: 'already_redeemed' };
      console.error('[DB] No se pudo canjear el código:', err.message);
      return { error: 'persistence_error' };
    } finally {
      if (transactionOpen) await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });
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
  const cycle = user.cooldownCycles[key] || { uses: 0, lastWasRest: false };
  if (!Number.isInteger(cycle.uses) || cycle.uses < 0 || cycle.uses >= uses) cycle.uses = 0;
  cycle.uses += 1;
  const isRest = cycle.uses >= uses;
  const durationMs = Math.max(0, isRest ? policy.restMs : policy.intervalMs);
  if (isRest) cycle.uses = 0;
  cycle.lastWasRest = isRest;
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
  getUser, getAllUsers, getTotal, resetUser, resetAllUsers,
  clamp, fmt, randomInt, randomFloat, formatDuration,
  getLevel, xpForLevel, addXp, incrementStat,
  cleanEffects, getStacks, getEffectRemaining, applyPotionEffect, consumeRevive,
  isOnCooldown, getCooldownRemaining, setCooldown,
  consumeCooldownUse,
  addInventory, removeInventory, addMaterial, removeMaterial,
  hasWeapon, addWeapon,
  createRedeemCode, getRedeemCodes, deactivateRedeemCode, redeemCode,
};
