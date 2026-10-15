'use strict';

// ============================================================
//  TRADE — Ofertas de venta/intercambio entre jugadores (xn give).
//
//  Reglas de seguridad (todas las transiciones son SÍNCRONAS, sin await, así que en un
//  proceso Node cada transición es atómica):
//   · Nada se retiene en "escrow": al crear la oferta no se mueve nada. Al aceptar se
//     revalida TODO (inventario del vendedor, saldo del comprador, límites numéricos) y,
//     solo si todo es válido, se mueven artículos y Candys en un único paso.
//   · Estados: pending → accepted | declined | cancelled | expired | failed. Un estado final
//     nunca cambia; aceptar/rechazar/cancelar dos veces no repite efectos.
//   · Solo el destinatario acepta/rechaza y solo el vendedor cancela.
//   · Las ofertas viven en memoria: si el bot se reinicia no se pierde ni se duplica nada
//     (no había nada retenido); los botones viejos responden "oferta no disponible".
// ============================================================

const crypto = require('crypto');
const cfg = require('./config');
const db = require('./database');
const economy = require('./economy');

const offers = new Map(); // offerId -> offer
const outgoing = new Map(); // sellerId -> Set(offerId) pendientes
const incoming = new Map(); // recipientId -> Set(offerId) pendientes

// ---------- Catálogo de artículos transferibles ----------
// Transferibles: pociones guardadas, materiales y armas. NO transferibles: efectos activos y los
// roles/beneficios de la Tienda del Evento (están ligados a la cuenta y al rol de Discord).

function normalizeKey(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

let catalogCache = null;
let lookupCache = null;

function catalog() {
  if (catalogCache) return catalogCache;
  catalogCache = [
    ...cfg.POTIONS.map((p) => ({
      kind: 'potion', id: p.id, name: p.name, emoji: p.emoji, baseValue: p.price,
    })),
    ...cfg.MATERIALS.map((m) => ({
      kind: 'material', id: m.id, name: m.name, emoji: m.emoji, baseValue: cfg.MATERIAL_BASE_VALUES[m.id],
    })),
    ...cfg.WEAPONS.map((w) => ({
      kind: 'weapon', id: w.id, name: w.name, emoji: w.emoji, baseValue: w.price,
    })),
  ];
  return catalogCache;
}

function lookup() {
  if (lookupCache) return lookupCache;
  lookupCache = new Map();
  for (const entry of catalog()) {
    for (const key of new Set([normalizeKey(entry.id), normalizeKey(entry.name)])) {
      if (!key) continue;
      lookupCache.set(key, lookupCache.has(key) && lookupCache.get(key) !== entry ? 'ambiguous' : entry);
    }
  }
  return lookupCache;
}

function isEventShopItem(key) {
  return cfg.EVENT_SHOP.some((role) => normalizeKey(role.id) === key || normalizeKey(role.name) === key);
}

// Devuelve { item } | { error: 'item_not_found' | 'not_transferable' | 'ambiguous_item' }
function resolveItem(query) {
  const key = normalizeKey(query);
  if (!key) return { error: 'item_not_found' };
  const found = lookup().get(key);
  if (found === 'ambiguous') return { error: 'ambiguous_item' };
  if (found) return { item: found };
  if (isEventShopItem(key)) return { error: 'not_transferable' };
  return { error: 'item_not_found' };
}

function getBaseValue(kind, id) {
  const entry = catalog().find((item) => item.kind === kind && item.id === id);
  return entry ? entry.baseValue : null;
}

// Precio mínimo TOTAL permitido: al menos la mitad del valor base total (redondeado hacia arriba).
function minPriceFor(item, quantity) {
  return Math.ceil(item.baseValue * quantity * cfg.TRADE_MIN_PRICE_RATIO);
}

function getOwned(user, item) {
  if (item.kind === 'potion') return Math.max(0, Number(user.inventory?.[item.id]) || 0);
  if (item.kind === 'material') return Math.max(0, Number(user.materials?.[item.id]) || 0);
  if (item.kind === 'weapon') return db.hasWeapon(user, item.id) ? 1 : 0;
  return 0;
}

function removeItem(user, item, quantity) {
  if (item.kind === 'potion') return db.removeInventory(user, item.id, quantity);
  if (item.kind === 'material') return db.removeMaterial(user, item.id, quantity);
  if (item.kind === 'weapon') return quantity === 1 && db.removeWeapon(user, item.id);
  return false;
}

function addItem(user, item, quantity) {
  if (item.kind === 'potion') db.addInventory(user, item.id, quantity);
  else if (item.kind === 'material') db.addMaterial(user, item.id, quantity);
  else if (item.kind === 'weapon') db.addWeapon(user, item.id);
}

// ---------- Sintaxis: xn give <@destinatario> <artículo> [cantidad|all] <precio total> ----------

function parseGiveArgs(tokens) {
  const clean = (tokens || []).map((token) => String(token).trim()).filter(Boolean);
  if (clean.length < 2) return { error: 'usage' };
  const priceToken = clean[clean.length - 1];
  const rest = clean.slice(0, -1);
  let qtyToken = null;
  if (rest.length >= 2 && /^(?:[\d.,]+|all|todo|max)$/i.test(rest[rest.length - 1])) {
    qtyToken = rest.pop();
  }
  const itemQuery = rest.join(' ').trim();
  if (!itemQuery) return { error: 'usage' };
  return { itemQuery, qtyToken, priceToken };
}

function parseQuantity(token, owned) {
  if (token === null || token === undefined) return 1;
  const raw = String(token).trim().toLowerCase();
  if (['all', 'todo', 'max'].includes(raw)) return owned >= 1 ? owned : null;
  const clean = raw.replace(/,/g, '');
  if (!/^\d+$/.test(clean)) return null;
  const quantity = Number(clean);
  return Number.isSafeInteger(quantity) && quantity >= 1 ? quantity : null;
}

// ---------- Ciclo de vida ----------

function pendingIds(map, userId) {
  return map.get(String(userId)) || new Set();
}

function register(map, userId, offerId) {
  const key = String(userId);
  if (!map.has(key)) map.set(key, new Set());
  map.get(key).add(offerId);
}

function unregister(map, userId, offerId) {
  const key = String(userId);
  const set = map.get(key);
  if (!set) return;
  set.delete(offerId);
  if (!set.size) map.delete(key);
}

function finalize(offer, status, now, reason = null) {
  offer.status = status;
  offer.resolvedAt = now;
  offer.reason = reason;
  unregister(outgoing, offer.sellerId, offer.id);
  unregister(incoming, offer.recipientId, offer.id);
}

// Cierra como "expired" toda oferta pendiente cuyo tiempo ya pasó (el temporizador y cualquier
// clic tardío llegan al mismo resultado: una oferta vencida nunca se puede aceptar).
function expireStale(now) {
  for (const offer of offers.values()) {
    if (offer.status === 'pending' && now >= offer.expiresAt) finalize(offer, 'expired', now);
  }
}

function pruneOffers(now) {
  for (const [id, offer] of offers) {
    if (offer.status !== 'pending' && now - (offer.resolvedAt || 0) > cfg.TRADE_RETENTION_MS) offers.delete(id);
  }
}

function snapshot(offer) {
  return {
    id: offer.id,
    status: offer.status,
    reason: offer.reason,
    sellerId: offer.sellerId,
    recipientId: offer.recipientId,
    item: { ...offer.item },
    quantity: offer.quantity,
    price: offer.price,
    unitPrice: offer.price / offer.quantity,
    baseValue: offer.item.baseValue,
    minPrice: minPriceFor(offer.item, offer.quantity),
    createdAt: offer.createdAt,
    expiresAt: offer.expiresAt,
    resolvedAt: offer.resolvedAt,
    names: { ...offer.names },
  };
}

function newOfferId() {
  let id;
  do { id = crypto.randomBytes(4).toString('hex'); } while (offers.has(id));
  return id;
}

// Devuelve { offer } o { error, ...detalles }. No mueve ningún artículo ni Candy.
function createOffer({
  sellerId, seller, recipientId, recipient, recipientIsBot = false,
  itemQuery, qtyToken = null, priceToken, sellerName = '', recipientName = '', now = Date.now(),
}) {
  if (!sellerId || !recipientId || !seller || !recipient) return { error: 'invalid_party' };
  if (String(sellerId) === String(recipientId)) return { error: 'self' };
  if (recipientIsBot) return { error: 'bot' };

  expireStale(now);
  pruneOffers(now);

  const resolved = resolveItem(itemQuery);
  if (resolved.error) return { error: resolved.error };
  const { item } = resolved;
  if (!Number.isSafeInteger(item.baseValue) || item.baseValue < 1) return { error: 'item_not_found' };

  const owned = getOwned(seller, item);
  const quantity = parseQuantity(qtyToken, owned);
  if (quantity === null) return { error: 'invalid_quantity', max: cfg.TRADE_MAX_QUANTITY };
  if (item.kind === 'weapon' && quantity !== 1) return { error: 'invalid_quantity', max: 1 };
  if (quantity > cfg.TRADE_MAX_QUANTITY) return { error: 'invalid_quantity', max: cfg.TRADE_MAX_QUANTITY };
  if (owned < quantity) return { error: 'seller_insufficient', have: owned, need: quantity, item };

  const price = economy.parseAmount(priceToken);
  if (!price || !Number.isSafeInteger(price)) return { error: 'invalid_price' };
  const minPrice = minPriceFor(item, quantity);
  if (price < minPrice) return { error: 'price_too_low', min: minPrice, base: item.baseValue * quantity, item };
  if (price > cfg.TRADE_MAX_PRICE) return { error: 'price_too_high', max: cfg.TRADE_MAX_PRICE };

  if (item.kind === 'weapon' && db.hasWeapon(recipient, item.id)) return { error: 'recipient_has_weapon', item };

  if (pendingIds(outgoing, sellerId).size >= cfg.TRADE_MAX_PENDING_OUT) return { error: 'seller_busy' };
  if (pendingIds(incoming, recipientId).size >= cfg.TRADE_MAX_PENDING_IN) return { error: 'recipient_busy' };

  if (recipient.cash < price) return { error: 'recipient_insufficient', need: price, have: recipient.cash };
  if (!Number.isSafeInteger(seller.cash + price) || !Number.isSafeInteger(getOwned(recipient, item) + quantity)) {
    return { error: 'balance_limit' };
  }

  const offer = {
    id: newOfferId(),
    status: 'pending',
    reason: null,
    sellerId: String(sellerId),
    recipientId: String(recipientId),
    item: { ...item },
    quantity,
    price,
    createdAt: now,
    expiresAt: now + cfg.TRADE_OFFER_TTL_MS,
    resolvedAt: null,
    names: { seller: String(sellerName || ''), recipient: String(recipientName || '') },
  };
  offers.set(offer.id, offer);
  register(outgoing, offer.sellerId, offer.id);
  register(incoming, offer.recipientId, offer.id);
  return { offer: snapshot(offer) };
}

function getOffer(offerId) {
  const offer = offers.get(String(offerId));
  return offer ? snapshot(offer) : null;
}

// Expiración por temporizador: solo actúa si la oferta sigue pendiente y ya venció.
function expireOffer(offerId, now = Date.now()) {
  const offer = offers.get(String(offerId));
  if (!offer || offer.status !== 'pending' || now < offer.expiresAt) return { expired: false, offer: offer ? snapshot(offer) : null };
  finalize(offer, 'expired', now);
  return { expired: true, offer: snapshot(offer) };
}

function failOffer(offer, reason, now, extra = {}) {
  finalize(offer, 'failed', now, reason);
  return { error: reason, terminal: true, offer: snapshot(offer), ...extra };
}

// Mueve artículos y Candys en un solo paso síncrono, tras revalidarlo todo.
function executeAccept(offer, now) {
  const seller = db.getUser(offer.sellerId);
  const buyer = db.getUser(offer.recipientId);
  const { item, quantity, price } = offer;

  if (offer.sellerId === offer.recipientId) return failOffer(offer, 'self', now);
  const stock = getOwned(seller, item);
  if (stock < quantity) return failOffer(offer, 'seller_insufficient', now, { have: stock, need: quantity });
  if (item.kind === 'weapon' && db.hasWeapon(buyer, item.id)) return failOffer(offer, 'recipient_has_weapon', now);
  // Recuperable: la oferta sigue pendiente para que el comprador retire del banco y reintente.
  if (buyer.cash < price) return { error: 'buyer_insufficient', need: price, have: buyer.cash, offer: snapshot(offer) };
  if (!Number.isSafeInteger(seller.cash + price) || !Number.isSafeInteger(getOwned(buyer, item) + quantity)) {
    return failOffer(offer, 'balance_limit', now);
  }

  if (!removeItem(seller, item, quantity)) return failOffer(offer, 'seller_insufficient', now, { have: getOwned(seller, item), need: quantity });
  addItem(buyer, item, quantity);
  buyer.cash -= price;
  seller.cash += price;
  db.markDirty(seller, buyer);
  finalize(offer, 'accepted', now);
  return { ok: true, status: 'accepted', offer: snapshot(offer) };
}

// action: 'accept' | 'decline' (solo el destinatario) | 'cancel' (solo el vendedor)
function respond(offerId, actorId, action, now = Date.now()) {
  const offer = offers.get(String(offerId));
  if (!offer) return { error: 'not_found' };
  if (!['accept', 'decline', 'cancel'].includes(action)) return { error: 'invalid_action' };

  if (offer.status === 'pending' && now >= offer.expiresAt) finalize(offer, 'expired', now);
  if (offer.status !== 'pending') return { error: 'already_resolved', status: offer.status, offer: snapshot(offer) };

  if (action === 'cancel') {
    if (String(actorId) !== offer.sellerId) return { error: 'not_seller', offer: snapshot(offer) };
    finalize(offer, 'cancelled', now);
    return { ok: true, status: 'cancelled', offer: snapshot(offer) };
  }
  if (String(actorId) !== offer.recipientId) return { error: 'not_recipient', offer: snapshot(offer) };
  if (action === 'decline') {
    finalize(offer, 'declined', now);
    return { ok: true, status: 'declined', offer: snapshot(offer) };
  }
  return executeAccept(offer, now);
}

function pendingCount(userId, direction = 'out', now = Date.now()) {
  expireStale(now);
  return pendingIds(direction === 'out' ? outgoing : incoming, userId).size;
}

// Solo para pruebas.
function reset() {
  offers.clear();
  outgoing.clear();
  incoming.clear();
}

module.exports = {
  normalizeKey, catalog, resolveItem, getBaseValue, minPriceFor, getOwned, removeItem, addItem,
  parseGiveArgs, parseQuantity,
  createOffer, getOffer, respond, expireOffer, pendingCount, reset,
};
