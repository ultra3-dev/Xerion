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

test('collect pays only the best purchased role, caps the payout, and shares one 24-hour cooldown', () => {
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
    assert.equal(first.reward, 250000);
    assert.equal(user.cash, 250000);

    currentTime += 23 * 60 * 60 * 1000;
    const tooSoon = economy.collectEventIncome(user, new Date(currentTime));
    assert.equal(tooSoon.error, 'cooldown');

    currentTime += 60 * 60 * 1000;
    const second = economy.collectEventIncome(user, new Date(currentTime));
    assert.equal(second.reward, 250000);
    assert.equal(user.cash, 500000);
  } finally {
    Date.now = originalNow;
  }
});

test('collect rejects calls outside the event and caps configuration at 300,000', () => {
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