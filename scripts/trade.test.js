'use strict';

const assert = require('node:assert/strict');
const { after, before, beforeEach, test } = require('node:test');
const { setupEnv, cleanupEnv, seeded } = require('./_helpers');

const tempDir = setupEnv('trade');

const cfg = require('../config');
const db = require('../database');
const trade = require('../trade');

before(async () => { await db.loadDB(); });
after(async () => { await db.closeDB(); cleanupEnv(tempDir); });
beforeEach(() => { trade.reset(); });

const SELLER = '100000000000000001';
const BUYER = '100000000000000002';
const THIRD = '100000000000000003';

function actor(id, { cash = 0, materials = {}, inventory = {}, weapons = [] } = {}) {
  const user = db.getUser(id);
  user.cash = cash;
  user.bank = 0;
  user.debt = 0;
  user.materials = { ...materials };
  user.inventory = { ...inventory };
  user.weapons = [...weapons];
  user.equippedWeapon = null;
  return user;
}

function offerBase(overrides = {}) {
  return {
    sellerId: SELLER,
    seller: db.getUser(SELLER),
    recipientId: BUYER,
    recipient: db.getUser(BUYER),
    itemQuery: 'amber_dust',
    qtyToken: '5',
    priceToken: '8000',
    sellerName: 'Vendedora',
    recipientName: 'Comprador',
    ...overrides,
  };
}

// Suma de todo lo que existe en los perfiles de prueba: debe conservarse en cualquier secuencia.
function totals(ids) {
  const out = { cash: 0, items: {} };
  for (const id of ids) {
    const user = db.getUser(id);
    out.cash += user.cash;
    for (const [key, qty] of Object.entries(user.materials)) out.items[`m:${key}`] = (out.items[`m:${key}`] || 0) + qty;
    for (const [key, qty] of Object.entries(user.inventory)) out.items[`p:${key}`] = (out.items[`p:${key}`] || 0) + qty;
    for (const key of user.weapons) out.items[`w:${key}`] = (out.items[`w:${key}`] || 0) + 1;
  }
  return out;
}

// ---------- Catálogo y valores base ----------

test('every transferable item has a positive integer base value and a unique lookup key', () => {
  const entries = trade.catalog();
  assert.equal(entries.length, cfg.POTIONS.length + cfg.MATERIALS.length + cfg.WEAPONS.length);
  const keys = new Map();
  for (const entry of entries) {
    assert.ok(Number.isSafeInteger(entry.baseValue) && entry.baseValue > 0, `${entry.kind}:${entry.id} needs a base value`);
    for (const key of new Set([trade.normalizeKey(entry.id), trade.normalizeKey(entry.name)])) {
      assert.ok(!keys.has(key) || keys.get(key) === entry, `lookup key ${key} is ambiguous`);
      keys.set(key, entry);
    }
    assert.equal(trade.resolveItem(entry.id).item, entry);
    assert.equal(trade.resolveItem(entry.name).item, entry);
  }
});

test('material base values follow the documented rule: 400 x 2^tier by the priciest event recipe that uses them', () => {
  const tierByRole = {
    starx: 1, aurainfinite: 2, goat: 2, king: 3, arise: 3, '9k': 4, '3k': 4, og: 5, spookyseason: 5,
  };
  assert.deepEqual(Object.keys(tierByRole).sort(), cfg.EVENT_SHOP.map((role) => role.id).sort());
  // Los niveles respetan el orden de precio de los roles.
  const byPrice = [...cfg.EVENT_SHOP].sort((a, b) => a.price - b.price);
  for (let i = 1; i < byPrice.length; i += 1) assert.ok(tierByRole[byPrice[i].id] >= tierByRole[byPrice[i - 1].id]);

  const tierOfMaterial = {};
  for (const role of cfg.EVENT_SHOP) {
    for (const id of Object.keys(role.requirements)) tierOfMaterial[id] = Math.max(tierOfMaterial[id] || 0, tierByRole[role.id]);
  }
  assert.equal(cfg.MATERIAL_BASE_UNIT, 400);
  for (const material of cfg.MATERIALS) {
    const expected = cfg.MATERIAL_BASE_UNIT * 2 ** (tierOfMaterial[material.id] || 0);
    assert.equal(cfg.MATERIAL_BASE_VALUES[material.id], expected, `${material.id} base value`);
  }
  assert.equal(Object.keys(cfg.MATERIAL_BASE_VALUES).length, cfg.MATERIALS.length);
  // Sin receta = valor más bajo; las piezas de las recetas más caras = valor más alto.
  assert.equal(Math.min(...Object.values(cfg.MATERIAL_BASE_VALUES)), 400);
  assert.equal(Math.max(...Object.values(cfg.MATERIAL_BASE_VALUES)), 12800);
  assert.equal(cfg.MATERIAL_BASE_VALUES.soul_crystal, 12800); // aparece en SPOOKY SEASON y 3K: cuenta el más alto
});

test('potions and weapons use their shop price as base value', () => {
  for (const potion of cfg.POTIONS) assert.equal(trade.getBaseValue('potion', potion.id), potion.price);
  for (const weapon of cfg.WEAPONS) assert.equal(trade.getBaseValue('weapon', weapon.id), weapon.price);
  assert.equal(trade.getBaseValue('material', 'amber_dust'), cfg.MATERIAL_BASE_VALUES.amber_dust);
  assert.equal(trade.getBaseValue('material', 'nope'), null);
});

test('the minimum price is at least half of the total base value (rounded up)', () => {
  assert.equal(trade.minPriceFor({ baseValue: 1600 }, 5), 4000);
  assert.equal(trade.minPriceFor({ baseValue: 45000 }, 1), 22500);
  assert.equal(trade.minPriceFor({ baseValue: 401 }, 1), 201);
  assert.equal(trade.minPriceFor({ baseValue: 401 }, 3), 602);
});

// ---------- Sintaxis ----------

test('give syntax: <item> [quantity|all] <total price>, with multi-word names', () => {
  assert.deepEqual(trade.parseGiveArgs(['amber_dust', '5', '8000']), { itemQuery: 'amber_dust', qtyToken: '5', priceToken: '8000' });
  assert.deepEqual(trade.parseGiveArgs(['luck', '30000']), { itemQuery: 'luck', qtyToken: null, priceToken: '30000' });
  assert.deepEqual(trade.parseGiveArgs(['Amber', 'Dust', '5', '8k']), { itemQuery: 'Amber Dust', qtyToken: '5', priceToken: '8k' });
  assert.deepEqual(trade.parseGiveArgs(['Amber', 'Dust', 'all', '8k']), { itemQuery: 'Amber Dust', qtyToken: 'all', priceToken: '8k' });
  assert.deepEqual(trade.parseGiveArgs(['rama', '5000']), { itemQuery: 'rama', qtyToken: null, priceToken: '5000' });
  assert.deepEqual(trade.parseGiveArgs(['luck']), { error: 'usage' });
  assert.deepEqual(trade.parseGiveArgs([]), { error: 'usage' });
  // Un número como "artículo" se parsea, pero luego se rechaza como artículo inexistente.
  assert.deepEqual(trade.parseGiveArgs(['5', '3000']), { itemQuery: '5', qtyToken: null, priceToken: '3000' });
  assert.equal(trade.resolveItem('5').error, 'item_not_found');
});

test('item lookup ignores case, accents, spaces and underscores; event roles are explicitly not transferable', () => {
  assert.equal(trade.resolveItem('AMBER dust').item.id, 'amber_dust');
  assert.equal(trade.resolveItem('amberdust').item.id, 'amber_dust');
  assert.equal(trade.resolveItem('LUCK').item.id, 'luck');
  assert.equal(trade.resolveItem('Rama Afilada').item.id, 'rama');
  assert.deepEqual(trade.resolveItem('king'), { error: 'not_transferable' });
  assert.deepEqual(trade.resolveItem('Spooky Season'), { error: 'not_transferable' });
  assert.deepEqual(trade.resolveItem('algo-que-no-existe'), { error: 'item_not_found' });
  assert.deepEqual(trade.resolveItem(''), { error: 'item_not_found' });
});

// ---------- Validaciones al crear la oferta ----------

test('createOffer rejects invalid parties, items, quantities, prices and stock without touching anything', () => {
  actor(SELLER, { materials: { amber_dust: 5 }, inventory: { luck: 1 }, weapons: ['rama'] });
  actor(BUYER, { cash: 100000 });
  const before = totals([SELLER, BUYER]);
  const cases = [
    [{ recipientId: SELLER, recipient: db.getUser(SELLER) }, 'self'],
    [{ recipientIsBot: true }, 'bot'],
    [{ sellerId: '', }, 'invalid_party'],
    [{ itemQuery: 'inexistente' }, 'item_not_found'],
    [{ itemQuery: 'king' }, 'not_transferable'],
    [{ qtyToken: '0' }, 'invalid_quantity'],
    [{ qtyToken: '-3' }, 'invalid_quantity'],
    [{ qtyToken: '1.5' }, 'invalid_quantity'],
    [{ qtyToken: 'abc' }, 'invalid_quantity'],
    [{ qtyToken: String(cfg.TRADE_MAX_QUANTITY + 1) }, 'invalid_quantity'],
    [{ qtyToken: '6' }, 'seller_insufficient'],
    [{ itemQuery: 'witch_herb' }, 'seller_insufficient'],
    [{ priceToken: '0' }, 'invalid_price'],
    [{ priceToken: 'all' }, 'invalid_price'],
    [{ priceToken: 'abc' }, 'invalid_price'],
    [{ priceToken: '3999' }, 'price_too_low'],
    [{ priceToken: String(cfg.TRADE_MAX_PRICE + 1) }, 'price_too_high'],
    [{ itemQuery: 'rama', qtyToken: '2', priceToken: '9000' }, 'invalid_quantity'],
  ];
  for (const [overrides, expected] of cases) {
    const result = trade.createOffer(offerBase(overrides));
    assert.equal(result.error, expected, `expected ${expected} for ${JSON.stringify(overrides)}`);
  }
  assert.deepEqual(totals([SELLER, BUYER]), before);
  assert.equal(trade.pendingCount(SELLER, 'out'), 0);
});

test('the price floor is exactly half of the base value: min is accepted, min-1 is rejected', () => {
  actor(SELLER, { materials: { amber_dust: 5 }, inventory: { luck: 2 } });
  actor(BUYER, { cash: 1_000_000 });
  const amberBase = cfg.MATERIAL_BASE_VALUES.amber_dust;
  const min = Math.ceil(amberBase * 5 * 0.5);
  assert.equal(trade.createOffer(offerBase({ priceToken: String(min - 1) })).error, 'price_too_low');
  const ok = trade.createOffer(offerBase({ priceToken: String(min) }));
  assert.ok(ok.offer, 'the exact minimum must be accepted');
  assert.equal(ok.offer.minPrice, min);
  trade.respond(ok.offer.id, SELLER, 'cancel');
  const potionMin = cfg.POTIONS.find((p) => p.id === 'luck').price / 2;
  assert.equal(trade.createOffer(offerBase({ itemQuery: 'luck', qtyToken: null, priceToken: String(potionMin - 1) })).error, 'price_too_low');
  assert.ok(trade.createOffer(offerBase({ itemQuery: 'luck', qtyToken: null, priceToken: String(potionMin) })).offer);
});

test('"all" sells the whole stack and the recipient must be able to afford the offer', () => {
  actor(SELLER, { materials: { amber_dust: 7 } });
  actor(BUYER, { cash: 5000 });
  assert.equal(trade.createOffer(offerBase({ qtyToken: 'all', priceToken: '9000' })).error, 'recipient_insufficient');
  db.getUser(BUYER).cash = 9000;
  const created = trade.createOffer(offerBase({ qtyToken: 'all', priceToken: '9000' }));
  assert.equal(created.offer.quantity, 7);
});

test('weapons: quantity is always 1, the recipient cannot already own it, and the seller must own it', () => {
  actor(SELLER, { weapons: ['rama'] });
  actor(BUYER, { cash: 100000, weapons: ['rama'] });
  const weapon = { itemQuery: 'rama', qtyToken: null, priceToken: '4000' };
  assert.equal(trade.createOffer(offerBase(weapon)).error, 'recipient_has_weapon');
  db.getUser(BUYER).weapons = [];
  assert.equal(trade.createOffer(offerBase({ ...weapon, itemQuery: 'daga', priceToken: '12500' })).error, 'seller_insufficient');
  assert.ok(trade.createOffer(offerBase(weapon)).offer);
});

test('limits: one pending offer per seller and at most 3 incoming per recipient', () => {
  actor(SELLER, { materials: { amber_dust: 50 } });
  actor(BUYER, { cash: 1_000_000 });
  const first = trade.createOffer(offerBase({ qtyToken: '1', priceToken: '800' }));
  assert.ok(first.offer);
  assert.equal(trade.createOffer(offerBase({ qtyToken: '1', priceToken: '800' })).error, 'seller_busy');
  // Tras cancelar el vendedor puede volver a ofrecer.
  trade.respond(first.offer.id, SELLER, 'cancel');
  assert.ok(trade.createOffer(offerBase({ qtyToken: '1', priceToken: '800' })).offer);

  trade.reset();
  const sellers = ['200000000000000001', '200000000000000002', '200000000000000003', '200000000000000004'];
  for (const id of sellers) actor(id, { materials: { amber_dust: 2 } });
  const created = sellers.map((id) => trade.createOffer(offerBase({
    sellerId: id, seller: db.getUser(id), qtyToken: '1', priceToken: '800',
  })));
  assert.equal(created.filter((r) => r.offer).length, cfg.TRADE_MAX_PENDING_IN);
  assert.equal(created.filter((r) => r.error === 'recipient_busy').length, 1);
});

// ---------- Transiciones y conservación ----------

test('accept moves items and Candys exactly once and conserves totals', () => {
  actor(SELLER, { cash: 1000, materials: { amber_dust: 8 } });
  actor(BUYER, { cash: 20000 });
  const before = totals([SELLER, BUYER]);
  const { offer } = trade.createOffer(offerBase({ qtyToken: '5', priceToken: '8000' }));
  assert.deepEqual(totals([SELLER, BUYER]), before, 'creating an offer must not move anything (no escrow)');

  const done = trade.respond(offer.id, BUYER, 'accept');
  assert.equal(done.ok, true);
  assert.equal(done.status, 'accepted');
  assert.equal(db.getUser(SELLER).cash, 9000);
  assert.equal(db.getUser(BUYER).cash, 12000);
  assert.equal(db.getUser(SELLER).materials.amber_dust, 3);
  assert.equal(db.getUser(BUYER).materials.amber_dust, 5);
  assert.deepEqual(totals([SELLER, BUYER]), before);
  assert.equal(trade.pendingCount(SELLER, 'out'), 0);
  assert.equal(trade.pendingCount(BUYER, 'in'), 0);
});

test('accept works for potions and removes depleted stacks', () => {
  actor(SELLER, { inventory: { luck: 1 } });
  actor(BUYER, { cash: 50000, inventory: { luck: 2 } });
  const before = totals([SELLER, BUYER]);
  const { offer } = trade.createOffer(offerBase({ itemQuery: 'luck', qtyToken: null, priceToken: '30000' }));
  assert.equal(trade.respond(offer.id, BUYER, 'accept').status, 'accepted');
  assert.equal(db.getUser(SELLER).inventory.luck, undefined);
  assert.equal(db.getUser(BUYER).inventory.luck, 3);
  assert.deepEqual(totals([SELLER, BUYER]), before);
});

test('accept transfers weapons and unequips the seller (never an equipped weapon they do not own)', () => {
  actor(SELLER, { weapons: ['rama', 'daga'] });
  db.getUser(SELLER).equippedWeapon = 'rama';
  actor(BUYER, { cash: 10000 });
  const before = totals([SELLER, BUYER]);
  const { offer } = trade.createOffer(offerBase({ itemQuery: 'rama', qtyToken: null, priceToken: '4000' }));
  assert.equal(trade.respond(offer.id, BUYER, 'accept').status, 'accepted');
  assert.deepEqual(db.getUser(SELLER).weapons, ['daga']);
  assert.equal(db.getUser(SELLER).equippedWeapon, null);
  assert.deepEqual(db.getUser(BUYER).weapons, ['rama']);
  assert.deepEqual(totals([SELLER, BUYER]), before);
});

test('double accept, accept after decline/cancel and decline after accept never repeat or reverse effects', () => {
  actor(SELLER, { materials: { amber_dust: 5 } });
  actor(BUYER, { cash: 20000 });
  const { offer } = trade.createOffer(offerBase());
  assert.equal(trade.respond(offer.id, BUYER, 'accept').status, 'accepted');
  const snapshot = totals([SELLER, BUYER]);
  for (const action of ['accept', 'accept', 'decline']) {
    const again = trade.respond(offer.id, BUYER, action);
    assert.equal(again.error, 'already_resolved');
    assert.equal(again.status, 'accepted');
  }
  assert.equal(trade.respond(offer.id, SELLER, 'cancel').error, 'already_resolved');
  assert.deepEqual(totals([SELLER, BUYER]), snapshot);

  for (const first of ['decline', 'cancel']) {
    trade.reset();
    actor(SELLER, { materials: { amber_dust: 5 } });
    actor(BUYER, { cash: 20000 });
    const created = trade.createOffer(offerBase()).offer;
    const closed = trade.respond(created.id, first === 'cancel' ? SELLER : BUYER, first);
    assert.equal(closed.status, first === 'cancel' ? 'cancelled' : 'declined');
    const before = totals([SELLER, BUYER]);
    assert.equal(trade.respond(created.id, BUYER, 'accept').error, 'already_resolved');
    assert.deepEqual(totals([SELLER, BUYER]), before);
  }
});

test('only the recipient can accept/decline and only the seller can cancel; wrong actors change nothing', () => {
  actor(SELLER, { materials: { amber_dust: 5 } });
  actor(BUYER, { cash: 20000 });
  const { offer } = trade.createOffer(offerBase());
  const before = totals([SELLER, BUYER]);
  assert.equal(trade.respond(offer.id, THIRD, 'accept').error, 'not_recipient');
  assert.equal(trade.respond(offer.id, SELLER, 'accept').error, 'not_recipient');
  assert.equal(trade.respond(offer.id, SELLER, 'decline').error, 'not_recipient');
  assert.equal(trade.respond(offer.id, BUYER, 'cancel').error, 'not_seller');
  assert.equal(trade.respond(offer.id, THIRD, 'cancel').error, 'not_seller');
  assert.equal(trade.respond(offer.id, BUYER, 'nope').error, 'invalid_action');
  assert.equal(trade.respond('no-existe', BUYER, 'accept').error, 'not_found');
  assert.equal(trade.getOffer(offer.id).status, 'pending');
  assert.deepEqual(totals([SELLER, BUYER]), before);
});

test('expiry: the timer path and a late click both close the offer and nothing moves', () => {
  actor(SELLER, { materials: { amber_dust: 5 } });
  actor(BUYER, { cash: 20000 });
  const t0 = 1_800_000_000_000;
  const { offer } = trade.createOffer(offerBase({ now: t0 }));
  assert.equal(offer.expiresAt, t0 + cfg.TRADE_OFFER_TTL_MS);
  const before = totals([SELLER, BUYER]);

  assert.equal(trade.expireOffer(offer.id, t0 + 1000).expired, false, 'too early to expire');
  assert.equal(trade.getOffer(offer.id).status, 'pending');

  // Clic tardío sin que el temporizador haya corrido: se cierra como expirada y no se acepta.
  const late = trade.respond(offer.id, BUYER, 'accept', t0 + cfg.TRADE_OFFER_TTL_MS + 1);
  assert.equal(late.error, 'already_resolved');
  assert.equal(late.status, 'expired');
  assert.deepEqual(totals([SELLER, BUYER]), before);
  assert.equal(trade.expireOffer(offer.id, t0 + cfg.TRADE_OFFER_TTL_MS + 2).expired, false, 'already closed');

  // Camino del temporizador.
  const second = trade.createOffer(offerBase({ now: t0 })).offer;
  const timer = trade.expireOffer(second.id, t0 + cfg.TRADE_OFFER_TTL_MS);
  assert.equal(timer.expired, true);
  assert.equal(trade.respond(second.id, BUYER, 'accept', t0 + cfg.TRADE_OFFER_TTL_MS + 5).status, 'expired');
  assert.deepEqual(totals([SELLER, BUYER]), before);
  // El vendedor queda libre para ofrecer otra vez.
  assert.ok(trade.createOffer(offerBase({ now: t0 + cfg.TRADE_OFFER_TTL_MS + 10 })).offer);
});

test('accept right at the expiry boundary is rejected, one millisecond earlier it succeeds', () => {
  actor(SELLER, { materials: { amber_dust: 5 } });
  actor(BUYER, { cash: 20000 });
  const t0 = 1_800_000_000_000;
  const { offer } = trade.createOffer(offerBase({ now: t0 }));
  assert.equal(trade.respond(offer.id, BUYER, 'accept', t0 + cfg.TRADE_OFFER_TTL_MS - 1).status, 'accepted');
  actor(SELLER, { materials: { amber_dust: 5 } });
  actor(BUYER, { cash: 20000 });
  const other = trade.createOffer(offerBase({ now: t0 })).offer;
  assert.equal(trade.respond(other.id, BUYER, 'accept', t0 + cfg.TRADE_OFFER_TTL_MS).status, 'expired');
});

test('the seller spending the items after the offer makes acceptance fail terminally with no movement', () => {
  actor(SELLER, { cash: 777, materials: { amber_dust: 5 } });
  actor(BUYER, { cash: 20000 });
  const { offer } = trade.createOffer(offerBase());
  db.removeMaterial(db.getUser(SELLER), 'amber_dust', 2); // el vendedor gasta/vende parte
  const before = totals([SELLER, BUYER]);
  const failed = trade.respond(offer.id, BUYER, 'accept');
  assert.equal(failed.error, 'seller_insufficient');
  assert.equal(failed.terminal, true);
  assert.equal(trade.getOffer(offer.id).status, 'failed');
  assert.deepEqual(totals([SELLER, BUYER]), before);
  assert.equal(trade.respond(offer.id, BUYER, 'accept').error, 'already_resolved');
});

test('the buyer lacking Cash at accept time keeps the offer pending and can retry after withdrawing', () => {
  actor(SELLER, { materials: { amber_dust: 5 } });
  actor(BUYER, { cash: 9000 });
  const { offer } = trade.createOffer(offerBase({ priceToken: '8000' }));
  db.getUser(BUYER).cash = 100; // gastó su Cash después de recibir la oferta
  const before = totals([SELLER, BUYER]);
  const short = trade.respond(offer.id, BUYER, 'accept');
  assert.equal(short.error, 'buyer_insufficient');
  assert.equal(short.need, 8000);
  assert.equal(short.have, 100);
  assert.notEqual(short.terminal, true);
  assert.equal(trade.getOffer(offer.id).status, 'pending');
  assert.deepEqual(totals([SELLER, BUYER]), before);
  db.getUser(BUYER).cash = 8000;
  assert.equal(trade.respond(offer.id, BUYER, 'accept').status, 'accepted');
});

test('the seller already holding too much Cash fails safely instead of overflowing', () => {
  actor(SELLER, { cash: Number.MAX_SAFE_INTEGER - 10, materials: { amber_dust: 5 } });
  actor(BUYER, { cash: 20000 });
  assert.equal(trade.createOffer(offerBase()).error, 'balance_limit');
  db.getUser(SELLER).cash = 0;
  const { offer } = trade.createOffer(offerBase());
  db.getUser(SELLER).cash = Number.MAX_SAFE_INTEGER - 10;
  const before = totals([SELLER, BUYER]);
  const failed = trade.respond(offer.id, BUYER, 'accept');
  assert.equal(failed.error, 'balance_limit');
  assert.equal(failed.terminal, true);
  assert.deepEqual(totals([SELLER, BUYER]), before);
});

test('two sellers competing for one buyer who can afford only one: exactly one succeeds, totals conserved', () => {
  const sellerA = '300000000000000001';
  const sellerB = '300000000000000002';
  actor(sellerA, { materials: { amber_dust: 5 } });
  actor(sellerB, { materials: { amber_dust: 5 } });
  actor(BUYER, { cash: 8000 });
  const before = totals([sellerA, sellerB, BUYER]);
  const a = trade.createOffer(offerBase({ sellerId: sellerA, seller: db.getUser(sellerA) })).offer;
  const b = trade.createOffer(offerBase({ sellerId: sellerB, seller: db.getUser(sellerB) })).offer;
  const first = trade.respond(a.id, BUYER, 'accept');
  const second = trade.respond(b.id, BUYER, 'accept');
  assert.equal(first.status, 'accepted');
  assert.equal(second.error, 'buyer_insufficient');
  assert.equal(db.getUser(BUYER).cash, 0);
  assert.deepEqual(totals([sellerA, sellerB, BUYER]), before);
  assert.equal(trade.getOffer(b.id).status, 'pending');
  assert.equal(trade.respond(b.id, sellerB, 'cancel').status, 'cancelled');
});

test('simultaneous clicks (async interleaving) resolve exactly once', async () => {
  actor(SELLER, { cash: 0, materials: { amber_dust: 5 } });
  actor(BUYER, { cash: 20000 });
  const before = totals([SELLER, BUYER]);
  const { offer } = trade.createOffer(offerBase());
  const clicks = ['accept', 'accept', 'decline', 'accept', 'decline'].map((action, i) => new Promise((resolve) => {
    setImmediate(() => resolve(trade.respond(offer.id, BUYER, action)));
    if (i === 99) resolve(null);
  }));
  const results = await Promise.all(clicks);
  const effective = results.filter((r) => r.ok);
  assert.equal(effective.length, 1, 'only one transition may take effect');
  assert.equal(results.filter((r) => r.error === 'already_resolved').length, 4);
  assert.deepEqual(totals([SELLER, BUYER]), before);
  assert.equal(db.getUser(BUYER).materials.amber_dust === 5 || db.getUser(BUYER).cash === 20000, true);
});

test('fuzz: random sequences of offers and clicks never create, lose or duplicate items or Candys', () => {
  const rng = seeded(20261008);
  const ids = ['400000000000000001', '400000000000000002', '400000000000000003', '400000000000000004'];
  const materialIds = ['amber_dust', 'candy_corn', 'soul_crystal'];
  for (const id of ids) {
    actor(id, {
      cash: 50000 + Math.floor(rng() * 50000),
      materials: { amber_dust: 10, candy_corn: 10, soul_crystal: 4 },
      inventory: { luck: 2 },
      weapons: id.endsWith('1') ? ['rama'] : [],
    });
  }
  const before = totals(ids);
  const created = [];
  let now = 1_800_000_000_000;
  const pick = (arr) => arr[Math.floor(rng() * arr.length)];
  for (let step = 0; step < 4000; step += 1) {
    now += Math.floor(rng() * 30_000);
    const roll = rng();
    if (roll < 0.35) {
      const sellerId = pick(ids);
      let recipientId = pick(ids);
      if (rng() < 0.9) while (recipientId === sellerId) recipientId = pick(ids);
      const kind = rng();
      const itemQuery = kind < 0.6 ? pick(materialIds) : kind < 0.85 ? 'luck' : 'rama';
      const price = Math.floor(rng() * 40000);
      const result = trade.createOffer({
        sellerId,
        seller: db.getUser(sellerId),
        recipientId,
        recipient: db.getUser(recipientId),
        itemQuery,
        qtyToken: itemQuery === 'rama' ? null : String(1 + Math.floor(rng() * 4)),
        priceToken: String(price),
        now,
      });
      if (result.offer) created.push(result.offer.id);
    } else if (created.length) {
      const offerId = pick(created);
      const offer = trade.getOffer(offerId);
      if (!offer) {
        // Oferta resuelta hace más de TRADE_RETENTION_MS: ya se olvidó; un clic tardío responde "no existe".
        assert.equal(trade.respond(offerId, pick(ids), 'accept', now).error, 'not_found');
        continue;
      }
      const actorId = rng() < 0.8 ? (rng() < 0.7 ? offer.recipientId : offer.sellerId) : pick(ids);
      const action = pick(['accept', 'accept', 'decline', 'cancel']);
      const statusBefore = offer.status;
      const result = trade.respond(offerId, actorId, action, now);
      const statusAfter = trade.getOffer(offerId).status;
      if (statusBefore !== 'pending') assert.equal(statusAfter, statusBefore, 'a final state never changes');
      if (result.ok) assert.equal(statusBefore, 'pending');
      if (rng() < 0.05) trade.expireOffer(offerId, now);
    }
    if (step % 400 === 0) {
      assert.deepEqual(totals(ids), before, `conservation broken at step ${step}`);
      for (const id of ids) {
        const user = db.getUser(id);
        assert.ok(Number.isSafeInteger(user.cash) && user.cash >= 0);
        for (const qty of [...Object.values(user.materials), ...Object.values(user.inventory)]) assert.ok(Number.isSafeInteger(qty) && qty > 0);
        if (user.equippedWeapon) assert.ok(user.weapons.includes(user.equippedWeapon));
      }
    }
  }
  assert.deepEqual(totals(ids), before);
  assert.ok(created.length > 50, 'the fuzz must actually create offers');
});

test('stored balances stay finite and safe after trades', () => {
  actor(SELLER, { cash: 5, materials: { amber_dust: 5 } });
  actor(BUYER, { cash: 20000 });
  const { offer } = trade.createOffer(offerBase());
  trade.respond(offer.id, BUYER, 'accept');
  for (const id of [SELLER, BUYER]) {
    const raw = JSON.stringify(db.getUser(id));
    assert.ok(!/Infinity|NaN/.test(raw));
    assert.ok(Number.isSafeInteger(db.getUser(id).cash));
  }
});
