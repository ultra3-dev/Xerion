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

test('all high-component shop and inventory cards stay within Discord’s 40-component limit', () => {
  const userId = '123456789012345678';
  const member = {
    id: userId,
    displayName: 'Tester',
    roles: { cache: { has: () => false } },
  };
  const user = db.getUser('component-test');
  user.eventRolesPurchased = [];
  user.inventory = Object.fromEntries(cfg.POTIONS.map((potion) => [potion.id, 2]));
  user.materials = Object.fromEntries(cfg.MATERIALS.map((material) => [material.id, 2]));
  user.weapons = cfg.WEAPONS.map((weapon) => weapon.id);
  user.effects = Object.fromEntries(cfg.POTIONS.map((potion) => [potion.id, {
    stacks: potion.maxStacks,
    expiresAt: Date.now() + 60_000,
  }]));

  const replies = [
    ui.shopContainer(cfg, userId),
    ui.eventShopContainer(cfg, new Date(cfg.EVENT_START), member, userId, user),
    ui.armoryContainer(cfg, user, userId),
    ui.inventoryContainer(cfg, member, user),
    ui.potionsInfoContainer(cfg),
    ui.helpContainer(cfg, 'admin', userId),
    ui.duelAnimationCard(cfg, member, { ...member, id: '123456789012345679', displayName: 'Rival' }, 3),
  ];
  for (const reply of replies) assert.ok(countComponents(reply.components) <= 40);
});

test('there are 39 named English materials and every event tier has material costs', () => {
  assert.equal(cfg.MATERIALS.length, 39);
  assert.equal(new Set(cfg.MATERIALS.map((item) => item.id)).size, 39);
  assert.ok(cfg.MATERIALS.every((item) => /^[A-Za-z][A-Za-z '-]*$/.test(item.name)));
  assert.ok(cfg.EVENT_SHOP.every((role) => role.materials && Object.keys(role.materials).length > 0));
});

test('collect pays the best purchased role and applies its 72-hour cooldown', () => {
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
    assert.equal(first.cooldownMs, 72 * 60 * 60 * 1000);
    assert.equal(user.cash, 369000);

    currentTime += 71 * 60 * 60 * 1000;
    const tooSoon = economy.collectEventIncome(user, new Date(currentTime));
    assert.equal(tooSoon.error, 'cooldown');

    currentTime += 60 * 60 * 1000;
    const second = economy.collectEventIncome(user, new Date(currentTime));
    assert.equal(second.reward, 369000);
    assert.equal(user.cash, 738000);
  } finally {
    Date.now = originalNow;
  }
});

test('collect rejects calls outside the event and caps the reward at 369,000', () => {
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

test('event-role purchase and activation both charge their material recipes', () => {
  const role = cfg.EVENT_SHOP.find((item) => item.id === 'spookyseason');
  const purchaser = db.getUser('material-purchase-test');
  purchaser.cash = role.price * 2;
  purchaser.materials = { ...role.materials };
  const purchase = economy.buyEventRole(new Date(cfg.EVENT_START), purchaser, role.id);
  assert.equal(purchase.cashCost, role.price);
  assert.deepEqual(purchase.materialsCost, role.materials);
  assert.equal(purchaser.eventRolesPurchased.includes(role.roleId), true);
  assert.equal(Object.keys(purchaser.materials).length, 0);

  const activator = db.getUser('material-activation-test');
  activator.cash = role.price;
  activator.materials = { ...role.materials };
  const activation = economy.buyEventRole(new Date(cfg.EVENT_START), activator, role.id, { activation: true });
  assert.equal(activation.cashCost, role.price);
  assert.equal(activation.activation, true);
  assert.equal(Object.keys(activator.materials).length, 0);
});

test('class names are case-insensitive and quests require real progress without repeating', () => {
  const user = db.getUser('class-quest-test');
  user.xp = db.xpForLevel(5);
  assert.equal(economy.setClass(user, 'HOMBRE LOBO').classDef.id, 'hombrelobo');
  assert.equal(economy.classDef('hombre lobo').id, 'hombrelobo');

  const previousMissions = cfg.QUEST_MISSIONS;
  const mission = {
    id: 'single-work-test',
    action: 'work',
    target: 1,
    description: 'Haz un trabajo de prueba.',
  };
  const originalNow = Date.now;
  let currentTime = Date.parse('2026-10-03T00:00:00Z');
  Date.now = () => currentTime;
  cfg.QUEST_MISSIONS = [mission];
  try {
    const questUser = db.getUser('quest-progress-test');
    assert.equal(economy.doQuest(questUser).assigned, true);
    assert.equal(questUser.activeQuest.progress, 0);
    assert.equal(economy.doWork(questUser).error, undefined);
    assert.equal(questUser.activeQuest.progress, 1);
    assert.equal(economy.doQuest(questUser).total > 0, true);
    assert.equal(questUser.activeQuest, null);
    currentTime += cfg.COOLDOWNS.quest;
    assert.equal(economy.doQuest(questUser).error, 'all_quests_done');
  } finally {
    Date.now = originalNow;
    cfg.QUEST_MISSIONS = previousMissions;
  }
});

test('casino wagers above the former 3,000 cap are accepted', () => {
  const user = db.getUser('uncapped-wager-test');
  user.cash = 50_000;
  assert.equal(economy.gamble(user, 3_001).error, undefined);

  const slotsUser = db.getUser('uncapped-slots-test');
  slotsUser.cash = 50_000;
  assert.equal(economy.slots(slotsUser, 3_001).error, undefined);

  const diceUser = db.getUser('uncapped-dice-test');
  diceUser.cash = 50_000;
  assert.equal(economy.playDice(diceUser, 3_001, 1).error, undefined);
});

test('redeem codes enforce level, expiry and one-use-per-user, and survive global progress reset', async () => {
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
  const created = await db.createRedeemCode({
    code: 'Treat-10',
    reward: 500,
    expiresAt,
    maxUses: 2,
  });
  assert.equal(created.code.code, 'treat-10');
  assert.equal((await db.redeemCode('redeemer-low-level', 'TREAT-10')).error, 'level_required');

  const first = db.getUser('redeemer-one');
  first.xp = db.xpForLevel(10);
  first.cash = 100;
  assert.equal((await db.redeemCode('redeemer-one', 'TREAT-10')).reward, 500);
  assert.equal(first.cash, 600);
  assert.equal((await db.redeemCode('redeemer-one', 'treat-10')).error, 'already_redeemed');

  const second = db.getUser('redeemer-two');
  second.xp = db.xpForLevel(10);
  assert.equal((await db.redeemCode('redeemer-two', 'treat-10')).reward, 500);
  const third = db.getUser('redeemer-three');
  third.xp = db.xpForLevel(10);
  assert.equal((await db.redeemCode('redeemer-three', 'treat-10')).error, 'exhausted');

  const soonExpired = await db.createRedeemCode({
    code: 'expires-soon',
    reward: 100,
    expiresAt: new Date(Date.now() + 5_000),
    maxUses: 1,
  });
  assert.equal(soonExpired.error, undefined);
  const expiryTester = db.getUser('redeemer-expiry');
  expiryTester.xp = db.xpForLevel(10);
  assert.equal(
    (await db.redeemCode('redeemer-expiry', 'expires-soon', new Date(Date.now() + 10_000))).error,
    'expired',
  );

  const priorProfiles = Object.keys(db.getAllUsers()).length;
  assert.equal(await db.resetAllUsers(), priorProfiles);
  assert.equal(Object.keys(db.getAllUsers()).length, 0);
  const preserved = db.getRedeemCodes().find((item) => item.code === 'treat-10');
  assert.equal(preserved.redeemedCount, 2);
  const recreated = db.getUser('redeemer-one');
  recreated.xp = db.xpForLevel(10);
  assert.equal((await db.redeemCode('redeemer-one', 'treat-10')).error, 'already_redeemed');

  const deactivated = await db.deactivateRedeemCode('treat-10');
  assert.equal(deactivated.code.active, false);
});