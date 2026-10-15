'use strict';

const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const {
  setupEnv, cleanupEnv, countComponents, collectText, toPlain, buttonsOf,
} = require('./_helpers');

const tempDir = setupEnv('eventshop');

const cfg = require('../config');
const db = require('../database');
const economy = require('../economy');
const ui = require('../ui');

before(async () => { await db.loadDB(); });
after(async () => { await db.closeDB(); cleanupEnv(tempDir); });

const DURING = new Date(cfg.EVENT_START.getTime() + 24 * 60 * 60 * 1000);
const role = (id) => cfg.EVENT_SHOP.find((item) => item.id === id);
const member = { id: '1', displayName: 'Ana', roles: { cache: new Map() }, displayAvatarURL: () => 'https://cdn.example/a.png' };

let counter = 0;
function player() {
  counter += 1;
  const user = db.getUser(`95000000000000${String(counter).padStart(4, '0')}`);
  Object.assign(user, {
    cash: 100_000_000, bank: 0, debt: 0, materials: {}, inventory: {}, cooldowns: {}, cooldownCycles: {}, eventRolesPurchased: [], eventRolesActivated: [],
  });
  return user;
}

function own(user, id) {
  const r = role(id);
  for (const [materialId, qty] of Object.entries(r.requirements)) user.materials[materialId] = (user.materials[materialId] || 0) + qty;
  assert.ok(!economy.buyEventRole(DURING, user, id).error);
  assert.ok(!economy.activateEventRole(user, id, DURING).error);
}

function statusMap(user) {
  return Object.fromEntries(economy.getEventRoleStatuses(user).map((item) => [item.role.id, item.status]));
}

function withClock(start, fn) {
  const original = Date.now;
  let now = start;
  Date.now = () => now;
  try { return fn({ advance: (ms) => { now += ms; }, now: () => now }); } finally { Date.now = original; }
}

test('collect pays the best activated role and the lower ones become "Obtenido"', () => {
  const user = player();
  own(user, 'starx');
  assert.deepEqual(statusMap(user).starx, 'active');
  own(user, 'aurainfinite');
  let statuses = statusMap(user);
  assert.equal(statuses.starx, 'obtained', 'the first role goes from Activado to Obtenido');
  assert.equal(statuses.aurainfinite, 'active', 'the second (better) role is the active one');
  assert.equal(economy.bestActivatedRole(user).id, 'aurainfinite');

  // Un rol más barato comprado después NO le quita el puesto al mejor.
  own(user, 'goat');
  statuses = statusMap(user);
  assert.equal(statuses.goat, 'active');
  assert.equal(statuses.aurainfinite, 'obtained');
  own(user, 'king');
  statuses = statusMap(user);
  assert.equal(statuses.king, 'active');
  assert.deepEqual(['starx', 'aurainfinite', 'goat'].map((id) => statuses[id]), ['obtained', 'obtained', 'obtained']);
  assert.equal(statuses.spookyseason, 'available');
});

test('a cheaper role bought after a better one is "Obtenido" and the better one stays "Activado"', () => {
  const user = player();
  own(user, 'king');
  own(user, 'starx');
  const statuses = statusMap(user);
  assert.equal(statuses.king, 'active');
  assert.equal(statuses.starx, 'obtained');
  const collected = withClock(cfg.EVENT_START.getTime() + 1000, () => economy.collectEventIncome(user, new Date(Date.now())));
  assert.equal(collected.role.id, 'king');
  assert.equal(collected.reward, 85000);
  assert.deepEqual(collected.obtained.map((r) => r.id), ['starx']);
});

test('purchased-but-not-activated roles say whether activating them would pay anything', () => {
  const user = player();
  own(user, 'king');
  for (const [id, materials] of [['starx', true], ['arise', true]]) {
    for (const [materialId, qty] of Object.entries(role(id).requirements)) user.materials[materialId] = qty;
    assert.ok(!economy.buyEventRole(DURING, user, id).error, id);
  }
  const items = Object.fromEntries(economy.getEventRoleStatuses(user).map((item) => [item.role.id, item]));
  assert.equal(items.starx.status, 'purchased');
  assert.equal(items.starx.wouldPay, false, 'STAR X cannot beat the active KING');
  assert.equal(items.arise.status, 'purchased');
  assert.equal(items.arise.wouldPay, true, 'ARISE would replace KING');
  assert.equal(items.spookyseason.status, 'available');
});

test('each role keeps its own collect cooldown: upgrading lets you claim the new best role right away', () => {
  const user = player();
  withClock(cfg.EVENT_START.getTime() + 1000, ({ advance }) => {
    own(user, 'starx');
    const first = economy.collectEventIncome(user, new Date(Date.now()));
    assert.equal(first.role.id, 'starx');
    assert.equal(first.reward, 12000);
    assert.equal(economy.collectEventIncome(user, new Date(Date.now())).error, 'cooldown');
    assert.equal(user.cooldowns['collect:starx'] > Date.now(), true);

    own(user, 'goat'); // mejor rol, aún sin cobrar nunca
    const upgrade = economy.collectEventIncome(user, new Date(Date.now()));
    assert.equal(upgrade.role.id, 'goat', 'the new best role pays immediately');
    assert.equal(upgrade.reward, 55000);
    const blocked = economy.collectEventIncome(user, new Date(Date.now()));
    assert.equal(blocked.error, 'cooldown');
    assert.equal(blocked.role.id, 'goat');
    assert.ok(blocked.remaining > 10 * 60 * 60 * 1000 && blocked.remaining <= role('goat').collectCooldownMs);

    advance(role('goat').collectCooldownMs + 1);
    assert.equal(economy.collectEventIncome(user, new Date(Date.now())).reward, 55000);
    assert.equal(user.cash, 100_000_000 - 540000 - 270000 - 150000 - 75000 + 12000 + 55000 + 55000, 'purchases + activations + three payouts');
  });
});

test('a legacy single "collect" cooldown moves to the best role: no free extra payout after the update', () => {
  const user = player();
  withClock(cfg.EVENT_START.getTime() + 1000, ({ advance }) => {
    own(user, 'king');
    user.cooldowns.collect = Date.now() + 5 * 60 * 60 * 1000; // formato de v1.0.0
    const cashBefore = user.cash;
    const blocked = economy.collectEventIncome(user, new Date(Date.now()));
    assert.equal(blocked.error, 'cooldown');
    assert.equal(user.cash, cashBefore);
    assert.equal(user.cooldowns.collect, undefined, 'legacy key migrated away');
    assert.ok(user.cooldowns['collect:king'] > Date.now());
    assert.ok(economy.getCollectRemaining(user) > 4.9 * 60 * 60 * 1000);
    advance(5 * 60 * 60 * 1000 + 1);
    assert.equal(economy.collectEventIncome(user, new Date(Date.now())).reward, 85000);
  });
});

test('collect still refuses outside the event window, without roles and with a full balance', () => {
  const user = player();
  assert.equal(economy.collectEventIncome(user, new Date(cfg.EVENT_START.getTime() - 1)).error, 'notstarted');
  assert.equal(economy.collectEventIncome(user, new Date(cfg.EVENT_END)).error, 'ended');
  assert.equal(economy.collectEventIncome(user, DURING).error, 'no_eligible_role');
  own(user, 'starx');
  user.cash = Number.MAX_SAFE_INTEGER - 5;
  const result = withClock(cfg.EVENT_START.getTime() + 1000, () => economy.collectEventIncome(user, new Date(Date.now())));
  assert.equal(result.error, 'balance_limit');
  assert.equal(user.cash, Number.MAX_SAFE_INTEGER - 5);
  assert.equal(user.cooldowns['collect:starx'], undefined, 'a refused claim does not start the cooldown');
});

test('lower roles got a shorter cooldown while no role out-earns the top role per hour', () => {
  const hours = (ms) => ms / (60 * 60 * 1000);
  assert.equal(hours(role('starx').collectCooldownMs), 3);
  assert.equal(hours(role('aurainfinite').collectCooldownMs), 6);
  assert.equal(hours(role('goat').collectCooldownMs), 11);
  assert.equal(hours(role('king').collectCooldownMs), 17);
  // Sin cambios en el resto.
  assert.equal(hours(role('arise').collectCooldownMs), 24);
  assert.equal(hours(role('9k').collectCooldownMs), 36);
  assert.equal(hours(role('3k').collectCooldownMs), 48);
  assert.equal(hours(role('og').collectCooldownMs), 60);
  assert.equal(hours(role('spookyseason').collectCooldownMs), 72);
  const rate = (r) => r.collectReward / hours(r.collectCooldownMs);
  const top = Math.max(...cfg.EVENT_SHOP.map(rate));
  assert.equal(Math.round(rate(role('spookyseason'))), 5125);
  for (const r of cfg.EVENT_SHOP) {
    assert.ok(rate(r) <= top + 1e-9, `${r.id} never beats the best hourly rate`);
    assert.ok(rate(r) >= 4000, `${r.id} pays at least 4,000/h of cooldown`);
  }
});

test('the event shop labels the active role "Activado" and the superseded one "Obtenido"', () => {
  const user = player();
  own(user, 'starx');
  own(user, 'aurainfinite');
  const view = ui.eventShopContainer(cfg, DURING, member, 'invoker', user, 2); // página 3: GOAT, AURA INFINITE, STAR X
  const plain = toPlain(view);
  assert.ok(countComponents(plain) <= 40);
  const text = collectText(view);
  const labels = buttonsOf(view).map((b) => b.label);
  // La página de la tienda con STAR X, AURA INFINITE: ordenadas de la más cara a la más barata.
  assert.deepEqual(labels.filter((label) => ['Comprar', 'Activar', 'Activado', 'Obtenido'].includes(label)), ['Comprar', 'Activado', 'Obtenido']);
  assert.match(text, /Obtenido\*\* — ya no paga ingresos/);
  assert.match(text, /Activado\*\* — este rol es el que paga/);
  const done = buttonsOf(view).filter((b) => b.label === 'Activado' || b.label === 'Obtenido');
  assert.ok(done.every((b) => b.disabled === true), 'finished roles cannot be clicked');
  assert.equal(buttonsOf(view).filter((b) => b.label === 'Activado').length, 1, 'exactly one role is "Activado"');
});
