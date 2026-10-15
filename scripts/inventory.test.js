'use strict';

const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const {
  setupEnv, cleanupEnv, countComponents, collectText, toPlain,
} = require('./_helpers');

const tempDir = setupEnv('inventory');

const cfg = require('../config');
const db = require('../database');
const economy = require('../economy');
const ui = require('../ui');

before(async () => { await db.loadDB(); });
after(async () => { await db.closeDB(); cleanupEnv(tempDir); });

const member = (id = '1', displayName = 'Ana') => ({ id, displayName, displayAvatarURL: () => 'https://cdn.example/a.png' });
const DURING_EVENT = new Date(cfg.EVENT_START.getTime() + 24 * 60 * 60 * 1000);
const AFTER_EVENT = new Date(cfg.EVENT_END.getTime() + 60 * 1000);
const starx = cfg.EVENT_SHOP.find((role) => role.id === 'starx');
const goat = cfg.EVENT_SHOP.find((role) => role.id === 'goat');

function richBuyer(id) {
  const user = db.getUser(id);
  user.cash = 50_000_000; user.bank = 0; user.debt = 0; user.inventory = {}; user.materials = {};
  user.eventRolesPurchased = []; user.eventRolesActivated = [];
  return user;
}

function giveMaterials(user, role) {
  for (const [id, qty] of Object.entries(role.requirements)) user.materials[id] = qty;
}

function inventoryText(user, id = '1') {
  const view = ui.inventoryContainer(cfg, member(id), user, id, 0);
  const plain = toPlain(view);
  assert.ok(countComponents(plain) <= 40, `${countComponents(plain)} components`);
  assert.equal(plain.flags & 32768, 32768);
  assert.deepEqual(plain.allowedMentions, { parse: [] });
  return collectText(view);
}

test('a purchased but not yet activated event item shows up next to the potions, clearly marked as pending', () => {
  const user = richBuyer('900000000000000001');
  giveMaterials(user, starx);
  user.inventory = { luck: 2 };
  const bought = economy.buyEventRole(DURING_EVENT, user, 'starx');
  assert.ok(!bought.error, bought.error);
  assert.deepEqual(user.eventRolesPurchased, [starx.roleId]);
  assert.deepEqual(user.eventRolesActivated, []);

  const text = inventoryText(user);
  const potionsAt = text.indexOf('Poción');
  const pendingAt = text.indexOf('Pendientes de activar');
  assert.ok(potionsAt >= 0 && pendingAt > potionsAt, 'the pending block comes right after the potions');
  assert.ok(text.includes(starx.name));
  assert.match(text, /pendiente de activar/);
  assert.ok(text.includes(db.fmt(Math.ceil(starx.price / 2))), 'shows the activation cost');
  // La sección de pociones y materiales sigue ahí.
  assert.match(text, /Materiales/);
});

test('the pending item appears even when there are no potions', () => {
  const user = richBuyer('900000000000000002');
  giveMaterials(user, goat);
  assert.ok(!economy.buyEventRole(DURING_EVENT, user, 'goat').error);
  const text = inventoryText(user);
  assert.match(text, /No tienes pociones guardadas/);
  assert.ok(text.includes(goat.name));
  assert.match(text, /pendiente de activar/);
});

test('an item that was never purchased is never shown as owned or pending', () => {
  const user = richBuyer('900000000000000003');
  user.inventory = { luck: 1 };
  let text = inventoryText(user);
  assert.ok(!/Pendientes de activar/.test(text));
  for (const role of cfg.EVENT_SHOP) assert.ok(!text.includes(`**${role.name}**`), `${role.name} must not appear`);

  // Tener el rol por otra vía (o datos sueltos) no cuenta: solo lo comprado (eventRolesPurchased) se muestra.
  user.eventRolesActivated = [starx.roleId, goat.roleId];
  text = inventoryText(user);
  assert.ok(!/Pendientes de activar/.test(text));
  assert.ok(!text.includes(`**${starx.name}**`));
  assert.deepEqual(economy.getPendingEventItems(user, DURING_EVENT), []);
});

test('activating the item removes it from the pending list', () => {
  const user = richBuyer('900000000000000004');
  giveMaterials(user, starx);
  assert.ok(!economy.buyEventRole(DURING_EVENT, user, 'starx').error);
  assert.equal(economy.getPendingEventItems(user, DURING_EVENT).length, 1);
  const activated = economy.activateEventRole(user, 'starx', DURING_EVENT);
  assert.ok(!activated.error, activated.error);
  assert.deepEqual(economy.getPendingEventItems(user, DURING_EVENT), []);
  assert.ok(!/Pendientes de activar/.test(inventoryText(user)));
});

test('only the roles actually bought are listed, in shop order, with their own activation cost', () => {
  const user = richBuyer('900000000000000005');
  giveMaterials(user, starx);
  giveMaterials(user, goat);
  assert.ok(!economy.buyEventRole(DURING_EVENT, user, 'goat').error);
  assert.ok(!economy.buyEventRole(DURING_EVENT, user, 'starx').error);
  const pending = economy.getPendingEventItems(user, DURING_EVENT);
  assert.deepEqual(pending.map((item) => item.id).sort(), ['goat', 'starx']);
  const byId = Object.fromEntries(pending.map((item) => [item.id, item]));
  assert.equal(byId.goat.activationCost, Math.ceil(goat.price / 2));
  assert.equal(byId.starx.activationCost, Math.ceil(starx.price / 2));
  assert.ok(pending.every((item) => item.eventActive && !item.eventEnded));
  const text = inventoryText(user);
  assert.ok(text.includes(goat.name) && text.includes(starx.name));
  assert.ok(!text.includes('**KING**'));
});

test('after the event ends the pending item says it can no longer be activated', () => {
  const user = richBuyer('900000000000000006');
  giveMaterials(user, starx);
  assert.ok(!economy.buyEventRole(DURING_EVENT, user, 'starx').error);
  const pending = economy.getPendingEventItems(user, AFTER_EVENT);
  assert.equal(pending[0].eventEnded, true);
  assert.equal(pending[0].eventActive, false);
  const originalDate = global.Date;
  // La vista usa la fecha actual: se verifica el texto con un reloj posterior al fin del evento.
  const FakeDate = class extends originalDate {
    constructor(...args) { super(...(args.length ? args : [AFTER_EVENT.getTime()])); }
  };
  global.Date = FakeDate;
  try {
    const text = inventoryText(user);
    assert.match(text, /el evento terminó/);
  } finally { global.Date = originalDate; }
});

test('legacy profiles without activation data do not show phantom pending items', () => {
  const user = richBuyer('900000000000000007');
  user.eventRolesPurchased = [starx.roleId];
  delete user.eventRolesActivated;
  const reloaded = db.getUser('900000000000000007');
  assert.deepEqual(reloaded.eventRolesActivated, [starx.roleId], 'legacy purchases count as already activated');
  assert.deepEqual(economy.getPendingEventItems(reloaded, DURING_EVENT), []);
});

test('unknown purchased ids and corrupt arrays are ignored safely', () => {
  const user = richBuyer('900000000000000008');
  user.eventRolesPurchased = ['role-que-no-existe', starx.roleId];
  user.eventRolesActivated = [starx.roleId];
  assert.deepEqual(economy.getPendingEventItems(user, DURING_EVENT), []);
  user.eventRolesPurchased = 'corrupto';
  user.eventRolesActivated = null;
  assert.deepEqual(economy.getPendingEventItems(user, DURING_EVENT), []);
});

test('the inventory view of another player shows that player\'s pending items, not the viewer\'s', () => {
  const owner = richBuyer('900000000000000009');
  const viewer = richBuyer('900000000000000010');
  giveMaterials(owner, starx);
  assert.ok(!economy.buyEventRole(DURING_EVENT, owner, 'starx').error);
  const viewerView = ui.inventoryContainer(cfg, member('900000000000000009', 'Dueño del inventario'), owner, viewer && '900000000000000010', 0);
  assert.ok(collectText(viewerView).includes(starx.name));
  const otherText = collectText(ui.inventoryContainer(cfg, member('900000000000000010', 'Otra'), viewer, '900000000000000010', 0));
  assert.ok(!otherText.includes(starx.name));
});
