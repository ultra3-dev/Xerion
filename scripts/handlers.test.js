'use strict';

// Pruebas de punta a punta de index.js: mensajes, botones, doble clic, expiración y owner.
// Se reemplaza solo la clase Client de discord.js (sin red); builders, flags y ui.js son los reales.

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const {
  after, before, beforeEach, mock, test,
} = require('node:test');
const {
  setupEnv, cleanupEnv, countComponents, collectText, toPlain, buttonsOf,
} = require('./_helpers');

const tempDir = setupEnv('handlers');
process.env.BOT_TOKEN = 'token-de-prueba-no-real';
process.env.XERION_EMOJI_SOURCE = 'off'; // sin descargas de emojis en pruebas: iconos vectoriales deterministas
delete process.env.PORT;

const djsPath = require.resolve('discord.js');
const realDiscord = require('discord.js');

class FakeClient extends EventEmitter {
  constructor() {
    super();
    this.users = { cache: new Map() };
    this.user = { tag: 'Xerion#0000', setPresence() {} };
  }

  async login() { return 'ok'; }

  destroy() {}
}
require.cache[djsPath].exports = { ...realDiscord, Client: FakeClient };

const cfg = require('../config');
const db = require('../database');
const economy = require('../economy');
const trade = require('../trade');
const app = require('../index');

const OWNER = cfg.OWNER_ID;
const S = '910000000000000001'; // vendedora
const R = '910000000000000002'; // destinataria
const T = '910000000000000003'; // tercera persona
const NAMES = { [S]: 'Vendedora', [R]: 'Destinataria', [T]: 'Tercera', [OWNER]: 'Dueño' };

class Coll extends Map { first() { return this.values().next().value; } }

let sequence = 1000;
const nextId = () => String((sequence += 1));

function makeMember(id, bot = false) {
  return {
    id,
    displayName: NAMES[id] || `Usuario ${id.slice(-3)}`,
    user: { id, bot, username: NAMES[id] || id },
    displayAvatarURL: () => 'https://cdn.example/avatar.png',
  };
}

function makeSent(payload) {
  const sent = { payload, edits: [] };
  sent.edit = async (next) => { sent.payload = next; sent.edits.push(next); return sent; };
  return sent;
}

function everyMessageIsV2(payload) {
  const { files, ...withoutFiles } = payload; // los Buffers de imagen no se serializan
  const plain = toPlain(withoutFiles);
  assert.equal(plain.flags & 32768, 32768, 'IsComponentsV2');
  assert.equal(plain.content, undefined);
  assert.ok(countComponents(plain) <= 40);
  assert.ok(collectText(payload).length <= 4000);
  return plain;
}

function makeMessage({ author = S, content, mentions = [] }) {
  const members = new Coll();
  for (const [id, bot] of mentions.map((m) => (Array.isArray(m) ? m : [m, false]))) members.set(id, makeMember(id, bot));
  const sentMessages = [];
  const message = {
    id: nextId(),
    content,
    author: { id: author, bot: false, username: NAMES[author] || author, globalName: NAMES[author] || author },
    member: makeMember(author),
    guild: { id: 'guild-1', members: { cache: new Map(), fetch: async (id) => makeMember(id) } },
    mentions: { members },
    channel: {
      id: 'channel-1',
      async send(payload) {
        everyMessageIsV2(payload);
        const sent = makeSent(payload);
        sentMessages.push(sent);
        return sent;
      },
    },
    sentMessages,
  };
  return message;
}

function makeInteraction({ customId, userId, message, fetchDelayMs = 0 }) {
  const log = { deferUpdate: 0, editReply: [], followUp: [], reply: [] };
  const interaction = {
    id: nextId(),
    customId,
    user: { id: userId },
    member: makeMember(userId),
    guild: {
      members: {
        cache: new Map(),
        async fetch(id) { if (fetchDelayMs) await new Promise((resolve) => { setImmediate(resolve); }); return makeMember(id); },
      },
    },
    message,
    deferred: false,
    replied: false,
    isButton: () => true,
    async deferUpdate() { interaction.deferred = true; log.deferUpdate += 1; },
    async deferReply() { interaction.deferred = true; },
    async editReply(payload) { everyMessageIsV2(payload); log.editReply.push(payload); if (message) { message.payload = payload; message.edits.push(payload); } return message; },
    async followUp(payload) { log.followUp.push(payload); },
    async reply(payload) { log.reply.push(payload); },
    log,
  };
  return interaction;
}

const P = require('../render/png');

// Espera (en tiempo real, sin depender de los temporizadores simulados) a que se cumpla una condición.
async function waitFor(predicate, limitMs = 8000) {
  const started = process.hrtime.bigint();
  while (!predicate()) {
    if (Number(process.hrtime.bigint() - started) / 1e6 > limitMs) throw new Error('waitFor: tiempo agotado');
    await new Promise((resolve) => { setImmediate(resolve); });
  }
}

function imageOf(payload) {
  assert.equal(Array.isArray(payload.files) && payload.files.length, 1, 'the message carries exactly one image');
  const file = payload.files[0];
  assert.ok(Buffer.isBuffer(file.attachment));
  assert.equal(file.attachment.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  const { files, ...rest } = payload;
  const gallery = toPlain(rest).components[0].components.find((component) => component.type === 12);
  assert.ok(gallery, 'the container embeds a Components V2 media gallery');
  assert.equal(gallery.items[0].media.url, `attachment://${file.name}`);
  assert.match(gallery.items[0].description, /Mesa de blackjack/);
  return { file, gallery, decoded: P.decodePNG(file.attachment) };
}

const messageListener = () => app.client.listeners('messageCreate')[0];
const interactionListener = () => app.client.listeners('interactionCreate')[0];
const say = (message) => messageListener()(message);
const click = (interaction) => interactionListener()(interaction);

// Avanza los temporizadores simulados hasta que todo lo pendiente termine (animaciones con sleep()).
async function settle(...promises) {
  let finished = false;
  Promise.all(promises).then(() => { finished = true; }, () => { finished = true; });
  for (let i = 0; i < 80 && !finished; i += 1) {
    await new Promise((resolve) => { setImmediate(resolve); });
    mock.timers.tick(1000);
  }
  await Promise.all(promises);
}

function resetPlayer(id, patch = {}) {
  const user = db.getUser(id);
  Object.assign(user, {
    cash: 0, bank: 0, debt: 0, xp: 0, materials: {}, inventory: {}, weapons: [], equippedWeapon: null, effects: {}, cooldowns: {}, cooldownCycles: {},
  }, patch);
  return user;
}

function totals(ids) {
  return ids.reduce((acc, id) => {
    const user = db.getUser(id);
    acc.cash += user.cash;
    acc.amber += user.materials.amber_dust || 0;
    return acc;
  }, { cash: 0, amber: 0 });
}

function offerCard(sent) {
  const buttons = buttonsOf(sent.payload);
  const byAction = Object.fromEntries(buttons.map((b) => [b.custom_id.split(':')[1], b.custom_id]));
  return { buttons, byAction, offerId: buttons[0].custom_id.split(':')[3], text: collectText(sent.payload) };
}

async function openOffer({ price = '8000', qty = '5', item = 'amber_dust' } = {}) {
  resetPlayer(S, { cash: 100, materials: { amber_dust: 8 } });
  resetPlayer(R, { cash: 20_000 });
  trade.reset();
  const message = makeMessage({ author: S, content: `Xn give <@${R}> ${item} ${qty} ${price}`, mentions: [R] });
  await say(message);
  assert.equal(message.sentMessages.length, 1);
  return { message, sent: message.sentMessages[0], ...offerCard(message.sentMessages[0]) };
}

before(async () => {
  await new Promise((resolve) => { setTimeout(resolve, 50); }); // deja terminar db.loadDB() de index.js
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_800_000_000_000 });
});
after(async () => {
  mock.timers.reset();
  await db.closeDB();
  cleanupEnv(tempDir);
});
beforeEach(() => { trade.reset(); });

// ---------- Catálogo de comandos ----------

test('the bot exposes exactly 55 real commands; aliases are separate and all point to a real command', () => {
  const names = Object.keys(app.commands);
  assert.equal(names.length, 55);
  for (const added of ['give', 'interest', 'train', 'skills', 'crash']) assert.ok(names.includes(added), added);
  for (const [alias, target] of Object.entries(app.ALIASES)) {
    assert.ok(names.includes(target), `${alias} -> ${target}`);
    assert.ok(!names.includes(alias), `${alias} must not be a real command`);
  }
  assert.equal(app.ALIASES.sell, 'give');
  assert.equal(app.ALIASES.trade, 'give');
});

// ---------- xn give: interfaz y permisos ----------

test('xn give posts a clear Components V2 offer with accept/decline/cancel buttons and pings only the recipient', async () => {
  const { sent, buttons, byAction, offerId, text } = await openOffer();
  const plain = everyMessageIsV2(sent.payload);
  assert.deepEqual(plain.allowedMentions, { parse: [], users: [R] });
  assert.match(text, /Oferta de intercambio/);
  assert.match(text, /Amber Dust/);
  assert.match(text, /×5/);
  assert.match(text, /8,000/);
  assert.match(text, /mínimo permitido: 4,000/);
  assert.ok(text.includes(`<@${R}>`));
  assert.equal(buttons.length, 3);
  assert.deepEqual(Object.keys(byAction).sort(), ['accept', 'cancel', 'decline']);
  assert.equal(byAction.accept, `trade:accept:${R}:${offerId}`);
  assert.equal(byAction.decline, `trade:decline:${R}:${offerId}`);
  assert.equal(byAction.cancel, `trade:cancel:${S}:${offerId}`);
  assert.ok(buttons.every((button) => button.custom_id.length <= 100));
  assert.equal(db.getUser(S).materials.amber_dust, 8, 'nothing moves until the recipient accepts');
  assert.equal(db.getUser(R).cash, 20_000);
});

test('accept by the recipient swaps items and Candys once; the first reply is acknowledged immediately', async () => {
  const { sent, byAction } = await openOffer();
  const before = totals([S, R]);
  const interaction = makeInteraction({ customId: byAction.accept, userId: R, message: sent });
  await click(interaction);
  assert.equal(interaction.log.deferUpdate, 1, 'deferUpdate acknowledges the click');
  assert.equal(interaction.log.editReply.length, 1);
  assert.match(collectText(interaction.log.editReply[0]), /Intercambio completado/);
  assert.equal(buttonsOf(interaction.log.editReply[0]).length, 0, 'no buttons remain after the result');
  assert.equal(db.getUser(S).cash, 8100);
  assert.equal(db.getUser(R).cash, 12_000);
  assert.equal(db.getUser(S).materials.amber_dust, 3);
  assert.equal(db.getUser(R).materials.amber_dust, 5);
  assert.equal(totals([S, R]).cash, before.cash);
  assert.equal(totals([S, R]).amber, before.amber);
});

test('buttons are locked to the right person: a third party, the seller on accept and the recipient on cancel are refused', async () => {
  const { sent, byAction } = await openOffer();
  const snapshot = totals([S, R]);
  const attempts = [
    [byAction.accept, T], [byAction.decline, T], [byAction.cancel, T],
    [byAction.accept, S], [byAction.decline, S], [byAction.cancel, R],
  ];
  for (const [customId, userId] of attempts) {
    const interaction = makeInteraction({ customId, userId, message: sent });
    await click(interaction);
    assert.equal(interaction.log.deferUpdate, 1);
    assert.equal(interaction.log.editReply.length, 0, 'the offer message is never edited by the wrong person');
    assert.equal(interaction.log.followUp.length, 1);
    assert.equal(toPlain(interaction.log.followUp[0]).flags & 64, 64, 'the refusal is ephemeral');
    assert.match(collectText(interaction.log.followUp[0]), /no es tuyo/);
  }
  assert.deepEqual(totals([S, R]), snapshot);
  assert.equal(trade.getOffer(offerCard(sent).offerId).status, 'pending');
});

test('double clicks, retried interactions and simultaneous clicks never repeat the swap', async () => {
  const { sent, byAction } = await openOffer();
  const before = totals([S, R]);
  const first = makeInteraction({ customId: byAction.accept, userId: R, message: sent });
  const second = makeInteraction({ customId: byAction.accept, userId: R, message: sent });
  const third = makeInteraction({ customId: byAction.decline, userId: R, message: sent });
  await Promise.all([click(first), click(second), click(third)]);
  const accepted = [first, second, third].filter((i) => i.log.editReply.some((p) => /Intercambio completado/.test(collectText(p))));
  assert.ok(accepted.length >= 1);
  assert.equal(db.getUser(R).materials.amber_dust, 5, 'bought exactly once');
  assert.equal(db.getUser(S).cash, 8100);
  assert.equal(totals([S, R]).cash, before.cash);
  assert.equal(totals([S, R]).amber, before.amber);
  // Cualquier clic tardío solo vuelve a dibujar el estado final.
  const late = makeInteraction({ customId: byAction.accept, userId: R, message: sent });
  await click(late);
  assert.match(collectText(late.log.editReply[0]), /Intercambio completado/);
  assert.equal(db.getUser(S).cash, 8100);
  // El mismo evento de Discord entregado dos veces se ignora por completo.
  const replay = makeInteraction({ customId: byAction.accept, userId: R, message: sent });
  replay.id = late.id;
  await click(replay);
  assert.equal(replay.log.editReply.length, 0);
  assert.equal(replay.log.followUp.length, 0);
});

test('decline and cancel end the offer without moving anything; later accepts only redraw the final state', async () => {
  for (const [who, action, expected] of [[R, 'decline', /Oferta rechazada/], [S, 'cancel', /Oferta cancelada/]]) {
    const { sent, byAction } = await openOffer();
    const before = totals([S, R]);
    const closing = makeInteraction({ customId: byAction[action], userId: who, message: sent });
    await click(closing);
    assert.match(collectText(closing.log.editReply[0]), expected);
    const late = makeInteraction({ customId: byAction.accept, userId: R, message: sent });
    await click(late);
    assert.match(collectText(late.log.editReply[0]), expected, 'still shows how the offer ended');
    assert.deepEqual(totals([S, R]), before);
    assert.equal(trade.pendingCount(S, 'out'), 0);
  }
});

test('an offer that expires edits its message, never moves anything and can no longer be accepted', async () => {
  const { sent, byAction } = await openOffer();
  const before = totals([S, R]);
  mock.timers.tick(cfg.TRADE_OFFER_TTL_MS + 300);
  assert.equal(sent.edits.length, 1, 'the expiry timer redrew the card');
  assert.match(collectText(sent.edits[0]), /Oferta expirada/);
  assert.equal(buttonsOf(sent.edits[0]).length, 0);
  const late = makeInteraction({ customId: byAction.accept, userId: R, message: sent });
  await click(late);
  assert.match(collectText(late.log.editReply[0]), /Oferta expirada/);
  assert.deepEqual(totals([S, R]), before);
  // El vendedor queda libre y puede ofrecer otra vez.
  const again = makeMessage({ author: S, content: `Xn give <@${R}> amber_dust 1 800`, mentions: [R] });
  await say(again);
  assert.match(collectText(again.sentMessages[0].payload), /Oferta de intercambio/);
});

test('an offer resolved by buttons is not touched again by the expiry timer', async () => {
  const { sent, byAction } = await openOffer();
  await click(makeInteraction({ customId: byAction.decline, userId: R, message: sent }));
  const editsBefore = sent.edits.length;
  mock.timers.tick(cfg.TRADE_OFFER_TTL_MS + 300);
  assert.equal(sent.edits.length, editsBefore, 'no second edit after a manual resolution');
});

test('clicks on offers the bot no longer remembers (restart) are told so and change nothing', async () => {
  const { sent, byAction } = await openOffer();
  const before = totals([S, R]);
  trade.reset(); // simula un reinicio del bot
  const interaction = makeInteraction({ customId: byAction.accept, userId: R, message: sent });
  await click(interaction);
  assert.match(collectText(interaction.log.editReply[0]), /Oferta no disponible/);
  assert.deepEqual(totals([S, R]), before);
});

test('a buyer without enough Cash gets a private message and the offer stays open for a retry', async () => {
  const { sent, byAction } = await openOffer();
  db.getUser(R).cash = 100;
  const interaction = makeInteraction({ customId: byAction.accept, userId: R, message: sent });
  await click(interaction);
  assert.equal(interaction.log.editReply.length, 0);
  assert.equal(interaction.log.followUp.length, 1);
  assert.match(collectText(interaction.log.followUp[0]), /No tienes suficiente Cash/);
  assert.equal(db.getUser(S).materials.amber_dust, 8);
  db.getUser(R).cash = 8000;
  const retry = makeInteraction({ customId: byAction.accept, userId: R, message: sent });
  await click(retry);
  assert.match(collectText(retry.log.editReply[0]), /Intercambio completado/);
});

test('if the seller no longer has the items the acceptance fails cleanly and nothing moves', async () => {
  const { sent, byAction } = await openOffer();
  db.removeMaterial(db.getUser(S), 'amber_dust', 6);
  const before = totals([S, R]);
  const interaction = makeInteraction({ customId: byAction.accept, userId: R, message: sent });
  await click(interaction);
  assert.match(collectText(interaction.log.editReply[0]), /ya no tiene esos artículos/);
  assert.deepEqual(totals([S, R]), before);
});

// ---------- xn give: validaciones del comando ----------

test('invalid give commands answer with one clear error card and create no offer', async () => {
  resetPlayer(S, { cash: 100, materials: { amber_dust: 8 }, inventory: { luck: 1 } });
  resetPlayer(R, { cash: 20_000 });
  const cases = [
    [`Xn give amber_dust 5 8000`, [], /Falta el destinatario/],
    [`Xn give <@${S}> amber_dust 5 8000`, [S], /No puedes ofrecerte cosas a ti mismo/],
    [`Xn give <@${R}> amber_dust 5 8000`, [[R, true]], /Los bots no comercian/],
    [`Xn give <@${R}> amber_dust`, [R], /Faltan datos/],
    [`Xn give <@${R}>`, [R], /Faltan datos/],
    [`Xn give <@${R}> nada 5 8000`, [R], /No encontré ese artículo/],
    [`Xn give <@${R}> king 1 99999`, [R], /no se puede transferir/],
    [`Xn give <@${R}> amber_dust 0 8000`, [R], /Cantidad inválida/],
    [`Xn give <@${R}> amber_dust 9 99999`, [R], /No tienes suficientes/],
    [`Xn give <@${R}> amber_dust 5 abc`, [R], /Precio inválido/],
    [`Xn give <@${R}> amber_dust 5 3999`, [R], /Precio demasiado bajo/],
    [`Xn give <@${R}> luck 1 22499`, [R], /Precio demasiado bajo/],
    [`Xn give <@${R}> amber_dust 5 999999999`, [R], /no tiene Cash suficiente/],
  ];
  for (const [content, mentions, expected] of cases) {
    const message = makeMessage({ author: S, content, mentions });
    await say(message);
    assert.equal(message.sentMessages.length, 1, content);
    assert.match(collectText(message.sentMessages[0].payload), expected, content);
    assert.equal(buttonsOf(message.sentMessages[0].payload).length, 0, `${content} must not show buttons`);
    assert.equal(trade.pendingCount(S, 'out'), 0);
  }
  assert.equal(db.getUser(S).materials.amber_dust, 8);
  assert.equal(db.getUser(R).cash, 20_000);
});

test('xn sell and xn trade are aliases of give, and a reply-ping alone is not enough to pick a recipient', async () => {
  for (const alias of ['Xn sell', 'XN Trade']) {
    resetPlayer(S, { materials: { amber_dust: 8 } });
    resetPlayer(R, { cash: 20_000 });
    trade.reset();
    const message = makeMessage({ author: S, content: `${alias} <@${R}> amber_dust 5 8000`, mentions: [R] });
    await say(message);
    assert.match(collectText(message.sentMessages[0].payload), /Oferta de intercambio/);
  }
  trade.reset();
  const replyPing = makeMessage({ author: S, content: 'Xn give amber_dust 5 8000', mentions: [R] });
  await say(replyPing);
  assert.match(collectText(replyPing.sentMessages[0].payload), /Falta el destinatario/);
});

test('one seller cannot keep two offers open and the second request is explained', async () => {
  await openOffer();
  const second = makeMessage({ author: S, content: `Xn give <@${R}> amber_dust 1 800`, mentions: [R] });
  await say(second);
  assert.match(collectText(second.sentMessages[0].payload), /Ya tienes una oferta pendiente/);
});

// ---------- Duelos: reclamo atómico ----------

test('two simultaneous accept clicks resolve a duel exactly once (no double bet, no double XP)', async () => {
  const A = '920000000000000001';
  const B = '920000000000000002';
  NAMES[A] = 'Retador';
  NAMES[B] = 'Retado';
  resetPlayer(A, { cash: 10_000 });
  resetPlayer(B, { cash: 10_000 });
  const challenge = makeMessage({ author: A, content: `Xn duel <@${B}> 1000`, mentions: [B] });
  await say(challenge);
  const card = challenge.sentMessages[0];
  const acceptId = buttonsOf(card.payload).find((b) => b.custom_id.startsWith('duel:accept')).custom_id;
  const totalBefore = db.getUser(A).cash + db.getUser(B).cash;
  const xpBefore = db.getUser(A).xp + db.getUser(B).xp;
  const one = makeInteraction({ customId: acceptId, userId: B, message: card, fetchDelayMs: 1 });
  const two = makeInteraction({ customId: acceptId, userId: B, message: card, fetchDelayMs: 1 });
  await settle(click(one), click(two));
  const refused = [one, two].filter((i) => i.log.followUp.some((p) => /Este reto ya no existe/.test(collectText(p))));
  assert.equal(refused.length, 1, 'exactly one click was refused as "already resolved"');
  assert.equal(db.getUser(A).cash + db.getUser(B).cash, totalBefore, 'Candys conserved: the bet was moved only once');
  const cashes = [db.getUser(A).cash, db.getUser(B).cash].sort((x, y) => x - y);
  assert.deepEqual(cashes, [9000, 11_000], 'one winner, one loser, a single 1,000 bet');
  assert.ok(db.getUser(A).xp + db.getUser(B).xp - xpBefore <= economy.xpRangeAtLevel('duel', 0).max, 'winner XP awarded once');
  assert.equal(economy.getDuelChallenge(B), undefined);
});

// ---------- Blackjack: botones tardíos ----------

test('a blackjack button without an active game explains it privately and changes nothing', async () => {
  resetPlayer(S, { cash: 5000 });
  const sent = makeSent({});
  sent.edits = [];
  for (const action of ['hit', 'stand']) {
    const interaction = makeInteraction({ customId: `bj:${action}:${S}`, userId: S, message: sent });
    await click(interaction);
    assert.equal(interaction.log.editReply.length, 0);
    assert.equal(interaction.log.followUp.length, 1);
    assert.match(collectText(interaction.log.followUp[0]), /Partida terminada/);
    assert.equal(toPlain(interaction.log.followUp[0]).flags & 64, 64);
  }
  assert.equal(db.getUser(S).cash, 5000);
});

test('the blackjack hit/stand buttons stay locked to the player', async () => {
  const sent = makeSent({});
  sent.edits = [];
  const interaction = makeInteraction({ customId: `bj:hit:${S}`, userId: T, message: sent });
  await click(interaction);
  assert.match(collectText(interaction.log.followUp[0]), /no es tuyo/);
});

// ---------- Owner ----------

test('rob and bounty against the owner are refused with a clear message and cost nothing', async () => {
  resetPlayer(S, { cash: 50_000 });
  resetPlayer(OWNER, { cash: 777_777 });
  const before = JSON.stringify(db.getUser(S));
  const ownerBefore = JSON.stringify(db.getUser(OWNER));
  for (const content of [`Xn rob <@${OWNER}>`, `Xn bounty <@${OWNER}> 5000`]) {
    const message = makeMessage({ author: S, content, mentions: [OWNER] });
    await say(message);
    assert.match(collectText(message.sentMessages[0].payload), /Objetivo intocable/);
  }
  assert.equal(JSON.stringify(db.getUser(OWNER)), ownerBefore);
  const thief = db.getUser(S);
  assert.equal(thief.cash, 50_000);
  assert.deepEqual(thief.cooldowns, JSON.parse(before).cooldowns);
});

test('the balance and profile commands draw ∞ for the owner only', async () => {
  resetPlayer(OWNER, { cash: 12_345, bank: 67_890 });
  resetPlayer(S, { cash: 1_111, bank: 2_222 });
  const own = makeMessage({ author: OWNER, content: 'Xn balance' });
  await say(own);
  const ownText = collectText(own.sentMessages[0].payload);
  assert.match(ownText, /Cash:\*\* ∞/);
  assert.match(ownText, /Bank:\*\* ∞/);
  assert.match(ownText, /Total:\*\* ∞/);
  assert.ok(!ownText.includes('12,345') && !ownText.includes('67,890'));
  const viewedByOther = makeMessage({ author: S, content: `Xn profile <@${OWNER}>`, mentions: [OWNER] });
  await say(viewedByOther);
  const profileText = collectText(viewedByOther.sentMessages[0].payload);
  assert.match(profileText, /Cash:\*\* ∞/);
  assert.ok(!profileText.includes('12,345'));
  const regular = makeMessage({ author: S, content: 'Xn bal' });
  await say(regular);
  const regularText = collectText(regular.sentMessages[0].payload);
  assert.ok(!regularText.includes('∞'));
  assert.match(regularText, /1,111/);
  assert.equal(db.getUser(OWNER).cash, 12_345, 'viewing never rewrites the stored value');
  assert.ok(!/Infinity|NaN|∞/.test(JSON.stringify(db.getUser(OWNER))));
});

test('addcandy keeps stored balances inside the safe integer range', async () => {
  resetPlayer(OWNER, { cash: 0 });
  const first = makeMessage({ author: OWNER, content: `Xn addcandy <@${OWNER}> ${Number.MAX_SAFE_INTEGER}`, mentions: [OWNER] });
  await say(first);
  assert.match(collectText(first.sentMessages[0].payload), /Candys añadidos/);
  assert.equal(db.getUser(OWNER).cash, Number.MAX_SAFE_INTEGER);
  const second = makeMessage({ author: OWNER, content: `Xn addcandy <@${OWNER}> 1000`, mentions: [OWNER] });
  await say(second);
  assert.match(collectText(second.sentMessages[0].payload), /Saldo demasiado grande/);
  assert.equal(db.getUser(OWNER).cash, Number.MAX_SAFE_INTEGER);
  const intruder = makeMessage({ author: S, content: `Xn addcandy <@${S}> 1000`, mentions: [S] });
  await say(intruder);
  assert.match(collectText(intruder.sentMessages[0].payload), /Solo el dueño/);
});

test('pay refuses transfers that would push the recipient past the safe limit, moving nothing', async () => {
  resetPlayer(S, { cash: 5_000 });
  resetPlayer(R, { cash: Number.MAX_SAFE_INTEGER - 100 });
  const message = makeMessage({ author: S, content: `Xn pay <@${R}> 5000`, mentions: [R] });
  await say(message);
  assert.match(collectText(message.sentMessages[0].payload), /Saldo demasiado grande/);
  assert.equal(db.getUser(S).cash, 5_000);
  assert.equal(db.getUser(R).cash, Number.MAX_SAFE_INTEGER - 100);
});

test('the paginated rich/debt leaderboard buttons never include the owner', async () => {
  resetPlayer(OWNER, { cash: 10 ** 12, debt: 999_999 });
  for (let i = 0; i < 25; i += 1) resetPlayer(`93000000000000${String(i).padStart(4, '0')}`, { cash: 1000 + i, debt: i * 10 });
  for (const customId of [`top:rich:${S}`, `top:next-rich-0:${S}`, `top:debt:${S}`, `top:next-debt-0:${S}`]) {
    const sent = makeSent({});
    sent.edits = [];
    const interaction = makeInteraction({ customId, userId: S, message: sent });
    await click(interaction);
    assert.equal(interaction.log.editReply.length, 1, customId);
    const raw = JSON.stringify(toPlain(interaction.log.editReply[0]));
    assert.ok(!raw.includes(OWNER), `${customId} must not list the owner`);
    assert.ok(!raw.includes('@Dueño'));
  }
});

// ---------- Comandos nuevos (humo de punta a punta) ----------

test('interest pays 1% of the Bank (capped), once per 12 hours, and explains rejections', async () => {
  resetPlayer(S, { cash: 10, bank: 50_000 });
  const ok = makeMessage({ author: S, content: 'Xn interest' });
  await say(ok);
  assert.match(collectText(ok.sentMessages[0].payload), /Intereses cobrados/);
  assert.equal(db.getUser(S).cash, 510);
  const again = makeMessage({ author: S, content: 'Xn int' });
  await say(again);
  assert.match(collectText(again.sentMessages[0].payload), /aún no maduran/);
  assert.equal(db.getUser(S).cash, 510);
  resetPlayer(S, { cash: 0, bank: 200 });
  const poor = makeMessage({ author: S, content: 'Xn interest' });
  await say(poor);
  assert.match(collectText(poor.sentMessages[0].payload), /Bank es demasiado pequeño/);
});

test('train grants XP only and respects its cooldown; skills shows the level-adjusted XP table', async () => {
  resetPlayer(S, { cash: 55 });
  const trained = makeMessage({ author: S, content: 'Xn train' });
  await say(trained);
  assert.match(collectText(trained.sentMessages[0].payload), /Entrenamiento completado/);
  assert.equal(db.getUser(S).cash, 55);
  assert.ok(db.getUser(S).xp >= economy.xpRange('train').min);
  const again = makeMessage({ author: S, content: 'Xn train' });
  await say(again);
  assert.match(collectText(again.sentMessages[0].payload), /Estás agotado/);
  const sheet = makeMessage({ author: S, content: 'Xn sk' });
  await say(sheet);
  const text = collectText(sheet.sentMessages[0].payload);
  assert.match(text, /Hoja de personaje/);
  assert.match(text, /XP por acción a tu nivel/);
  assert.match(text, /`work`/);
});

test('crash validates input before spending anything and plays a full animated round', async () => {
  resetPlayer(S, { cash: 10_000 });
  for (const [content, expected] of [
    ['Xn crash', /Apuesta inválida/],
    ['Xn crash 50 2', /por debajo del mínimo/],
    ['Xn crash 1000', /Múltiplo inválido/],
    ['Xn crash 1000 1.05', /Múltiplo inválido/],
    ['Xn crash 1000 51', /Múltiplo inválido/],
    ['Xn crash 50000 2', /No tienes eso en Cash/],
  ]) {
    const message = makeMessage({ author: S, content });
    await say(message);
    assert.match(collectText(message.sentMessages[0].payload), expected, content);
  }
  assert.equal(db.getUser(S).cash, 10_000);
  assert.deepEqual(db.getUser(S).cooldowns, {});

  const original = Math.random;
  Math.random = () => 0.5; // el choque cae en x1.92
  try {
    const round = makeMessage({ author: S, content: 'Xn crash 1000 1.5' });
    await settle(say(round));
    const sent = round.sentMessages[0];
    const finalText = collectText(sent.payload);
    assert.match(finalText, /se estrelló en x1\.92/);
    assert.match(finalText, /x1\.50/);
    assert.equal(db.getUser(S).cash, 10_500, 'x1.5 target paid 1,500 for a 1,000 bet');
    const flights = sent.edits.map((edit) => collectText(edit)).filter((t) => /🧹 x\d/.test(t));
    assert.ok(flights.length >= 4, 'the animation shows several frames');
    assert.match(flights.at(-1), /🧹 x1\.92/, 'the last flight frame is the drawn crash point');
  } finally { Math.random = original; }
});

test('the wheel animation through the real command ends on the paid segment', async () => {
  resetPlayer(S, { cash: 100_000 });
  const weights = cfg.WHEEL_SEGMENTS.map((s) => s.weight);
  const half = cfg.WHEEL_SEGMENTS.findIndex((s) => s.mult === 0.5);
  const total = weights.reduce((a, b) => a + b, 0);
  const value = (weights.slice(0, half).reduce((a, b) => a + b, 0) + weights[half] / 2) / total;
  const original = Math.random;
  Math.random = () => value;
  try {
    const round = makeMessage({ author: S, content: 'Xn wheel 10000' });
    await settle(say(round));
    const sent = round.sentMessages[0];
    const frames = sent.edits.map((edit) => collectText(edit));
    const lastSpin = frames.filter((t) => /La rueda se detuvo|La rueda está girando/.test(t)).at(-1);
    assert.match(lastSpin, /🔻 x0\.5(\s|$)/);
    assert.match(lastSpin, /La rueda se detuvo/);
    assert.match(collectText(sent.payload), /Rueda de la Fortuna Embrujada — x0\.5/);
    assert.equal(db.getUser(S).cash, 95_000);
  } finally { Math.random = original; }
});

// Baraja determinista: mismo generador que consume newDeck() (51 sorteos), para escoger repartos reproducibles.
function lcg(seed) {
  let state = seed;
  return () => { state = (state * 16807) % 2147483647; return state / 2147483647; };
}

function dealFor(seed) {
  const random = lcg(seed);
  const suits = ['♠', '♥', '♦', '♣'];
  const ranks = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  const deck = [];
  for (const suit of suits) for (const rank of ranks) deck.push(rank + suit);
  for (let i = deck.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  const player = [deck.pop(), deck.pop()];
  return { natural: economy.handValue(player) === 21, player };
}

function seedWhere(predicate) {
  for (let seed = 1; seed < 5000; seed += 1) if (predicate(dealFor(seed))) return seed;
  throw new Error('no se encontró una semilla adecuada');
}

async function startBlackjackGame(bet = 1000, hand = { player: ['10♠', '5♥'], dealer: ['9♦', '7♣'], deck: ['2♣', '2♥', '3♠', '4♥'] }) {
  resetPlayer(S, { cash: 50_000 });
  economy.endBlackjack(S);
  const seed = seedWhere((deal) => !deal.natural);
  const original = Math.random;
  Math.random = lcg(seed);
  let message;
  try {
    message = makeMessage({ author: S, content: `Xn blackjack ${bet}` });
    await settle(say(message));
  } finally { Math.random = original; }
  const sent = message.sentMessages[0];
  const game = economy.getBlackjack(S);
  assert.ok(game, 'the game is open (not a natural blackjack)');
  Object.assign(game, { player: [...hand.player], dealer: [...hand.dealer], deck: [...hand.deck] });
  return { message, sent, game };
}

test('xn blackjack draws the table as an attached PNG inside a Components V2 container, with buttons and a 150 s timer', async () => {
  assert.equal(cfg.BLACKJACK_TIMEOUT_MS, 150_000);
  const { sent, game } = await startBlackjackGame();
  const first = imageOf(sent.payload);
  assert.equal(first.decoded.width, 900);
  assert.equal(first.decoded.height, 576);
  assert.ok(first.file.attachment.length < 130_000, `${first.file.attachment.length} bytes`);
  const text = collectText({ components: toPlain({ components: sent.payload.components }).components });
  assert.match(text, /Blackjack — Vendedora/);
  assert.match(text, /Cartas en mesa:\*\* \d+\/15/);
  assert.match(text, /Tienes 150 segundos/);
  assert.ok(buttonsOf({ components: sent.payload.components }).some((b) => b.custom_id === `bj:hit:${S}`));
  assert.deepEqual(sent.payload.allowedMentions, { parse: [] });
  assert.equal(economy.getBlackjack(S).bet, 1000);
  // El temporizador es de 150 s contados desde que empezó la mano: 1 ms antes sigue abierta, y al cumplirse se cierra.
  const editsBefore = sent.edits.length;
  const msLeft = game.startedAt + 150_000 - Date.now();
  assert.ok(msLeft > 0 && msLeft <= 150_000, `ms left ${msLeft}`);
  mock.timers.tick(msLeft - 1);
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.ok(economy.getBlackjack(S), 'still open 1 ms before the 150 s deadline');
  mock.timers.tick(1);
  await waitFor(() => sent.edits.length > editsBefore);
  assert.equal(economy.getBlackjack(S), undefined, 'closed exactly at 150 s');
  assert.match(collectText({ components: toPlain({ components: sent.payload.components }).components }), /Se acabó el tiempo/);
});

test('hit redraws the table with a new image, replaces the old attachment and keeps the buttons', async () => {
  const { sent } = await startBlackjackGame();
  const before = imageOf(sent.payload);
  const hit = makeInteraction({ customId: `bj:hit:${S}`, userId: S, message: sent });
  await click(hit);
  assert.equal(hit.log.deferUpdate, 1);
  assert.equal(hit.log.editReply.length, 1);
  const after = imageOf(hit.log.editReply[0]);
  assert.notEqual(after.file.name, before.file.name, 'unique file name per image (no stale CDN cache)');
  assert.notEqual(Buffer.compare(after.file.attachment, before.file.attachment), 0);
  assert.deepEqual(hit.log.editReply[0].attachments, [], 'attachments: [] drops the previous image on edit');
  assert.ok(buttonsOf({ components: hit.log.editReply[0].components }).some((b) => b.custom_id === `bj:stand:${S}`));
  assert.match(collectText({ components: toPlain({ components: hit.log.editReply[0].components }).components }), /Cartas en mesa:\*\* 5\/15/);
  assert.equal(economy.getBlackjack(S).player.length, 3);
  economy.endBlackjack(S);
});

test('stand resolves once, draws the final board with the result banner and no buttons; a second click only explains', async () => {
  const { sent } = await startBlackjackGame(1000, { player: ['10♠', '9♥'], dealer: ['10♦', '6♣'], deck: ['K♣'] });
  const stand = makeInteraction({ customId: `bj:stand:${S}`, userId: S, message: sent });
  await click(stand);
  const finalPayload = stand.log.editReply[0];
  const image = imageOf(finalPayload);
  const text = collectText({ components: toPlain({ components: finalPayload.components }).components });
  assert.match(text, /¡Ganaste! \+1,000/);
  assert.equal(buttonsOf({ components: finalPayload.components }).length, 0);
  assert.equal(db.getUser(S).cash, 51_000);
  // El banner verde del resultado está dibujado en la imagen (la imagen refleja lo que se pagó).
  const [r, g] = [image.decoded.data[((scene297()) * 900 + 300) * 4], image.decoded.data[((scene297()) * 900 + 300) * 4 + 1]];
  assert.ok(g > r + 40, `green banner (${r},${g})`);
  const again = makeInteraction({ customId: `bj:stand:${S}`, userId: S, message: sent });
  await click(again);
  assert.equal(again.log.editReply.length, 0);
  assert.match(collectText(again.log.followUp[0]), /Partida terminada/);
  assert.equal(db.getUser(S).cash, 51_000, 'never pays twice');
});

function scene297() { return require('../render/blackjack-scene').LAYOUT.bannerY + 14; }

test('two simultaneous hits leave exactly the newest board on screen (an older image never overwrites a newer one)', async () => {
  const { sent } = await startBlackjackGame(1000, { player: ['3♠', '4♥'], dealer: ['9♦', '7♣'], deck: ['2♣', '2♥', '5♦'] });
  const one = makeInteraction({ customId: `bj:hit:${S}`, userId: S, message: sent });
  const two = makeInteraction({ customId: `bj:hit:${S}`, userId: S, message: sent });
  await Promise.all([click(one), click(two)]);
  const edits = [...one.log.editReply, ...two.log.editReply];
  assert.equal(edits.length, 1, 'only the newest render is applied');
  assert.match(collectText({ components: toPlain({ components: edits[0].components }).components }), /Cartas en mesa:\*\* 6\/15/);
  assert.equal(economy.getBlackjack(S).player.length, 4);
  economy.endBlackjack(S);
});

test('hitting up to the 15-card limit closes the hand safely and shows the full-table result in the image', async () => {
  const { sent } = await startBlackjackGame(1000, {
    player: ['2♠', '2♥'], dealer: ['2♦', '2♣'], deck: Array(40).fill('A♠'),
  });
  let last = null;
  for (let i = 0; i < 11; i += 1) {
    const hit = makeInteraction({ customId: `bj:hit:${S}`, userId: S, message: sent });
    await click(hit);
    last = hit.log.editReply[0] || last;
  }
  assert.equal(economy.getBlackjack(S), undefined, 'the hand was resolved automatically on the 15th card');
  const text = collectText({ components: toPlain({ components: last.components }).components });
  assert.match(text, /La mesa se llenó \(15 cartas\)/);
  assert.match(text, /Cartas en mesa:\*\* 15\/15/);
  imageOf(last);
  assert.equal(db.getUser(S).cash, 50_000, 'push: the bet came back');
});

test('the natural blackjack is paid before the animation and drawn with its banner', async () => {
  resetPlayer(S, { cash: 50_000 });
  economy.endBlackjack(S);
  const seed = seedWhere((deal) => deal.natural);
  const original = Math.random;
  Math.random = lcg(seed);
  try {
    const message = makeMessage({ author: S, content: 'Xn blackjack 1000' });
    await settle(say(message));
    const sent = message.sentMessages[0];
    const text = collectText({ components: toPlain({ components: sent.payload.components }).components });
    assert.match(text, /¡Blackjack! \+1,500/);
    assert.equal(db.getUser(S).cash, 51_500, '2.5x payout credited');
    assert.equal(economy.getBlackjack(S), undefined);
    imageOf(sent.payload);
    assert.equal(buttonsOf({ components: sent.payload.components }).length, 0);
  } finally { Math.random = original; }
});

test('when the canvas is switched off or fails, blackjack falls back to the text board and stays playable', async () => {
  cfg.BLACKJACK_CANVAS = false;
  try {
    const { sent } = await startBlackjackGame();
    assert.equal((sent.payload.files || []).length, 0, 'no image attached');
    const text = collectText({ components: toPlain({ components: sent.payload.components }).components });
    assert.match(text, /┌────┐/, 'ASCII board is shown');
    assert.ok(buttonsOf({ components: sent.payload.components }).some((b) => b.custom_id === `bj:hit:${S}`));
    economy.endBlackjack(S);
  } finally { cfg.BLACKJACK_CANVAS = true; }

  // Si el render falla (estado inválido), se usa el tablero de texto y el juego sigue.
  const { sent, game } = await startBlackjackGame();
  const consoleError = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args.join(' '));
  try {
    game.bet = -1; // validateState lo rechazará
    const hit = makeInteraction({ customId: `bj:hit:${S}`, userId: S, message: sent });
    await click(hit);
    const edited = hit.log.editReply[0];
    assert.equal((edited.files || []).length, 0);
    assert.match(collectText({ components: toPlain({ components: edited.components }).components }), /┌────┐/);
    assert.ok(logged.some((line) => /canvas falló/i.test(line)));
  } finally { console.error = consoleError; }
  economy.endBlackjack(S);
});

test('the 150 s timer stands for the player, pays by the rules and redraws the final board once', async () => {
  const { sent } = await startBlackjackGame(1000, { player: ['10♠', '9♥'], dealer: ['10♦', '6♣'], deck: ['K♣'] });
  const editsBefore = sent.edits.length;
  mock.timers.tick(150_000);
  await waitFor(() => sent.edits.length > editsBefore);
  assert.equal(sent.edits.length, editsBefore + 1);
  const text = collectText({ components: toPlain({ components: sent.payload.components }).components });
  assert.match(text, /Se acabó el tiempo y te plantaste automáticamente/);
  assert.match(text, /¡Ganaste!/);
  imageOf(sent.payload);
  assert.equal(economy.getBlackjack(S), undefined);
  assert.equal(db.getUser(S).cash, 51_000);
});

test('every command that fails still answers with a Components V2 message (spot check)', async () => {
  resetPlayer(S, { cash: 0 });
  for (const content of ['Xn slots 100', 'Xn roulette 100 red', 'Xn wheel 100', 'Xn dice 100 3', 'Xn gamble 100', 'Xn blackjack 100', 'Xn crash 100 2', 'Xn pay', 'Xn give', 'Xn train x', 'Xn interest']) {
    const message = makeMessage({ author: S, content });
    await say(message);
    assert.ok(message.sentMessages.length >= 1, content);
    message.sentMessages.forEach((sent) => everyMessageIsV2(sent.payload));
  }
});
