'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xerion-logic-test-'));
process.env.NODE_ENV = 'test';
process.env.ECONOMY_DATA_FILE = path.join(tempDir, 'economy.json');
delete process.env.DATABASE_URL;

const cfg = require('../config');
const db = require('../database');
const economy = require('../economy');
const ui = require('../ui');

function countComponents(value) {
  if (Array.isArray(value)) return value.reduce((total, item) => total + countComponents(item), 0);
  if (!value || typeof value !== 'object') return 0;
  let total = typeof value.type === 'number' ? 1 : 0;
  for (const child of Object.values(value)) total += countComponents(child);
  return total;
}

before(async () => {
  await db.loadDB();
});

after(async () => {
  await db.closeDB();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('the release exposes exactly 50 prefix command handlers', () => {
  const indexSource = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  const handlerCount = (indexSource.match(/commands\.[A-Za-z0-9_]+\s*=/g) || []).length;
  assert.equal(handlerCount, 50);
});

test('the configured event window includes Oct 3 through Nov 9 in UTC', () => {
  assert.equal(cfg.EVENT_START.toISOString(), '2026-10-03T00:00:00.000Z');
  assert.equal(cfg.EVENT_END.toISOString(), '2026-11-10T00:00:00.000Z');
});

test('both shop replies stay within Discord’s 40-component limit', () => {
  const userId = '123456789012345678';
  const member = { roles: { cache: { has: () => false } } };
  const user = { eventRolesPurchased: [] };
  const potionShop = ui.shopContainer(cfg, userId);
  const eventShop = ui.eventShopContainer(cfg, new Date(cfg.EVENT_START), member, userId, user);

  assert.ok(countComponents(potionShop.components) <= 40);
  assert.ok(countComponents(eventShop.components) <= 40);
});

test('collect pays only the best purchased role and uses that role’s 3-day cooldown', () => {
  const user = db.getUser('collect-test');
  user.eventRolesPurchased = [
    cfg.EVENT_SHOP.find((role) => role.id === 'starx').roleId,
    cfg.EVENT_SHOP.find((role) => role.id === 'spookyseason').roleId,
  ];

  const originalNow = Date.now;
  let currentTime = Date.parse('2026-10-03T00:00:00Z');
  Date.now = () => currentTime;
  try {
    const first = economy.collectEventIncome(user, new Date(currentTime));
    assert.equal(first.role.id, 'spookyseason');
    assert.equal(first.reward, 369000);
    assert.equal(first.cooldownMs, 3 * 24 * 60 * 60 * 1000);
    assert.equal(user.cash, 369000);

    currentTime += 23 * 60 * 60 * 1000;
    const tooSoon = economy.collectEventIncome(user, new Date(currentTime));
    assert.equal(tooSoon.error, 'cooldown');

    currentTime += 49 * 60 * 60 * 1000;
    const second = economy.collectEventIncome(user, new Date(currentTime));
    assert.equal(second.reward, 369000);
    assert.equal(user.cash, 738000);
  } finally {
    Date.now = originalNow;
  }
});

test('collect rejects calls outside the event and enforces the 369,000 payout ceiling', () => {
  const user = db.getUser('collect-cap-test');
  user.eventRolesPurchased = [cfg.EVENT_SHOP[0].roleId];
  const role = cfg.EVENT_SHOP[0];
  const previousReward = role.collectReward;
  role.collectReward = 999999;
  try {
    assert.equal(
      economy.collectEventIncome(user, new Date('2026-10-02T23:59:59Z')).error,
      'notstarted',
    );

    const now = Date.parse('2026-10-03T00:00:00Z');
    const originalNow = Date.now;
    Date.now = () => now;
    try {
      const result = economy.collectEventIncome(user, new Date(now));
      assert.equal(result.reward, cfg.EVENT_COLLECT_REWARD_CAP);
    } finally {
      Date.now = originalNow;
    }

    assert.equal(
      economy.collectEventIncome(user, new Date('2026-11-10T00:00:00Z')).error,
      'ended',
    );
  } finally {
    role.collectReward = previousReward;
  }
});

test('work and harvest keep distinct 5-minute and 3-minute intervals; rob waits 10 minutes', () => {
  assert.equal(cfg.COOLDOWN_POLICIES.work.intervalMs, 5 * 60 * 1000);
  assert.equal(cfg.COOLDOWN_POLICIES.harvest.intervalMs, 3 * 60 * 1000);
  assert.equal(cfg.COOLDOWN_POLICIES.rob.intervalMs, 10 * 60 * 1000);
  assert.equal(cfg.COOLDOWN_POLICIES.rob.restMs, 10 * 60 * 1000);
});

test('materials, role activation costs, and the highest collect tier match their configured values', () => {
  assert.equal(cfg.MATERIALS.length, 39);
  assert.equal(cfg.EVENT_SHOP[0].collectReward, 369000);
  assert.equal(cfg.EVENT_SHOP[0].collectCooldownMs, 3 * 24 * 60 * 60 * 1000);
  assert.ok(Object.values(cfg.EVENT_SHOP[0].materialRequirements).length > 0);
  assert.equal(Math.ceil(cfg.EVENT_SHOP[0].price / 2), 5175000);
});

test('class selection accepts case-insensitive IDs and full names', () => {
  const vampire = db.getUser('class-id-test');
  vampire.xp = 1250;
  assert.equal(economy.setClass(vampire, 'VaMpIrO').classDef.id, 'vampiro');

  const wolf = db.getUser('class-name-test');
  wolf.xp = 1250;
  assert.equal(economy.setClass(wolf, 'HOMBRE LOBO').classDef.id, 'hombrelobo');
});

test('quests are assigned without repeating until the configured set is exhausted', () => {
  const user = db.getUser('quest-cycle-test');
  const originalRandom = Math.random;
  Math.random = () => 0;
  try {
    user.questHistory = [];
    user.activeQuest = null;
    const first = economy.doQuest(user);
    user.activeQuest = null;
    const second = economy.doQuest(user);
    assert.notEqual(first.quest.id, second.quest.id);
    assert.equal(user.questHistory.length, 2);
  } finally {
    Math.random = originalRandom;
  }
});

test('work objectives progress and completed missions can be claimed', () => {
  const user = db.getUser('quest-progress-test');
  user.activeQuest = { id: 'graveyard_shift', progress: 0, startedAt: Date.now() };
  const originalNow = Date.now;
  let currentTime = originalNow();
  Date.now = () => currentTime;
  try {
    for (let i = 0; i < 3; i += 1) {
      const result = economy.doWork(user);
      assert.equal(result.error, undefined);
      currentTime += 6 * 60 * 1000;
    }
    assert.equal(user.activeQuest.progress, 3);
    const claim = economy.claimQuest(user);
    assert.ok(claim.total > 0);
    assert.equal(user.activeQuest, null);
  } finally {
    Date.now = originalNow;
  }
});

test('redeem codes require level 10, pay once, and support create/list/delete', async () => {
  const code = `TEST${Date.now().toString().slice(-8)}`;
  const expiry = new Date(Date.now() + 60 * 60 * 1000);
  const created = await db.createRedeemCode(code, 1234, expiry, 'owner');
  assert.equal(created.error, undefined);
  assert.equal((await db.createRedeemCode(code.toLowerCase(), 1234, expiry, 'owner')).error, 'exists');

  const lowLevel = db.getUser('redeem-low-level');
  lowLevel.xp = 4950;
  assert.equal((await db.redeemCode('redeem-low-level', code)).error, 'level_required');

  const eligible = db.getUser('redeem-level-ten');
  eligible.xp = 5000;
  const redeemed = await db.redeemCode('redeem-level-ten', code);
  assert.equal(redeemed.reward, 1234);
  assert.equal(eligible.cash, 1234);
  assert.equal((await db.redeemCode('redeem-level-ten', code)).error, 'used');

  const listed = await db.listRedeemCodes();
  assert.equal(listed.find((item) => item.code === code).redeemedCount, 1);
  assert.equal(await db.deleteRedeemCode(code), true);
  assert.equal(await db.deleteRedeemCode(code), false);
});

test('casino source has no configured maximum bet and inventory includes all owned materials', () => {
  const indexSource = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  const economySource = fs.readFileSync(path.join(__dirname, '..', 'economy.js'), 'utf8');
  assert.doesNotMatch(indexSource, /MAX_BET|maxbet/);
  assert.doesNotMatch(economySource, /MAX_BET|maxbet/);

  const user = db.getUser('inventory-materials-test');
  user.materials = Object.fromEntries(cfg.MATERIALS.map((material) => [material.id, 1]));
  const inventory = ui.inventoryContainer(cfg, { displayName: 'Tester' }, user);
  assert.ok(countComponents(inventory.components) <= 40);
  assert.match(JSON.stringify(inventory), /Eldritch Eye/);
});

test('potion, armory, and cooldown guidance explains how to use each system', () => {
  const potionGuide = JSON.stringify(ui.potionsInfoContainer(cfg));
  assert.match(potionGuide, /buy &lt;id&gt;|buy <id>/);
  assert.match(potionGuide, /use &lt;id&gt;|use <id>/);
  assert.match(potionGuide, /máximo de cargas/);

  const indebted = db.getUser('armory-debt-ui-test');
  indebted.cash = 0;
  indebted.debt = 100;
  const armory = JSON.stringify(ui.armoryContainer(cfg, indebted, 'armory-debt-ui-test'));
  assert.match(armory, /Paga tu deuda/);
  assert.match(armory, /Solo el arma equipada aplica su bonus/);

  const cooldowns = JSON.stringify(ui.cooldownsContainer(cfg, { displayName: 'Tester' }, ['Collect: disponible']));
  assert.match(cooldowns, /mejor rol que hayas comprado/);
  assert.match(cooldowns, /no se acumulan/);
});

test('global reset clears profiles and claims but preserves redeem-code definitions', async () => {
  const code = `KEEP${Date.now().toString().slice(-8)}`;
  await db.createRedeemCode(code, 10, new Date(Date.now() + 60 * 60 * 1000), 'owner');
  const user = db.getUser('global-reset-test');
  user.cash = 98765;
  db.markDirty(user);

  const result = await db.resetAllProgress();
  assert.ok(result.usersReset > 0);
  assert.equal(db.getUser('global-reset-test').cash, 0);
  assert.ok((await db.listRedeemCodes()).some((entry) => entry.code === code));
  await db.deleteRedeemCode(code);
});