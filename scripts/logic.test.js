'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');
const { MessageFlags } = require('discord.js');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xerion-logic-test-'));
process.env.NODE_ENV = 'test';
process.env.ECONOMY_DATA_FILE = path.join(tempDir, 'economy.json');
delete process.env.DATABASE_URL;

const cfg = require('../config');
const db = require('../database');
const economy = require('../economy');
const ui = require('../ui');
const dashboard = require('../dashboard');
const { resolveLeaderboardEntries } = require('../leaderboard-names');

function countComponents(value) {
  if (Array.isArray(value)) return value.reduce((total, item) => total + countComponents(item), 0);
  if (!value || typeof value !== 'object') return 0;
  let total = typeof value.type === 'number' ? 1 : 0;
  for (const child of Object.values(value)) total += countComponents(child);
  return total;
}

async function sendDashboardRequest({ method, url, cookie = '', body = '' }, dependencies) {
  const request = new EventEmitter();
  request.method = method;
  request.url = url;
  request.headers = { cookie };
  request.socket = { remoteAddress: '203.0.113.25' };

  const response = {
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    writeHead(status, headers = {}) {
      this.statusCode = status;
      Object.assign(this.headers, headers);
      this.headersSent = true;
    },
    end(bodyText = '') {
      this.body = bodyText;
      this.writableEnded = true;
    },
  };

  const pending = dashboard.handleAdminRequest(request, response, dependencies);
  if (body) {
    request.emit('data', Buffer.from(body));
    request.emit('end');
  }
  await pending;
  return response;
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

test('the configured event window matches the supplied Unix timestamps exactly', () => {
  assert.equal(Math.floor(cfg.EVENT_START.getTime() / 1000), 1791081000);
  assert.equal(Math.floor(cfg.EVENT_END.getTime() / 1000), 1794256200);
  assert.equal(cfg.EVENT_START.toISOString(), '2026-10-04T02:30:00.000Z');
  assert.equal(cfg.EVENT_END.toISOString(), '2026-11-09T20:30:00.000Z');
});

test('the existing level curve stays intact for current players', () => {
  assert.equal(db.getLevel(49), 0);
  assert.equal(db.getLevel(50), 1);
  assert.equal(db.getLevel(4999), 9);
  assert.equal(db.getLevel(5000), 10);
  assert.equal(db.xpForLevel(10), 5000);
});

test('world events run every 90 minutes and cap payouts with one 39k winner', () => {
  assert.equal(cfg.WORLD_EVENT_INTERVAL_MS, 90 * 60 * 1000);
  assert.equal(cfg.WORLD_EVENT_MAIN_REWARD, 39000);
  assert.equal(cfg.WORLD_EVENT_MAX_TOTAL_REWARD, 93000);

  const originalRandom = Math.random;
  Math.random = () => 0;
  try {
    economy.startWorldEvent(cfg.WORLD_EVENT_CHANNEL_ID, { title: 'Evento de prueba', description: 'Participa.' });
    for (let i = 0; i < 10; i += 1) {
      economy.registerWorldEventParticipant(cfg.WORLD_EVENT_CHANNEL_ID, `world-event-player-${i}`);
    }
    const result = economy.resolveWorldEvent();
    const winner = result.rewards.find((reward) => reward.isWinner);
    const others = result.rewards.filter((reward) => !reward.isWinner);

    assert.equal(winner.id, 'world-event-player-0');
    assert.equal(winner.amount, 39000);
    assert.ok(others.every((reward) => reward.amount < 39000));
    assert.equal(others[0].amount, 6000);
    assert.equal(result.totalReward, 93000);
    assert.ok(result.totalReward <= cfg.WORLD_EVENT_MAX_TOTAL_REWARD);

    economy.startWorldEvent(cfg.WORLD_EVENT_CHANNEL_ID, { title: 'Evento pequeño', description: 'Participa.' });
    economy.registerWorldEventParticipant(cfg.WORLD_EVENT_CHANNEL_ID, 'world-event-solo');
    const soloResult = economy.resolveWorldEvent();
    assert.equal(soloResult.rewards.length, 1);
    assert.equal(soloResult.rewards[0].amount, 39000);
    assert.equal(soloResult.totalReward, 39000);

    economy.startWorldEvent(cfg.WORLD_EVENT_CHANNEL_ID, { title: 'Evento cancelable', description: 'Prueba.' });
    assert.equal(economy.hasWorldEvent(), true);
    assert.equal(economy.cancelWorldEvent(), true);
    assert.equal(economy.hasWorldEvent(), false);
  } finally {
    Math.random = originalRandom;
  }
});

test('the closing daily bonus is not awarded after the exact event cutoff', () => {
  const beforeCutoff = db.getUser('finale-daily-before-cutoff-test');
  const atCutoff = db.getUser('finale-daily-at-cutoff-test');
  assert.equal(economy.doDaily(beforeCutoff, new Date(cfg.EVENT_END.getTime() - 1)).finale, true);
  assert.equal(economy.doDaily(atCutoff, new Date(cfg.EVENT_END)).finale, false);
});

test('all major Components V2 views stay within Discord’s 40-component limit', () => {
  const userId = '123456789012345678';
  const member = { id: userId, displayName: 'Tester', roles: { cache: { has: () => false } } };
  const user = db.getUser('component-limit-test');
  user.eventRolesPurchased = [];
  user.eventRolesActivated = [];
  const potionShop = ui.shopContainer(cfg, userId);
  const eventShop = ui.eventShopContainer(cfg, new Date(cfg.EVENT_START), member, userId, user);
  const views = [
    potionShop,
    eventShop,
    ui.armoryContainer(cfg, user, userId),
    ui.classListContainer(cfg, user, userId),
    ui.inventoryContainer(cfg, member, user),
    ui.potionsInfoContainer(cfg),
    ui.cooldownsContainer(cfg, member, []),
  ];

  for (const view of views) {
    assert.ok(countComponents(view.components) <= 40, `view has ${countComponents(view.components)} components`);
  }
});

test('inventory only shows owned materials and paginates long material lists', () => {
  const userId = '123456789012345678';
  const member = { id: userId, displayName: 'Tester', roles: { cache: { has: () => false } } };
  const user = db.getUser('inventory-material-pagination-test');
  const materials = cfg.MATERIALS.slice(0, 13);
  user.materials = Object.fromEntries(materials.map((material, index) => [material.id, index + 1]));

  const firstPage = JSON.stringify(ui.inventoryContainer(cfg, member, user, userId, 0));
  const secondPage = JSON.stringify(ui.inventoryContainer(cfg, member, user, userId, 1));
  assert.match(firstPage, /Amber Dust/);
  assert.doesNotMatch(firstPage, new RegExp(materials[12].name));
  assert.match(firstPage, /Página 1 de 2/);
  assert.match(secondPage, new RegExp(materials[12].name));
  assert.match(secondPage, /Página 2 de 2/);

  user.materials = {};
  const emptyInventory = JSON.stringify(ui.inventoryContainer(cfg, member, user, userId));
  assert.match(emptyInventory, /No tienes materiales todavía/);
  assert.doesNotMatch(emptyInventory, /×0/);
});

test('event shop and armory catalogs paginate without exceeding Discord component limits', () => {
  const userId = '123456789012345678';
  const member = { id: userId, displayName: 'Tester', roles: { cache: { has: () => false } } };
  const user = db.getUser('catalog-pagination-test');
  const eventPage = ui.eventShopContainer(cfg, new Date(cfg.EVENT_START), member, userId, user, 0);
  const eventPageTwo = ui.eventShopContainer(cfg, new Date(cfg.EVENT_START), member, userId, user, 1);
  const armoryPage = ui.armoryContainer(cfg, user, userId, 0);
  assert.match(JSON.stringify(eventPage), /Página 1 de 3/);
  assert.match(JSON.stringify(eventPageTwo), /Página 2 de 3/);
  assert.match(JSON.stringify(armoryPage), /catalog:page/);
  for (const view of [eventPage, eventPageTwo, armoryPage]) {
    assert.ok(countComponents(view.components) <= 40);
  }
});

test('collect pays only the best activated role and applies its configured cooldown', () => {
  const user = db.getUser('collect-test');
  user.eventRolesPurchased = [
    cfg.EVENT_SHOP.find((role) => role.id === 'starx').roleId,
    cfg.EVENT_SHOP.find((role) => role.id === 'spookyseason').roleId,
  ];
  user.eventRolesActivated = [...user.eventRolesPurchased];

  const originalNow = Date.now;
  let currentTime = cfg.EVENT_START.getTime();
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

test('collect rejects calls outside the event and does not apply a fixed payout cap', () => {
  const user = db.getUser('collect-cap-test');
  user.eventRolesPurchased = [cfg.EVENT_SHOP[0].roleId];
  user.eventRolesActivated = [cfg.EVENT_SHOP[0].roleId];
  const role = cfg.EVENT_SHOP[0];
  const previousReward = role.collectReward;
  role.collectReward = 999999;
  try {
    assert.equal(
      economy.collectEventIncome(user, new Date(cfg.EVENT_START.getTime() - 1)).error,
      'notstarted',
    );

    const now = cfg.EVENT_START.getTime();
    const originalNow = Date.now;
    Date.now = () => now;
    try {
      const result = economy.collectEventIncome(user, new Date(now));
      assert.equal(result.reward, 999999);
    } finally {
      Date.now = originalNow;
    }

    assert.equal(
      economy.collectEventIncome(user, new Date(cfg.EVENT_END)).error,
      'ended',
    );
  } finally {
    role.collectReward = previousReward;
  }
});

test('event-role purchase consumes its recipe; activation charges half the price', () => {
  const user = db.getUser('event-role-purchase-test');
  const role = cfg.EVENT_SHOP.find((item) => item.id === 'spookyseason');
  const activationCost = Math.ceil(role.price / 2);
  user.cash = role.price + activationCost;
  user.materials = {};
  for (const [materialId, quantity] of Object.entries(role.requirements)) {
    user.materials[materialId] = quantity;
  }

  const lacking = db.getUser('event-role-missing-material-test');
  lacking.cash = role.price + activationCost;
  const failed = economy.buyEventRole(new Date(cfg.EVENT_START), lacking, role.id);
  assert.equal(failed.error, 'insufficient_materials');

  const purchased = economy.buyEventRole(new Date(cfg.EVENT_START), user, role.id);
  assert.equal(purchased.role.id, role.id);
  assert.equal(user.cash, activationCost);
  assert.equal(user.eventRolesActivated.includes(role.roleId), false);
  for (const materialId of Object.keys(role.requirements)) {
    assert.equal(user.materials[materialId], undefined);
  }

  const activated = economy.activateEventRole(user, role.id, new Date(cfg.EVENT_START));
  assert.equal(activated.activationCost, activationCost);
  assert.equal(user.cash, 0);
  assert.equal(user.eventRolesActivated.includes(role.roleId), true);
});

test('successful actions award materials and progress one-time quest objectives', () => {
  const user = db.getUser('quest-and-material-test');
  const mission = cfg.QUEST_MISSIONS.find((item) => item.id === 'work_1');
  user.activeQuest = { ...mission, progress: 0, startedAt: Date.now() };
  user.completedQuestIds = [];
  user.cash = 0;
  user.xp = 1000;

  const originalRandom = Math.random;
  const originalNow = Date.now;
  let currentTime = originalNow();
  Math.random = () => 0;
  Date.now = () => currentTime;
  try {
    const activity = economy.recordActivity(user, 'work');
    assert.equal(activity.xp, cfg.XP_PER_ACTION.work + cfg.XP_PER_ACTION.quest);
    assert.equal(user.xp, 1000 + cfg.XP_PER_ACTION.work + cfg.XP_PER_ACTION.quest);
    assert.equal(activity.materials.length, 1);
    assert.equal(user.materials[activity.materials[0].id], 2);
    assert.equal(activity.questProgress.completed, true);
    assert.equal(user.activeQuest, null);
    assert.ok(user.completedQuestIds.includes(mission.id));
    assert.ok(user.cash > 0);

    currentTime += cfg.COOLDOWNS.quest + 1;
    const next = economy.doQuest(user);
    assert.equal(next.started, true);
    assert.notEqual(next.quest.action, mission.action);
  } finally {
    Math.random = originalRandom;
    Date.now = originalNow;
  }
});

test('gameplay activities award their configured XP and dungeon XP requires a clear', () => {
  for (const [action, amount] of Object.entries(cfg.XP_PER_ACTION)) {
    const user = db.getUser(`xp-activity-${action}`);
    const beforeXp = user.xp;
    const activity = economy.recordActivity(user, action);
    assert.equal(activity.xp, amount, `${action} should award its configured XP`);
    assert.equal(user.xp, beforeXp + amount, `${action} should persist its XP`);
  }

  const originalRandom = Math.random;
  try {
    Math.random = () => 0;
    const clearUser = db.getUser('dungeon-xp-clear-test');
    const clear = economy.doDungeon(clearUser);
    assert.equal(clear.success, true);
    assert.equal(clear.activity.xp, 80);
    assert.equal(clearUser.xp, 80);

    Math.random = () => 0.99;
    const failedUser = db.getUser('dungeon-xp-fail-test');
    const failed = economy.doDungeon(failedUser);
    assert.equal(failed.success, false);
    assert.equal(failedUser.xp, 0);
  } finally {
    Math.random = originalRandom;
  }
});

test('class names and IDs are resolved without case sensitivity', () => {
  const user = db.getUser('case-insensitive-class-test');
  user.xp = 1250;
  const byName = economy.setClass(user, 'hOmBrE lObO');
  assert.equal(byName.classDef.id, 'hombrelobo');
  const byId = economy.classDef('HOMBRELOBO');
  assert.equal(byId.name, 'Hombre Lobo');
});

test('casino wagers have no fixed cap but still require safe integer balances', () => {
  const user = db.getUser('large-wager-test');
  user.cash = 2_000_000;
  const originalRandom = Math.random;
  Math.random = () => 0;
  try {
    const result = economy.gamble(user, 1_000_000);
    assert.equal(result.win, true);
    assert.equal(user.cash, 3_000_000);
  } finally {
    Math.random = originalRandom;
  }
});

test('redeem codes require level 10 and persist one redemption per account', async () => {
  const code = 'TEST-ONCE';
  const expiry = new Date(Date.now() + 60 * 60 * 1000);
  assert.deepEqual(await db.createRedeemCode(code, 2500, expiry), { ok: true });

  const lowLevel = db.getUser('redeem-level-test');
  assert.equal((await db.redeemCode('redeem-level-test', lowLevel, code)).error, 'level_required');

  const user = db.getUser('redeem-success-test');
  user.xp = 5000;
  user.cash = 75;
  const redeemed = await db.redeemCode('redeem-success-test', user, code);
  assert.equal(redeemed.reward, 2500);
  assert.equal(user.cash, 2575);
  assert.equal((await db.redeemCode('redeem-success-test', user, code)).error, 'already_redeemed');

  const stored = JSON.parse(fs.readFileSync(process.env.ECONOMY_DATA_FILE, 'utf8'));
  assert.equal(stored.users['redeem-success-test'].cash, 2575);
  assert.ok(stored.redeemRedemptions['TEST-ONCE:redeem-success-test']);

  const expiredCode = 'TEST-EXPIRED';
  const expiredExpiry = new Date(Date.now() + 60 * 1000);
  assert.deepEqual(await db.createRedeemCode(expiredCode, 100, expiredExpiry), { ok: true });
  assert.equal(
    (await db.redeemCode('redeem-success-test', user, expiredCode, new Date(expiredExpiry.getTime() + 1))).error,
    'expired',
  );
});

test('the one-use global reset token resets profiles and preserves redeem codes', async () => {
  const tokenHash = 'a'.repeat(64);
  const expiresAt = new Date(Date.now() + 60 * 1000);
  assert.equal(await db.createResetToken(tokenHash, expiresAt), true);

  const reset = await db.consumeResetTokenAndResetAll(tokenHash);
  assert.equal(reset.ok, true);
  assert.ok(reset.count >= 1);
  assert.equal(db.getUser('redeem-success-test').cash, 0);
  assert.ok((await db.listRedeemCodes()).some((item) => item.normalizedCode === 'TEST-ONCE'));
  assert.equal((await db.consumeResetTokenAndResetAll(tokenHash)).error, 'invalid_token');
});

test('dashboard does not expose its admin page without a session', async () => {
  const request = { method: 'GET', url: '/admin', headers: {}, socket: { remoteAddress: '127.0.0.1' } };
  const response = {
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    writeHead(status) { this.statusCode = status; },
    end(body) { this.body = body; this.writableEnded = true; },
  };
  await dashboard.handleAdminRequest(request, response, { cfg, db, client: {} });
  assert.equal(response.statusCode, 200);
  assert.match(response.body, /type="password"/);
  assert.equal(response.headers['Cache-Control'], 'no-store');
});

test('dashboard can spawn a world event only from an authenticated CSRF-protected admin session', async () => {
  const previousSecret = process.env.DASHBOARD_SECRET;
  const secret = 'dashboard-event-test-secret-1234567890';
  process.env.DASHBOARD_SECRET = secret;
  let spawnCalls = 0;
  const dependencies = {
    cfg,
    db,
    client: {},
    ui,
    getWorldEventStatus: () => false,
    spawnWorldEvent: async () => {
      spawnCalls += 1;
      return { ok: true };
    },
  };

  try {
    const login = await sendDashboardRequest({
      method: 'POST',
      url: '/admin/login',
      body: new URLSearchParams({ secret }).toString(),
    }, dependencies);
    assert.equal(login.statusCode, 303);
    const cookie = login.headers['Set-Cookie'].split(';', 1)[0];

    const panel = await sendDashboardRequest({ method: 'GET', url: '/admin', cookie }, dependencies);
    assert.equal(panel.statusCode, 200);
    assert.match(panel.body, /action="\/admin\/world-event\/spawn"/);
    assert.match(panel.body, /Iniciar evento ahora/);
    const csrf = panel.body.match(/name="csrf" value="([a-f0-9]+)"/)?.[1];
    assert.ok(csrf);

    const unauthorized = await sendDashboardRequest({
      method: 'POST',
      url: '/admin/world-event/spawn',
      body: new URLSearchParams({ csrf }).toString(),
    }, dependencies);
    assert.equal(unauthorized.headers.Location, '/admin');
    assert.equal(spawnCalls, 0);

    const invalidCsrf = await sendDashboardRequest({
      method: 'POST',
      url: '/admin/world-event/spawn',
      cookie,
      body: new URLSearchParams({ csrf: 'invalid' }).toString(),
    }, dependencies);
    assert.equal(invalidCsrf.headers.Location, '/admin?notice=bad_csrf');
    assert.equal(spawnCalls, 0);

    const spawned = await sendDashboardRequest({
      method: 'POST',
      url: '/admin/world-event/spawn',
      cookie,
      body: new URLSearchParams({ csrf }).toString(),
    }, dependencies);
    assert.equal(spawned.headers.Location, '/admin?notice=world_event_started');
    assert.equal(spawnCalls, 1);

    const activeDependencies = {
      ...dependencies,
      getWorldEventStatus: () => true,
      spawnWorldEvent: async () => ({ error: 'already_active' }),
    };
    const activePanel = await sendDashboardRequest({ method: 'GET', url: '/admin', cookie }, activeDependencies);
    assert.match(activePanel.body, /Hay un evento activo o iniciándose/);
    assert.match(activePanel.body, /<button type="submit" disabled>/);
    const alreadyActive = await sendDashboardRequest({
      method: 'POST',
      url: '/admin/world-event/spawn',
      cookie,
      body: new URLSearchParams({ csrf }).toString(),
    }, activeDependencies);
    assert.equal(alreadyActive.headers.Location, '/admin?notice=world_event_active');
  } finally {
    if (previousSecret === undefined) delete process.env.DASHBOARD_SECRET;
    else process.env.DASHBOARD_SECRET = previousSecret;
  }
});

test('work and harvest keep distinct 5-minute and 3-minute intervals; rob waits 10 minutes', () => {
  assert.equal(cfg.COOLDOWN_POLICIES.work.intervalMs, 5 * 60 * 1000);
  assert.equal(cfg.COOLDOWN_POLICIES.harvest.intervalMs, 3 * 60 * 1000);
  assert.equal(cfg.COOLDOWN_POLICIES.rob.intervalMs, 10 * 60 * 1000);
  assert.equal(cfg.COOLDOWN_POLICIES.rob.restMs, 10 * 60 * 1000);
});

test('chat messages no longer earn passive Candys', () => {
  assert.equal(economy.earnFromMessage, undefined);
  assert.equal(cfg.MESSAGE_COOLDOWN_MS, undefined);
  assert.equal(cfg.MESSAGE_REWARD, undefined);
  const indexSource = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.doesNotMatch(indexSource, /economy\.earnFromMessage/);
});

test('global leaderboard prints names literally without Discord mentions or pings', () => {
  const guildMemberId = '123456789012345678';
  const globalUserId = '234567890123456789';
  const view = ui.leaderboardContainer(cfg, 'rich', 0, [
    { id: guildMemberId, displayName: 'Guild Nick', isGuildMember: true, value: 500 },
    { id: globalUserId, displayName: 'Global Name', isGuildMember: false, value: 300 },
    { id: 'legacy-player', value: 250 },
  ], 'viewer');
  const rendered = JSON.stringify(view);
  assert.match(rendered, /@Guild Nick/);
  assert.match(rendered, /@Global Name/);
  assert.match(rendered, /@Jugador sin nombre/);
  assert.doesNotMatch(rendered, /<@!?[0-9]{17,20}>/);
  assert.deepEqual(view.allowedMentions, { parse: [] });
  assert.ok((view.flags & MessageFlags.SuppressNotifications) !== 0);
});

test('leaderboard resolves visible names from cache and storage without REST requests', () => {
  const memberId = '123456789012345678';
  const globalId = '234567890123456789';
  const savedId = '345678901234567890';
  const laterPageId = '456789012345678901';
  let savedNameCalls = 0;
  const entries = [
    { id: memberId, value: 500 },
    { id: globalId, value: 300 },
    { id: savedId, value: 200 },
    { id: laterPageId, value: 100 },
  ];
  const resolved = resolveLeaderboardEntries(entries, {
    guild: { members: { cache: new Map([[memberId, { displayName: 'Guild Nick' }]]), fetch: () => assert.fail('must not fetch guild members') } },
    users: { cache: new Map([[globalId, { globalName: 'Global Name' }]]), fetch: () => assert.fail('must not fetch Discord users') },
    page: 0,
    pageSize: 3,
    getSavedName: (id) => { savedNameCalls += 1; return id === savedId ? 'Saved Name' : ''; },
  });
  assert.equal(resolved[0].displayName, 'Guild Nick');
  assert.equal(resolved[0].isGuildMember, true);
  assert.equal(resolved[1].displayName, 'Global Name');
  assert.equal(resolved[1].isGuildMember, false);
  assert.equal(resolved[2].displayName, 'Saved Name');
  assert.deepEqual(resolved[3], entries[3]);
  assert.equal(savedNameCalls, 3);
});
test('Discord message and interaction IDs are processed at most once per process', async () => {
  const eventId = '1430000000000000000';
  assert.equal(await db.claimDiscordEvent('message', eventId), true);
  assert.equal(await db.claimDiscordEvent('message', eventId), false);
  assert.equal(await db.claimDiscordEvent('interaction', eventId), true);
  assert.equal(await db.claimDiscordEvent('interaction', eventId), false);
});

test('component interactions acknowledge before database and network work', () => {
  const indexSource = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  const listenerStart = indexSource.indexOf("client.on('interactionCreate'");
  const listener = indexSource.slice(listenerStart);
  const acknowledgementBranch = listener.indexOf("const usesPrivateReply = ['shopopen', 'shopbuy', 'shopactivate'].includes(ns);");
  const claimAt = listener.indexOf("await db.claimDiscordEvent('interaction', interaction.id)");
  const memberFetchAt = listener.indexOf('await interaction.guild.members.fetch');
  assert.ok(listenerStart >= 0 && acknowledgementBranch >= 0);
  assert.ok(claimAt > acknowledgementBranch);
  assert.ok(memberFetchAt > claimAt);
  assert.match(listener.slice(acknowledgementBranch, claimAt), /await interaction\.deferReply/);
  assert.match(listener.slice(acknowledgementBranch, claimAt), /await interaction\.deferUpdate/);
  assert.doesNotMatch(listener, /interaction\.update\(/);
});
