'use strict';

const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const { setupEnv, cleanupEnv, seeded } = require('./_helpers');

const tempDir = setupEnv('xp');

const cfg = require('../config');
const db = require('../database');
const economy = require('../economy');

before(async () => { await db.loadDB(); });
after(async () => { await db.closeDB(); cleanupEnv(tempDir); });

const ACTIONS = Object.keys(cfg.XP_PER_ACTION);

function withRandom(fn, value) {
  const original = Math.random;
  Math.random = typeof value === 'function' ? value : () => value;
  try { return fn(); } finally { Math.random = original; }
}

// ---------- Se conserva la curva y se corrige el desbalance de boss ----------

test('the existing level curve stays intact and boss XP is balanced against its cooldown', () => {
  for (let level = 0; level <= 60; level += 1) {
    assert.equal(db.xpForLevel(level), level * level * 50);
    assert.equal(db.getLevel(db.xpForLevel(level)), level);
    if (level > 0) assert.equal(db.getLevel(db.xpForLevel(level) - 1), level - 1);
  }
  assert.deepEqual(
    Object.fromEntries(Object.entries(cfg.XP_PER_ACTION).filter(([k]) => !['train', 'interest'].includes(k))),
    {
      work: 6, beg: 4, crime: 6, hunt: 8, dungeon: 160, boss: 150, duel: 6, quest: 10, rob: 6,
      scavenge: 6, candyraid: 6, harvest: 6, trickortreat: 4, daily: 6, collect: 6,
    },
  );
  assert.equal(cfg.COOLDOWNS.boss, 3 * 60 * 60 * 1000);
  assert.equal(cfg.COOLDOWNS.dungeon, 60 * 60 * 1000);
  assert.deepEqual(economy.xpRangeAtLevel('boss', 0), { min: 90, max: 210, factor: 1, base: 150 });
});

// ---------- Rangos acotados ----------

test('every action has a bounded range whose average equals its base XP at level 0', () => {
  for (const action of ACTIONS) {
    const base = cfg.XP_PER_ACTION[action];
    const range = economy.xpRange(action);
    assert.ok(range.min >= 1 && range.max >= range.min, `${action} has a valid range`);
    assert.ok(range.min <= base && range.max >= base, `${action} base sits inside its range`);
    assert.equal((range.min + range.max) / 2, base, `${action} keeps the base as its average`);
    assert.ok(range.max <= Math.round(base * (1 + cfg.XP_SPREAD)));
    assert.ok(range.min >= Math.max(1, Math.round(base * (1 - cfg.XP_SPREAD))));
  }
  assert.equal(economy.xpRange('unknown'), null);
});

test('the level factor starts at 1, grows with level and is capped', () => {
  assert.equal(economy.xpLevelFactor(0), 1);
  let previous = 1;
  for (let level = 1; level <= 200; level += 1) {
    const factor = economy.xpLevelFactor(level);
    assert.ok(factor >= previous, 'never decreases');
    assert.ok(factor <= cfg.XP_LEVEL_SCALE.maxFactor, 'never exceeds the cap');
    previous = factor;
  }
  assert.equal(economy.xpLevelFactor(1000), cfg.XP_LEVEL_SCALE.maxFactor);
  assert.equal(economy.xpLevelFactor(-5), 1);
  assert.equal(economy.xpLevelFactor(Number.NaN), 1);
  assert.ok(economy.xpLevelFactor(10) > economy.xpLevelFactor(5));
});

test('ranges at every level stay positive, ordered and monotonic', () => {
  for (const action of ACTIONS) {
    let previous = { min: 0, max: 0 };
    for (let level = 0; level <= 120; level += 1) {
      const range = economy.xpRangeAtLevel(action, level);
      assert.ok(Number.isInteger(range.min) && Number.isInteger(range.max));
      assert.ok(range.min >= 1 && range.max >= range.min);
      assert.ok(range.min >= previous.min && range.max >= previous.max, `${action} L${level} does not shrink`);
      assert.ok(range.max <= Math.round(economy.xpRange(action).max * cfg.XP_LEVEL_SCALE.maxFactor) + 1);
      previous = range;
    }
  }
});

test('rolled XP is always inside the range for that level and hits both ends', () => {
  for (const action of ACTIONS) {
    for (const xp of [0, 50, 1250, 5000, 45000, 200000]) {
      const user = { xp };
      const range = economy.xpRangeAtLevel(action, db.getLevel(xp));
      assert.equal(economy.rollXp(user, action, () => 0), range.min);
      assert.equal(economy.rollXp(user, action, () => 0.999999999), range.max);
      const rng = seeded(xp + action.length);
      for (let i = 0; i < 200; i += 1) {
        const value = economy.rollXp(user, action, rng);
        assert.ok(Number.isInteger(value) && value >= range.min && value <= range.max);
      }
    }
  }
  assert.equal(economy.rollXp({ xp: 0 }, 'not-an-action'), 0);
});

test('the sampled mean matches base × level factor (balanced, not skewed)', () => {
  const rng = seeded(7);
  for (const [action, level] of [['work', 0], ['work', 20], ['hunt', 10], ['dungeon', 30], ['train', 5]]) {
    const user = { xp: db.xpForLevel(level) };
    let sum = 0;
    const runs = 20000;
    for (let i = 0; i < runs; i += 1) sum += economy.rollXp(user, action, rng);
    const mean = sum / runs;
    const expected = cfg.XP_PER_ACTION[action] * economy.xpLevelFactor(level);
    assert.ok(Math.abs(mean - expected) / expected < 0.04, `${action} L${level}: mean ${mean} vs ${expected}`);
  }
});

// ---------- Progresión sin estancarse ----------

test('actions needed per level grow slowly instead of exploding (progression does not stall)', () => {
  const meanXp = (action, level) => {
    const range = economy.xpRangeAtLevel(action, level);
    return (range.min + range.max) / 2;
  };
  const needed = (level) => db.xpForLevel(level + 1) - db.xpForLevel(level);
  const scaled = (level) => needed(level) / meanXp('work', level);
  const unscaled = (level) => needed(level) / cfg.XP_PER_ACTION.work;
  // Sin ajuste por nivel, de L10 a L50 harían falta ~4.8× más acciones por nivel; con el ajuste, menos de 2.2×.
  assert.ok(unscaled(50) / unscaled(10) > 4.5);
  assert.ok(scaled(50) / scaled(10) < 2.2, `scaled growth ${scaled(50) / scaled(10)}`);
  // Y en términos absolutos, subir de nivel a L50 cuesta al menos 3× menos acciones que sin ajuste.
  assert.ok(scaled(50) < unscaled(50) / 3);
  // Acotado: el costo en acciones por nivel tiende a una constante (~280 para work) en lugar de crecer sin fin.
  for (let level = 1; level <= 50; level += 1) assert.ok(scaled(level) < 280, `level ${level} stays under the asymptote`);
  for (let level = 10; level < 50; level += 1) assert.ok(scaled(level + 1) - scaled(level) <= 12, `level ${level} step is gentle (integer rounding plateaus included)`);
});

// ---------- Solo acciones válidas dan XP ----------

test('recordActivity awards XP, persists it and reports exactly what was added', () => {
  const user = db.getUser('xp-record-1');
  user.xp = 0;
  const activity = economy.recordActivity(user, 'hunt', () => 0);
  assert.equal(activity.xp, economy.xpRange('hunt').min);
  assert.equal(user.xp, activity.xp);
  const second = economy.recordActivity(user, 'hunt', () => 0.999999);
  assert.equal(second.xp, economy.xpRangeAtLevel('hunt', db.getLevel(activity.xp)).max);
});

test('cooldown errors, missing banks and failed attempts never grant XP', () => {
  const originalNow = Date.now;
  let now = originalNow();
  Date.now = () => now;
  try {
    const worker = db.getUser('xp-cooldown-work');
    worker.xp = 0;
    worker.cooldowns = {};
    worker.cooldownCycles = {};
    assert.ok(!economy.doWork(worker).error);
    const afterFirst = worker.xp;
    assert.ok(afterFirst > 0);
    const blocked = economy.doWork(worker);
    assert.equal(blocked.error, 'cooldown');
    assert.equal(worker.xp, afterFirst, 'a cooldown error must not add XP');

    const trainee = db.getUser('xp-train');
    trainee.xp = 0;
    trainee.cooldowns = {};
    assert.ok(!economy.doTrain(trainee).error);
    const trained = trainee.xp;
    assert.equal(economy.doTrain(trainee).error, 'cooldown');
    assert.equal(trainee.xp, trained);

    const saver = db.getUser('xp-interest');
    saver.xp = 0;
    saver.bank = 10;
    saver.cooldowns = {};
    assert.equal(economy.doInterest(saver).error, 'bank_too_low');
    assert.equal(saver.xp, 0, 'a rejected interest claim must not add XP');
    assert.equal(saver.cooldowns.interest, undefined, 'and must not start the cooldown');

    // Fallos: crimen fallido y mazmorra fallida no dan XP.
    const failing = db.getUser('xp-failing');
    failing.xp = 0;
    failing.cooldowns = {};
    failing.cooldownCycles = {};
    withRandom(() => {
      const crime = economy.doCrime(failing);
      assert.equal(crime.success, false);
      const dungeon = economy.doDungeon(failing);
      assert.equal(dungeon.success, false);
    }, 0.999999);
    assert.equal(failing.xp, 0);
    now += 1;
  } finally {
    Date.now = originalNow;
  }
});

test('invalid casino and economy commands never add XP', () => {
  const user = db.getUser('xp-invalid');
  user.xp = 123;
  user.cash = 1000;
  assert.equal(economy.slots(user, -5).error, 'invalid');
  assert.equal(economy.playRoulette(user, 10, 'rojo').error, 'invalid');
  assert.equal(economy.playCrash(user, 5000, 2).error, 'insufficient');
  assert.equal(economy.playCrash(user, 100, 'xyz').error, 'invalid_target');
  assert.equal(economy.transfer(user, db.getUser('xp-invalid-2'), 99999).error, 'insufficient');
  assert.equal(user.xp, 123);
});

test('duplicate duel clicks are claimed once, so the winner XP is awarded once', () => {
  const challenger = db.getUser('xp-duel-a');
  const target = db.getUser('xp-duel-b');
  challenger.cash = 5000;
  target.cash = 5000;
  challenger.cooldowns = {};
  assert.ok(!economy.createDuelChallenge('xp-duel-a', challenger, 'xp-duel-b', 1000).error);
  const first = economy.claimDuelChallenge('xp-duel-b');
  const second = economy.claimDuelChallenge('xp-duel-b');
  assert.ok(first);
  assert.equal(second, null);
  assert.equal(economy.getDuelChallenge('xp-duel-b'), undefined);
  const xpBefore = challenger.xp + target.xp;
  const result = withRandom(() => economy.resolveDuel(challenger, 'xp-duel-a', target, 'xp-duel-b', first.bet), 0);
  assert.ok(!result.error);
  const gained = challenger.xp + target.xp - xpBefore;
  assert.equal(gained, result.winnerActivity.xp, 'exactly one winner activity was recorded');
});

// ---------- Efecto de las nuevas acciones ----------

test('train gives XP only, no Candys, and sets its cooldown; interest is capped and bank-based', () => {
  const originalNow = Date.now;
  Date.now = () => 1_800_000_000_000;
  try {
    const user = db.getUser('xp-new-actions');
    user.cash = 100;
    user.xp = 0;
    user.cooldowns = {};
    const trained = economy.doTrain(user);
    assert.equal(user.cash, 100);
    assert.ok(trained.activity.xp >= economy.xpRange('train').min);
    assert.equal(user.cooldowns.train, Date.now() + cfg.COOLDOWNS.train);

    user.bank = 50_000;
    const interest = economy.doInterest(user);
    assert.equal(interest.reward, 500);
    assert.equal(user.cash, 600);
    user.cooldowns = {};
    user.bank = 10_000_000_000;
    const capped = economy.doInterest(user);
    assert.equal(capped.reward, cfg.INTEREST_MAX);
    assert.ok(capped.reward <= cfg.MAX_SINGLE_GAIN);
    assert.equal(economy.doInterest(user).error, 'cooldown');
  } finally {
    Date.now = originalNow;
  }
});
