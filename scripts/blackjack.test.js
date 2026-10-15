'use strict';

const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const {
  setupEnv, cleanupEnv, countComponents, collectText, toPlain, buttonsOf, seeded,
} = require('./_helpers');

const tempDir = setupEnv('blackjack');

const cfg = require('../config');
const db = require('../database');
const economy = require('../economy');
const ui = require('../ui');

before(async () => { await db.loadDB(); });
after(async () => { await db.closeDB(); cleanupEnv(tempDir); });

const MAX = cfg.BLACKJACK_MAX_CARDS;
const member = { id: '1', displayName: 'Jugadora', displayAvatarURL: () => 'https://cdn.example/a.png' };

let counter = 0;
function newPlayer(cash = 100_000) {
  counter += 1;
  const id = `70000000000000${String(counter).padStart(4, '0')}`;
  const user = db.getUser(id);
  user.cash = cash; user.bank = 0; user.effects = {}; user.weapons = []; user.equippedWeapon = null; user.cooldowns = {};
  return { id, user };
}

// Arma una partida con manos y baraja controladas (el último elemento de `deck` es la próxima carta).
function rig({ player, dealer, deck, bet = 1000, cash = 100_000 }) {
  const { id, user } = newPlayer(cash);
  const started = economy.startBlackjack(id, user, bet);
  assert.ok(started.game, `game started: ${started.error}`);
  const { game } = started;
  game.player = [...player];
  game.dealer = [...dealer];
  game.deck = [...deck];
  game.status = 'playing';
  game.resolution = null;
  return { id, user, game, cashAfterBet: user.cash };
}

test('the strict table limit is 15 cards between player and dealer', () => {
  assert.equal(cfg.BLACKJACK_MAX_CARDS, 15);
});

test('natural blackjack pays 2.5x the bet and ends immediately', () => {
  const { user, game, id } = rig({ player: ['A♠', 'K♥'], dealer: ['9♦', '7♣'], deck: ['2♣'] });
  game.status = 'stood';
  const resolution = economy.bjResolve(user, game);
  assert.equal(resolution.result, 'blackjack');
  assert.equal(resolution.payout, 2500);
  assert.equal(resolution.net, 1500);
  assert.equal(user.cash, 100_000 - 1000 + 2500);
  assert.equal(economy.getBlackjack(id), undefined, 'the game is removed once resolved');
});

test('a natural blackjack against a dealer blackjack is a push, not a win', () => {
  const { user, game } = rig({ player: ['A♠', 'K♥'], dealer: ['A♦', 'Q♣'], deck: [] });
  game.status = 'stood';
  const resolution = economy.bjResolve(user, game);
  assert.equal(resolution.result, 'push');
  assert.equal(resolution.payout, 1000);
  assert.equal(user.cash, 100_000);
});

test('startBlackjack deals 4 cards, deducts the bet once and refuses a second concurrent game', () => {
  const { id, user } = newPlayer(5000);
  const started = economy.startBlackjack(id, user, 1000);
  assert.equal(economy.bjCardsOnTable(started.game), 4);
  assert.ok(economy.bjCardsOnTable(started.game) <= MAX);
  assert.equal(user.cash, 4000);
  assert.equal(economy.startBlackjack(id, user, 1000).error, 'already_playing');
  assert.equal(user.cash, 4000, 'the rejected second game charged nothing');
  economy.endBlackjack(id);
});

test('push: equal totals return the bet exactly', () => {
  const { id, user } = rig({ player: ['10♠', '8♥'], dealer: ['10♦', '8♣'], deck: [] });
  const stood = economy.bjStand(id);
  assert.equal(stood.status, 'stood');
  const resolution = economy.bjResolve(user, stood);
  assert.equal(resolution.result, 'push');
  assert.equal(resolution.net, 0);
  assert.equal(user.cash, 100_000);
});

test('bust: going over 21 loses the bet and the hand cannot be played or paid again', () => {
  const { id, user, game } = rig({ player: ['10♠', '6♥'], dealer: ['10♦', '7♣'], deck: ['9♣'] });
  const hit = economy.bjHit(id);
  assert.equal(hit.status, 'bust');
  assert.equal(economy.bjHit(id), null, 'no more cards are dealt after a bust');
  const resolution = economy.bjResolve(user, game);
  assert.equal(resolution.result, 'lose');
  assert.equal(resolution.payout, 0);
  assert.equal(user.cash, 99_000);
  const again = economy.bjResolve(user, game);
  assert.equal(again, resolution, 'resolving twice returns the same resolution');
  assert.equal(user.cash, 99_000, 'and never pays twice');
  assert.equal(economy.bjHit(id), null);
  assert.equal(economy.bjStand(id), null);
});

test('win: dealer bust and higher total both pay 2x; a lower total loses', () => {
  const win = rig({ player: ['10♠', '9♥'], dealer: ['10♦', '6♣'], deck: ['K♣'] });
  const standWin = economy.bjStand(win.id);
  assert.equal(standWin.dealer.length, 3);
  const winResolution = economy.bjResolve(win.user, standWin);
  assert.equal(winResolution.result, 'win');
  assert.equal(winResolution.payout, 2000);
  assert.equal(win.user.cash, 100_000 + 1000);

  const lose = rig({ player: ['10♠', '7♥'], dealer: ['10♦', '9♣'], deck: [] });
  const loseResolution = economy.bjResolve(lose.user, economy.bjStand(lose.id));
  assert.equal(loseResolution.result, 'lose');
  assert.equal(lose.user.cash, 99_000);
});

test('the dealer keeps drawing to 17 while there is room on the table', () => {
  const { id } = rig({ player: ['10♠', '9♥'], dealer: ['2♦', '3♣'], deck: ['5♣', '4♦', '3♥'] });
  const game = economy.bjStand(id);
  assert.ok(economy.handValue(game.dealer) >= 17);
  assert.ok(economy.bjCardsOnTable(game) <= MAX);
});

// ---------- Límite de 15 cartas ----------

test('hitting is allowed up to the 15th card, then the hand closes by itself and no more cards can be drawn', () => {
  // Jugador 2+2, banca 2+2: todo "ases" en la baraja (nunca revientan: valen 1 al sumar tantas).
  const { id, user } = rig({
    player: ['2♠', '2♥'], dealer: ['2♦', '2♣'], deck: Array(40).fill('A♠'),
  });
  let game = economy.getBlackjack(id);
  let hits = 0;
  while (economy.bjCanHit(game)) {
    assert.ok(economy.bjCardsOnTable(game) < MAX, 'never starts a hit with a full table');
    game = economy.bjHit(id);
    hits += 1;
    assert.ok(economy.bjCardsOnTable(game) <= MAX, `table has ${economy.bjCardsOnTable(game)} cards`);
    assert.notEqual(game.status, 'bust');
  }
  assert.equal(hits, MAX - 4, 'exactly 11 hits fit on a 4-card start');
  assert.equal(economy.bjCardsOnTable(game), MAX);
  assert.equal(game.status, 'stood', 'the player auto-stands when the last card is placed');
  assert.equal(economy.bjHit(id), null, 'no more cards can be requested');
  assert.equal(economy.bjCardsOnTable(economy.getBlackjack(id)), MAX, 'the rejected hit added no card');
  assert.equal(economy.bjCanHit(game), false);

  // La banca (4 en mano, < 17) no pudo completar: empate seguro con apuesta devuelta.
  const resolution = economy.bjResolve(user, game);
  assert.equal(resolution.limitReached, true);
  assert.equal(resolution.dealerBlocked, true);
  assert.equal(resolution.result, 'push');
  assert.equal(resolution.payout, 1000);
  assert.equal(user.cash, 100_000);
  assert.equal(economy.getBlackjack(id), undefined);
});

test('a full table with a completed dealer hand resolves by comparing totals', () => {
  const { id, user } = rig({
    player: ['2♠', '2♥'], dealer: ['10♦', '8♣'], deck: Array(40).fill('A♠'),
  });
  let game = economy.getBlackjack(id);
  while (economy.bjCanHit(game)) game = economy.bjHit(id);
  assert.equal(economy.bjCardsOnTable(game), MAX);
  const resolution = economy.bjResolve(user, game);
  assert.equal(resolution.dealerBlocked, false, 'the dealer already had 18');
  assert.equal(resolution.limitReached, true);
  assert.equal(resolution.result, 'lose', '15 beats nobody against 18');
  assert.equal(user.cash, 99_000);
});

test('the dealer cannot draw past the limit when the player stands with a nearly full table', () => {
  const { id, user } = rig({
    player: Array(12).fill('A♠').map((card, i) => (i < 2 ? '2♠' : card)).slice(0, 12),
    dealer: ['2♦', '2♣'], deck: Array(40).fill('3♥'), bet: 500,
  });
  // 12 cartas del jugador + 2 de la banca = 14; solo cabe UNA carta más.
  assert.equal(economy.bjCardsOnTable(economy.getBlackjack(id)), 14);
  const game = economy.bjStand(id);
  assert.equal(economy.bjCardsOnTable(game), MAX, 'the dealer drew exactly one card and stopped at the limit');
  assert.ok(economy.handValue(game.dealer) < 17);
  const resolution = economy.bjResolve(user, game);
  assert.equal(resolution.dealerBlocked, true);
  assert.equal(resolution.result, 'push');
});

test('a hit on a full table never deals a card and closes the hand safely', () => {
  const { id } = rig({ player: Array(13).fill('A♠'), dealer: ['2♦', '2♣'], deck: ['9♥'] });
  const game = economy.getBlackjack(id);
  assert.equal(economy.bjCardsOnTable(game), MAX);
  assert.equal(economy.bjCanHit(game), false);
  const closed = economy.bjHit(id);
  assert.equal(economy.bjCardsOnTable(closed), MAX, 'no 16th card');
  assert.equal(closed.status, 'stood');
});

test('an exhausted deck never yields undefined cards', () => {
  const { id } = rig({ player: ['2♠', '2♥'], dealer: ['2♦', '2♣'], deck: [] });
  const game = economy.bjHit(id);
  assert.ok(game.player.every((card) => typeof card === 'string' && card.length >= 2));
  assert.equal(game.player.length, 3);
  assert.ok(!['2♠', '2♥', '2♦', '2♣'].includes(game.player[2]), 'a fresh deck excludes the cards already in play');
});

test('property: thousands of random games never exceed 15 cards, never pay twice and always conserve Candys', () => {
  const originalRandom = Math.random;
  Math.random = seeded(15151515);
  try {
    const random = seeded(99);
    let maxSeen = 0;
    for (let n = 0; n < 4000; n += 1) {
      const { id, user } = newPlayer(1_000_000);
      const bet = 1000;
      const start = economy.startBlackjack(id, user, bet);
      let { game } = start;
      const appetite = random();
      let guard = 0;
      while (game.status === 'playing' && guard < 40) {
        guard += 1;
        if (random() < 0.15 + appetite * 0.8) game = economy.bjHit(id) || game;
        else game = economy.bjStand(id);
        assert.ok(economy.bjCardsOnTable(game) <= MAX);
        game.player.concat(game.dealer).forEach((card) => assert.equal(typeof card, 'string'));
      }
      if (game.status === 'playing') game = economy.bjStand(id);
      maxSeen = Math.max(maxSeen, economy.bjCardsOnTable(game));
      const resolution = economy.bjResolve(user, game);
      const again = economy.bjResolve(user, game);
      assert.equal(again, resolution);
      assert.equal(user.cash, 1_000_000 - bet + resolution.payout, 'cash change equals payout minus bet, exactly once');
      assert.ok(['win', 'lose', 'push', 'blackjack'].includes(resolution.result));
      assert.equal(economy.getBlackjack(id), undefined);
      assert.ok(Number.isSafeInteger(user.cash));
    }
    assert.ok(maxSeen <= MAX);
  } finally { Math.random = originalRandom; }
});

test('owner-sized balances: a bet whose maximum payout would overflow is rejected before any card is dealt', () => {
  const { id, user } = newPlayer(Number.MAX_SAFE_INTEGER - 10_000);
  const start = economy.startBlackjack(id, user, Number.MAX_SAFE_INTEGER - 10_000);
  assert.equal(start.error, 'balance_limit', 'a bet whose max payout would overflow is rejected before any card is dealt');
  assert.equal(user.cash, Number.MAX_SAFE_INTEGER - 10_000);
  assert.equal(economy.getBlackjack(id), undefined);
});

// ---------- Interfaz ----------

test('a 15-card table renders inside Discord limits, shows the counter and wraps long hands', () => {
  const game = {
    deck: [], player: ['2♠', '2♥', 'A♠', 'A♥', 'A♦', 'A♣', '3♠', '3♥', '3♦', '4♣', '4♠', '5♥', '5♦'], dealer: ['2♦', '2♣'], bet: 1234, status: 'stood',
  };
  const c = ui.blackjackCard(cfg, member, game, { hideDealer: false, footer: 'Fin', quip: ui.blackjackQuip('limit') });
  const view = ui.payload(c);
  const plain = toPlain(view);
  assert.ok(countComponents(plain) <= 40);
  const text = collectText(view);
  assert.ok(text.length <= 4000, `text length ${text.length}`);
  assert.match(text, /Cartas en mesa:\*\* 15\/15/);
  const rows = text.split('\n').filter((line) => line.includes('┌────┐'));
  assert.ok(rows.every((line) => line.split('┌────┐').length - 1 <= 5), 'at most 5 cards per visual row');
  assert.ok(rows.length >= 4, 'a 13-card hand uses 3 rows plus the dealer row');
});

test('the Hit button announces the last card and every blackjack button is locked to the player', () => {
  const nearlyFull = { player: Array(12).fill('2♠'), dealer: ['2♦', '2♣'], deck: [], bet: 1, status: 'playing' };
  const normal = { player: ['2♠', '2♥'], dealer: ['2♦', '2♣'], deck: [], bet: 1, status: 'playing' };
  const lastButtons = buttonsOf({ components: [ui.blackjackButtons('42', false, nearlyFull, MAX)] });
  const normalButtons = buttonsOf({ components: [ui.blackjackButtons('42', false, normal, MAX)] });
  assert.match(lastButtons[0].label, /última carta/i);
  assert.equal(normalButtons[0].label, 'Pedir');
  for (const button of [...lastButtons, ...normalButtons]) assert.match(button.custom_id, /^bj:(hit|stand):42$/);
  const disabled = buttonsOf({ components: [ui.blackjackButtons('42', true, normal, MAX)] });
  assert.ok(disabled.every((button) => button.disabled === true));
});

test('the dealing frame and the quips are plain Components V2 content without mentions', () => {
  const view = ui.blackjackDealingCard(cfg, member, 500);
  const plain = toPlain(view);
  assert.equal(plain.flags & 32768, 32768);
  assert.deepEqual(plain.allowedMentions, { parse: [] });
  assert.match(collectText(view), /Repartiendo|reparte/i);
  for (const kind of Object.keys(ui.BLACKJACK_QUIPS)) {
    assert.ok(ui.blackjackQuip(kind, () => 0).length > 0);
    assert.ok(ui.blackjackQuip(kind, () => 0.9999).length > 0);
  }
  assert.equal(ui.blackjackQuip('desconocido'), '');
});
