'use strict';

const assert = require('node:assert/strict');
const { after, before, beforeEach, test } = require('node:test');
const {
  setupEnv, cleanupEnv, countComponents, collectText, toPlain,
} = require('./_helpers');

const tempDir = setupEnv('owner');

const cfg = require('../config');
const db = require('../database');
const economy = require('../economy');
const ui = require('../ui');
const trade = require('../trade');

before(async () => { await db.loadDB(); });
after(async () => { await db.closeDB(); cleanupEnv(tempDir); });
beforeEach(() => { trade.reset(); });

const OWNER = cfg.OWNER_ID;
const member = (id, displayName = 'Alguien') => ({ id, displayName, displayAvatarURL: () => 'https://cdn.example/avatar.png' });

function seedUsers(count, startTotal = 1000) {
  const ids = [];
  for (let i = 0; i < count; i += 1) {
    const id = `5${String(i).padStart(17, '0')}`;
    const user = db.getUser(id);
    user.cash = startTotal + i * 10;
    user.bank = 0;
    user.debt = 0;
    ids.push(id);
  }
  return ids;
}

// ---------- Rankings sin owner ----------

test('the owner never appears in the rich or debt leaderboards and does not shift positions', () => {
  const ids = seedUsers(120);
  const ownerData = db.getUser(OWNER);
  ownerData.cash = 5_000_000;
  ownerData.bank = 9_000_000;
  ownerData.debt = 777_777;

  const rich = economy.getLeaderboard(100);
  assert.equal(rich.length, 100, 'pagination still has 100 entries after excluding the owner');
  assert.ok(rich.every((entry) => entry.id !== OWNER));
  assert.equal(rich[0].id, ids[119], 'the richest regular player is first');
  assert.equal(Math.ceil(rich.length / 10), 10, 'still exactly 10 pages');
  const debt = economy.getDebtLeaderboard(100);
  assert.ok(debt.every((entry) => entry.id !== OWNER));

  // Posiciones idénticas con y sin owner de 1ª fortuna.
  ownerData.cash = 0; ownerData.bank = 0; ownerData.debt = 0;
  const withoutOwnerWealth = economy.getLeaderboard(100).map((e) => e.id);
  ownerData.cash = 9_000_000_000_000;
  assert.deepEqual(economy.getLeaderboard(100).map((e) => e.id), withoutOwnerWealth);
});

test('rank is computed without the owner and agrees with the leaderboard order (ties included)', () => {
  const ids = seedUsers(40, 2000);
  db.getUser(ids[5]).cash = db.getUser(ids[6]).cash; // empate
  db.getUser(OWNER).cash = 99_999_999;
  const board = economy.getLeaderboard(Infinity);
  assert.ok(board.length >= 40);
  board.forEach((entry, index) => assert.equal(economy.getRank(entry.id), index + 1, `rank of ${entry.id}`));
  assert.equal(economy.getRank(OWNER), null, 'the owner has no rank');
  assert.equal(economy.getRank('profile-that-does-not-exist'), board.length + 1);
});

test('serverstats highlights the richest regular player, never the owner', () => {
  seedUsers(5);
  db.getUser(OWNER).cash = 1_000_000_000;
  const stats = economy.getServerStats();
  assert.notEqual(stats.richestId, OWNER);
  assert.ok(stats.richestId);
});

// ---------- Intocable ----------

test('the owner cannot be robbed or targeted by a bounty, and failed attempts cost nothing', () => {
  const thief = db.getUser('600000000000000001');
  thief.cash = 10_000;
  thief.cooldowns = {};
  thief.cooldownCycles = {};
  const owner = db.getUser(OWNER);
  owner.cash = 50_000;
  const ownerBefore = JSON.stringify(owner);
  const thiefBefore = JSON.stringify(thief);

  const rob = economy.attemptRob(thief, owner);
  assert.equal(rob.error, 'target_owner');
  const bounty = economy.placeBounty(thief, owner, 5_000);
  assert.equal(bounty.error, 'target_owner');
  assert.equal(JSON.stringify(owner), ownerBefore, 'the owner profile is untouched');
  assert.equal(JSON.stringify(thief), thiefBefore, 'no cooldown consumed and no money spent by the attacker');
  assert.equal(economy.isTheftProtected(OWNER), true);
  assert.equal(economy.isTheftProtected(owner), true);
  assert.equal(economy.isTheftProtected('600000000000000001'), false);
  assert.equal(economy.isTheftProtected(thief), false);
});

test('regular players can still be robbed and receive bounties (the protection is owner-only)', () => {
  const thief = db.getUser('600000000000000011');
  const victim = db.getUser('600000000000000012');
  thief.cash = 10_000; thief.cooldowns = {}; thief.cooldownCycles = {};
  victim.cash = 50_000; victim.cooldowns = {}; victim.effects = {};
  const bounty = economy.placeBounty(thief, victim, cfg.BOUNTY_MIN);
  assert.ok(!bounty.error, `bounty should work: ${bounty.error}`);
  const original = Math.random;
  Math.random = () => 0;
  try {
    const rob = economy.attemptRob(thief, victim);
    assert.notEqual(rob.error, 'target_owner');
  } finally { Math.random = original; }
});

// ---------- ∞ solo visual ----------

test('balance and profile views show ∞ for Cash, Bank and Total of the owner and real numbers for everyone else', () => {
  const owner = db.getUser(OWNER);
  owner.cash = 123_456;
  owner.bank = 654_321;
  owner.debt = 4_242;
  const ownerText = collectText(ui.balanceCard(cfg, member(OWNER, 'Dueño'), owner, { rank: null, activeCount: 0, nextGoal: { name: 'KING', missing: 1 } }));
  assert.equal((ownerText.match(/∞/g) || []).length >= 3, true);
  assert.match(ownerText, /Cash:\*\* ∞/);
  assert.match(ownerText, /Bank:\*\* ∞/);
  assert.match(ownerText, /Total:\*\* ∞/);
  assert.ok(!ownerText.includes('123,456') && !ownerText.includes('654,321') && !ownerText.includes('777,777'), 'real values never leak');
  assert.match(ownerText, /fuera del ranking global/);
  assert.ok(!/KING/.test(ownerText), 'no "next goal" for the owner');

  const profileText = collectText(ui.profileCard(cfg, member(OWNER, 'Dueño'), owner, null, []));
  assert.match(profileText, /Cash:\*\* ∞/);
  assert.match(profileText, /Bank:\*\* ∞/);
  assert.match(profileText, /Total:\*\* ∞/);
  assert.match(profileText, /Dueño del bot/);
  assert.ok(!profileText.includes('123,456'));

  const regular = db.getUser('600000000000000021');
  regular.cash = 1_234;
  regular.bank = 5_678;
  const regularText = collectText(ui.balanceCard(cfg, member('600000000000000021', 'Ana'), regular, { rank: 3, activeCount: 0, nextGoal: null }));
  assert.ok(!regularText.includes('∞'));
  assert.match(regularText, /1,234/);
  assert.match(regularText, /5,678/);
  assert.match(regularText, /#3/);
  assert.equal(ui.formatBalance(cfg, OWNER, 10), '∞');
  assert.equal(ui.formatBalance(cfg, member(OWNER), 10), '∞');
  assert.equal(ui.formatBalance(cfg, '600000000000000021', 1000), '1,000');
});

test('infinity is only drawn: the stored profile never contains Infinity, NaN or unsafe numbers', () => {
  const owner = db.getUser(OWNER);
  owner.cash = 1_000_000;
  owner.bank = 2_000_000;
  ui.balanceCard(cfg, member(OWNER), owner, { rank: null, activeCount: 0, nextGoal: null });
  ui.profileCard(cfg, member(OWNER), owner, null, []);
  const raw = JSON.stringify(owner);
  assert.ok(!/Infinity|NaN|∞|null/.test(raw.replace(/"(class|equippedWeapon|activeQuest)":null/g, '')));
  for (const key of ['cash', 'bank', 'debt', 'xp']) assert.ok(Number.isSafeInteger(owner[key]));
});

test('corrupt or unsafe stored numbers are repaired instead of being saved', () => {
  const user = db.getUser('600000000000000031');
  user.cash = Infinity;
  user.bank = Number.NaN;
  user.debt = 1e300;
  user.xp = -50;
  const repaired = db.getUser('600000000000000031');
  assert.equal(repaired.cash, 0);
  assert.equal(repaired.bank, 0);
  assert.equal(repaired.debt, Number.MAX_SAFE_INTEGER);
  assert.equal(repaired.xp, 0);
  repaired.cash = Number.MAX_SAFE_INTEGER * 4;
  assert.equal(db.getUser('600000000000000031').cash, Number.MAX_SAFE_INTEGER);
  assert.equal(db.clampBalance(Infinity), 0);
  assert.equal(db.clampBalance(Number.NaN), 0);
  assert.equal(db.clampBalance(-1), 0);
});

// ---------- El owner usa el dinero sin corromper nada ----------

test('owner purchases deduct exactly from finite stored balances and respect insufficient funds', () => {
  const owner = db.getUser(OWNER);
  owner.cash = 1_000_000;
  owner.debt = 0;
  owner.inventory = {};
  const potion = cfg.POTIONS[0];
  const bought = economy.buyPotion(owner, potion.id, 3);
  assert.ok(!bought.error);
  assert.equal(owner.cash, 1_000_000 - potion.price * 3);
  assert.equal(owner.inventory[potion.id], 3);
  owner.cash = 10;
  assert.ok(economy.buyPotion(owner, potion.id, 1).error, 'the ∞ display does not grant spending power');
  assert.equal(owner.cash, 10);
});

test('owner bets (all-in) in every casino game keep finite, safe stored balances', () => {
  const owner = db.getUser(OWNER);
  for (const game of ['gamble', 'slots', 'dice', 'roulette', 'wheel', 'crash', 'blackjack']) {
    owner.cash = Number.MAX_SAFE_INTEGER - 1_000;
    owner.cooldowns = {}; owner.cooldownCycles = {}; owner.effects = {};
    const bet = owner.cash;
    let result;
    if (game === 'gamble') result = economy.gamble(owner, bet);
    if (game === 'slots') result = economy.slots(owner, bet);
    if (game === 'dice') result = economy.playDice(owner, bet, 3);
    if (game === 'roulette') result = economy.playRoulette(owner, bet, 'rojo');
    if (game === 'wheel') result = economy.playWheel(owner, bet);
    if (game === 'crash') result = economy.playCrash(owner, bet, 2);
    if (game === 'blackjack') {
      result = economy.startBlackjack(OWNER, owner, bet);
      economy.endBlackjack(OWNER);
    }
    assert.ok(Number.isSafeInteger(owner.cash), `${game}: cash stays a safe integer (${owner.cash})`);
    assert.ok(owner.cash >= 0);
    assert.ok(!/Infinity|NaN/.test(JSON.stringify(owner)));
    assert.ok(result, `${game} returned something`);
  }
  // Una apuesta con premio que desbordaría se rechaza SIN gastar cooldown.
  owner.cash = Number.MAX_SAFE_INTEGER - 1_000;
  owner.cooldowns = {}; owner.cooldownCycles = {};
  const wheel = economy.playWheel(owner, owner.cash, () => 0.99);
  if (wheel.error) {
    assert.equal(wheel.error, 'balance_limit');
    assert.equal(owner.cooldowns.wheel, undefined, 'no cooldown use was consumed');
    assert.equal(owner.cash, Number.MAX_SAFE_INTEGER - 1_000);
  }
});

test('owner transfers in both directions conserve Candys and never overflow', () => {
  const owner = db.getUser(OWNER);
  const friend = db.getUser('600000000000000041');
  owner.cash = 1_000_000;
  friend.cash = 500;
  const total = owner.cash + friend.cash;
  assert.deepEqual(economy.transfer(owner, friend, 250_000), { amount: 250_000 });
  assert.deepEqual(economy.transfer(friend, owner, 1_000), { amount: 1_000 });
  assert.equal(owner.cash + friend.cash, total);
  assert.equal(economy.transfer(friend, owner, 10 ** 12).error, 'insufficient');
  owner.cash = Number.MAX_SAFE_INTEGER - 5;
  friend.cash = 100;
  assert.equal(economy.transfer(friend, owner, 100).error, 'balance_limit');
  assert.equal(friend.cash, 100);
  assert.equal(owner.cash, Number.MAX_SAFE_INTEGER - 5);
  assert.equal(economy.transfer(owner, owner, 5).error, 'invalid');
});

test('the owner can still rob others: only finite, safe values are written', () => {
  const owner = db.getUser(OWNER);
  const victim = db.getUser('600000000000000051');
  owner.cash = 1_000; owner.cooldowns = {}; owner.cooldownCycles = {}; owner.effects = {};
  victim.cash = 40_000; victim.cooldowns = {}; victim.effects = {};
  const original = Math.random;
  Math.random = () => 0;
  try {
    const result = economy.attemptRob(owner, victim);
    assert.ok(result.success);
  } finally { Math.random = original; }
  assert.ok(Number.isSafeInteger(owner.cash) && Number.isSafeInteger(victim.cash));
  assert.equal(owner.cash + victim.cash, 41_000);
});

test('the owner can trade like anyone: trades move real finite stored values', () => {
  const owner = db.getUser(OWNER);
  const buyer = db.getUser('600000000000000061');
  owner.cash = 10; owner.materials = { amber_dust: 5 };
  buyer.cash = 20_000; buyer.materials = {};
  const created = trade.createOffer({
    sellerId: OWNER, seller: owner, recipientId: '600000000000000061', recipient: buyer, itemQuery: 'amber_dust', qtyToken: '5', priceToken: '8000',
  });
  assert.ok(created.offer);
  assert.equal(trade.respond(created.offer.id, '600000000000000061', 'accept').status, 'accepted');
  assert.equal(owner.cash, 8010);
  assert.equal(buyer.materials.amber_dust, 5);
  // Y puede comprar: su ∞ visual no le da Cash que no tiene.
  owner.cash = 100;
  const sell = trade.createOffer({
    sellerId: '600000000000000061', seller: buyer, recipientId: OWNER, recipient: owner, itemQuery: 'amber_dust', qtyToken: '1', priceToken: '800',
  });
  assert.equal(sell.error, 'recipient_insufficient');
});

// ---------- Interfaz ----------

test('the leaderboard view for the first page never lists the owner and stays within component limits', () => {
  seedUsers(30);
  db.getUser(OWNER).cash = 10 ** 12;
  const entries = economy.getLeaderboard(100).map((entry) => ({ ...entry, name: `Jugador ${entry.id.slice(-3)}` }));
  const view = ui.leaderboardContainer(cfg, 'rich', 0, entries.slice(0, 10), '1');
  const plain = toPlain(view);
  assert.ok(countComponents(plain) <= 40);
  assert.ok(!JSON.stringify(plain).includes(OWNER));
  assert.deepEqual(plain.allowedMentions, { parse: [] });
});
