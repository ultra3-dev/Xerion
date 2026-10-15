'use strict';

const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const {
  setupEnv, cleanupEnv, countComponents, collectText, toPlain, rngForIndex, rngSequence, seeded,
} = require('./_helpers');

const tempDir = setupEnv('casino');

const cfg = require('../config');
const db = require('../database');
const economy = require('../economy');
const casinoView = require('../casino-view');
const ui = require('../ui');

before(async () => { await db.loadDB(); });
after(async () => { await db.closeDB(); cleanupEnv(tempDir); });

let counter = 0;
function player(cash = 10_000_000) {
  counter += 1;
  const user = db.getUser(`80000000000000${String(counter).padStart(4, '0')}`);
  user.cash = cash; user.bank = 0; user.effects = {}; user.weapons = []; user.equippedWeapon = null; user.class = null;
  user.cooldowns = {}; user.cooldownCycles = {};
  return user;
}

const fmt = db.fmt;
const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const everyMessageIsV2 = (view) => {
  const plain = toPlain(view);
  assert.equal(plain.flags & 32768, 32768, 'IsComponentsV2 flag');
  assert.equal(plain.content, undefined, 'Components V2 messages carry no plain content');
  assert.deepEqual(plain.allowedMentions, { parse: [] }, 'no pings');
  assert.ok(countComponents(plain) <= 40, `${countComponents(plain)} components`);
  assert.ok(collectText(view).length <= 4000);
};

// ---------- Rueda de la fortuna ----------

test('wheel: for EVERY segment the animation stops on the drawn segment and the card, multiplier and payout agree', () => {
  const weights = cfg.WHEEL_SEGMENTS.map((s) => s.weight);
  const bet = 10_000;
  cfg.WHEEL_SEGMENTS.forEach((segment, index) => {
    const user = player();
    const result = economy.playWheel(user, bet, rngForIndex(weights, index));
    assert.equal(result.segmentIndex, index);
    assert.equal(result.multiplier, segment.mult);
    assert.equal(result.payout, Math.round(bet * segment.mult));
    assert.equal(result.net, result.payout - bet);
    assert.equal(user.cash, 10_000_000 - bet + result.payout, 'the stored balance matches the paid result');

    const plan = casinoView.wheelPlan(result);
    assert.equal(plan.positions.at(-1), index, 'the last animation position is the drawn segment');
    assert.equal(plan.finalLabel, `x${segment.mult}`);
    for (let k = 1; k < plan.positions.length; k += 1) {
      assert.equal(plan.positions[k], (plan.positions[k - 1] + 1) % cfg.WHEEL_SEGMENTS.length, 'the pointer advances one slice per frame');
    }

    const lastFrame = ui.wheelSpinCard(cfg, bet, plan.positions.at(-1), { final: true });
    const lastText = collectText(lastFrame);
    assert.equal((lastText.match(/🔻/g) || []).length, 1);
    assert.match(lastText, new RegExp(`🔻 x${escapeRegExp(segment.mult)}(\\s|$)`), 'the pointer sits on the drawn multiplier');
    everyMessageIsV2(lastFrame);

    const resultView = ui.wheelResultCard(cfg, bet, result);
    const resultText = collectText(resultView);
    assert.ok(resultText.split('\n')[0].includes(`x${segment.mult}`), 'the result title shows the same multiplier');
    if (result.payout > bet) assert.ok(resultText.includes(`+${fmt(result.net)}`));
    else if (result.payout === bet) assert.match(resultText, /Recuperaste/);
    else assert.ok(resultText.includes(`-${fmt(bet - result.payout)}`));
    everyMessageIsV2(resultView);
  });
});

test('wheel regression: a drawn x0.5 can never be shown as x1 in the animation or the result', () => {
  const weights = cfg.WHEEL_SEGMENTS.map((s) => s.weight);
  const halfIndex = cfg.WHEEL_SEGMENTS.findIndex((s) => s.mult === 0.5);
  const oneIndex = cfg.WHEEL_SEGMENTS.findIndex((s) => s.mult === 1);
  assert.ok(halfIndex >= 0 && oneIndex >= 0);
  const user = player();
  const result = economy.playWheel(user, 1000, rngForIndex(weights, halfIndex));
  assert.equal(result.multiplier, 0.5);
  assert.equal(result.payout, 500);
  const plan = casinoView.wheelPlan(result);
  const finalSpin = collectText(ui.wheelSpinCard(cfg, 1000, plan.positions.at(-1), { final: true }));
  assert.match(finalSpin, /🔻 x0\.5(\s|$)/);
  assert.ok(!/🔻 x1(\s|$)/.test(finalSpin));
  const resultText = collectText(ui.wheelResultCard(cfg, 1000, result));
  assert.match(resultText.split('\n')[0], /x0\.5$/);
  assert.ok(!/x1(\s|$)/.test(resultText.split('\n')[0]));
  // El plan jamás pasa por "x1" como posición final aunque x1 esté en la rueda.
  assert.notEqual(plan.positions.at(-1), oneIndex);
});

test('wheel: thousands of random draws always end exactly where they were paid', () => {
  const rng = seeded(31337);
  for (let n = 0; n < 3000; n += 1) {
    const user = player();
    const bet = 100 + Math.floor(rng() * 5000);
    const result = economy.playWheel(user, bet, rng);
    const plan = casinoView.wheelPlan(result);
    assert.equal(cfg.WHEEL_SEGMENTS[plan.finalPosition].mult, result.multiplier);
    assert.equal(plan.positions.at(-1), result.segmentIndex);
    assert.equal(result.payout, Math.round(bet * result.multiplier * result.bonusFactor));
  }
});

test('the wheel plan refuses to build from an inconsistent result', () => {
  const user = player();
  const result = economy.playWheel(user, 1000, rngForIndex(cfg.WHEEL_SEGMENTS.map((s) => s.weight), 0));
  assert.throws(() => casinoView.wheelPlan({ ...result, multiplier: 99 }), /no coincide/);
  assert.throws(() => casinoView.wheelPlan({ ...result, segmentIndex: 99 }), /no coincide/);
  assert.throws(() => casinoView.spinPositions(6, 6), RangeError);
  assert.throws(() => casinoView.spinPositions(0, 0), RangeError);
});

// ---------- Ruleta ----------

test('roulette: for EVERY colour the animation stops on the landed colour and the card and payout agree (win and loss)', () => {
  const weights = cfg.ROULETTE_COLORS.map((c) => c.weight);
  const bet = Math.max(cfg.ROULETTE_MIN_BET, 5000);
  for (const choice of ['rojo', 'negro', 'morado', 'verde']) {
    cfg.ROULETTE_COLORS.forEach((landed, index) => {
      const user = player();
      const result = economy.playRoulette(user, bet, choice, rngForIndex(weights, index));
      assert.equal(result.landedIndex, index);
      assert.equal(result.landed, landed.id);
      assert.equal(result.win, landed.id === choice);
      assert.equal(result.multiplier, result.win ? landed.mult : 0);
      assert.equal(result.payout, result.win ? Math.round(bet * landed.mult) : 0);
      assert.equal(user.cash, 10_000_000 - bet + result.payout);

      const plan = casinoView.roulettePlan(result);
      assert.equal(plan.positions.at(-1), index);
      assert.equal(plan.finalLabel, landed.label);

      const lastFrame = ui.rouletteSpinCard(cfg, bet, plan.positions.at(-1), { final: true });
      const lastText = collectText(lastFrame);
      assert.ok(lastText.includes(`🔻 ${landed.label}`), `pointer on ${landed.label}`);
      assert.equal((lastText.match(/🔻/g) || []).length, 1);
      everyMessageIsV2(lastFrame);

      const resultView = ui.rouletteResultCard(cfg, bet, choice, result);
      const resultText = collectText(resultView);
      assert.ok(resultText.split('\n')[0].includes(`cayó en ${landed.label} (x${landed.mult})`));
      if (result.win) assert.ok(resultText.includes(`+${fmt(result.net)}`));
      else assert.ok(resultText.includes(`-${fmt(bet)}`));
      everyMessageIsV2(resultView);
    });
  }
});

test('roulette keeps rejecting invalid colours and bets without spending a cooldown use', () => {
  const user = player();
  assert.equal(economy.playRoulette(user, cfg.ROULETTE_MIN_BET - 1, 'rojo').error, 'invalid');
  assert.equal(economy.playRoulette(user, cfg.ROULETTE_MIN_BET, 'calabaza').error, 'invalid_color');
  assert.equal(economy.playRoulette(user, cfg.ROULETTE_MIN_BET, 'azul').error, 'invalid_color');
  assert.equal(economy.playRoulette(user, 10 ** 12, 'rojo').error, 'insufficient');
  assert.deepEqual(user.cooldowns, {});
  assert.deepEqual(user.cooldownCycles, {});
});

// ---------- Tragamonedas ----------

test('slots: every combination reveals reel by reel and ends on the paid reels with the same multiplier', () => {
  const symbols = cfg.SLOTS_SYMBOLS;
  const weights = symbols.map((s) => s.weight);
  const total = weights.reduce((a, b) => a + b, 0);
  const valueFor = (i) => (weights.slice(0, i).reduce((a, b) => a + b, 0) + weights[i] / 2) / total;
  const bet = 1000;
  let combos = 0;
  for (let a = 0; a < symbols.length; a += 1) {
    for (let b = 0; b < symbols.length; b += 1) {
      for (let c = 0; c < symbols.length; c += 1) {
        combos += 1;
        const user = player();
        const result = economy.slots(user, bet, rngSequence([valueFor(a), valueFor(b), valueFor(c)]));
        assert.deepEqual(result.reels, [symbols[a].symbol, symbols[b].symbol, symbols[c].symbol]);
        const [x, y, z] = result.reels;
        let expectedMult = 0;
        let expectedKind = 'none';
        if (x === y && y === z) {
          expectedKind = cfg.SLOTS_RARE_SYMBOLS.includes(x) ? 'triple_rare' : 'triple';
          expectedMult = expectedKind === 'triple_rare' ? cfg.SLOTS_TRIPLE_RARE_MULT : cfg.SLOTS_TRIPLE_MULT;
        } else if (x === y || y === z || x === z) { expectedKind = 'double'; expectedMult = cfg.SLOTS_DOUBLE_MULT; }
        assert.equal(result.multiplier, expectedMult);
        assert.equal(result.kind, expectedKind);
        assert.equal(result.payout, Math.round(bet * expectedMult));
        assert.equal(user.cash, 10_000_000 - bet + result.payout);

        const plan = casinoView.slotsPlan(result);
        assert.deepEqual(plan.final, result.reels);
        plan.frames.forEach((frame, k) => {
          frame.forEach((symbol, i) => assert.ok(symbol === '🌀' || symbol === result.reels[i], `frame ${k} never invents a symbol`));
          assert.equal(frame.filter((s) => s !== '🌀').length, k, 'one more reel stops per frame');
        });

        const finalView = ui.slotsFrame(cfg, plan.final, {
          spinning: false, payout: result.payout, bet, multiplier: result.multiplier, kind: result.kind, bonusFactor: result.bonusFactor,
        });
        const text = collectText(finalView);
        assert.ok(text.includes(result.reels.join('   ')));
        assert.ok(text.includes(`x${expectedMult}`), 'the displayed multiplier is the paid multiplier');
        if (result.payout > bet) assert.ok(text.includes(`+${fmt(result.net)}`));
        else if (result.payout === bet) assert.match(text, /Recuperaste/);
        else assert.ok(text.includes(`-${fmt(bet)}`));
        everyMessageIsV2(finalView);
      }
    }
  }
  assert.equal(combos, symbols.length ** 3);
});

test('slots: the bonus multiplier is shown and included in the payout', () => {
  const user = player();
  user.effects = { pumpkin: { expiresAt: Date.now() + 60_000 } };
  const bonus = economy.casinoBonusFactor(user);
  if (bonus > 1) {
    const result = economy.slots(user, 1000, () => 0);
    assert.equal(result.payout, Math.round(1000 * result.multiplier * bonus));
    const text = collectText(ui.slotsFrame(cfg, result.reels, {
      spinning: false, payout: result.payout, bet: 1000, multiplier: result.multiplier, kind: result.kind, bonusFactor: result.bonusFactor,
    }));
    assert.match(text, /bono \+\d+%/);
  } else {
    assert.equal(bonus, 1);
  }
});

// ---------- Crash ----------

test('crash point distribution: boundaries, cap and a 96% return for every target', () => {
  assert.equal(economy.drawCrashPoint(() => 0), 1);
  assert.equal(economy.drawCrashPoint(() => 0.03), 1, 'below 1.00 collapses to an instant crash');
  assert.equal(economy.drawCrashPoint(() => 0.5), 1.92);
  assert.equal(economy.drawCrashPoint(() => 0.75), 3.84);
  assert.equal(economy.drawCrashPoint(() => 0.9), 9.6);
  assert.equal(economy.drawCrashPoint(() => 0.999999999999), cfg.CRASH_MAX_MULTIPLIER);

  const rng = seeded(424242);
  const draws = [];
  for (let i = 0; i < 400_000; i += 1) draws.push(Math.round(economy.drawCrashPoint(rng) * 100));
  for (const [target, tolerance] of [[1.1, 0.01], [1.5, 0.01], [2, 0.01], [5, 0.015], [10, 0.025], [50, 0.06]]) {
    const cents = Math.round(target * 100);
    const wins = draws.filter((value) => value >= cents).length / draws.length;
    const rtp = wins * target;
    assert.ok(Math.abs(rtp - (1 - cfg.CRASH_HOUSE_EDGE)) < tolerance, `target x${target}: RTP ${rtp.toFixed(4)}`);
  }
});

test('crash targets are parsed strictly (1.10–50.00, at most two decimals)', () => {
  for (const [input, expected] of [['2', 2], ['2.5', 2.5], ['2,5', 2.5], ['2.50', 2.5], ['x2.5', 2.5], ['2.5x', 2.5], ['1.1', 1.1], ['50', 50], ['1.10', 1.1], ['49.99', 49.99]]) {
    assert.equal(economy.parseCrashTarget(input), expected, String(input));
  }
  for (const input of ['1.09', '1', '0', '-2', '50.01', '51', 'abc', '2.555', '', undefined, null, '1e1', 'Infinity', 'NaN', '2..5']) {
    assert.equal(economy.parseCrashTarget(input), null, String(input));
  }
});

test('crash: a crash equal to the target wins, one cent lower loses, and the payout is exact', () => {
  const rngForCrash = (cents) => { const raw = (cents + 0.5) / 100; const r = 1 - (1 - cfg.CRASH_HOUSE_EDGE) / raw; return () => r; };
  const bet = 1000;

  let user = player();
  let result = economy.playCrash(user, bet, 2, rngForCrash(200));
  assert.equal(result.crashCents, 200);
  assert.equal(result.win, true);
  assert.equal(result.payout, 2000);
  assert.equal(result.net, 1000);
  assert.equal(user.cash, 10_000_000 + 1000);

  user = player();
  result = economy.playCrash(user, bet, 2.01, rngForCrash(200));
  assert.equal(result.crashCents, 200);
  assert.equal(result.win, false);
  assert.equal(result.payout, 0);
  assert.equal(user.cash, 10_000_000 - bet);

  user = player();
  result = economy.playCrash(user, bet, 2.5, rngForCrash(100));
  assert.equal(result.crashCents, 100);
  assert.equal(result.win, false, 'an instant crash at x1.00 always loses (minimum target is x1.10)');
});

test('crash: the animation ends exactly at the drawn crash point and the card repeats the same numbers', () => {
  const rng = seeded(555);
  for (let n = 0; n < 500; n += 1) {
    const user = player();
    const target = [1.1, 1.5, 2, 3.33, 10, 50][n % 6];
    const bet = 100 + (n % 7) * 100;
    const result = economy.playCrash(user, bet, target, rng);
    assert.equal(result.win, result.crashCents >= result.targetCents);
    assert.equal(result.payout, result.win ? Math.round((bet * result.targetCents) / 100) : 0);
    assert.equal(user.cash, 10_000_000 - bet + result.payout);

    const plan = casinoView.crashPlan(result);
    assert.equal(plan.finalValue, result.crashCents / 100);
    let previous = 1;
    for (const value of plan.frames) {
      assert.ok(value >= previous && value <= plan.finalValue, 'frames climb monotonically and never exceed the crash');
      previous = value;
    }
    const crashText = `x${(result.crashCents / 100).toFixed(2)}`;
    const targetText = `x${(result.targetCents / 100).toFixed(2)}`;
    const flight = ui.crashFlightCard(cfg, bet, result.targetCents, plan.finalValue, { crashed: true });
    assert.ok(collectText(flight).includes(`🧹 ${crashText}`));
    const card = ui.crashResultCard(cfg, bet, result);
    const text = collectText(card);
    assert.ok(text.split('\n')[0].includes(crashText));
    assert.ok(text.includes(targetText));
    if (result.win) assert.ok(text.includes(`+${fmt(result.net)}`) && text.includes(fmt(result.payout)));
    else assert.ok(text.includes(`-${fmt(bet)}`));
    if (n < 12) { everyMessageIsV2(flight); everyMessageIsV2(card); }
  }
});

test('crash validates bets and targets, and follows the 2-minute / 5-use cooldown policy', () => {
  const user = player();
  assert.equal(economy.playCrash(user, cfg.CRASH_MIN_BET - 1, 2).error, 'invalid');
  assert.equal(economy.playCrash(user, 10 ** 13, 2).error, 'insufficient');
  assert.equal(economy.playCrash(user, 1000, 1.05).error, 'invalid_target');
  assert.deepEqual(user.cooldowns, {}, 'rejected plays do not start a cooldown');

  const originalNow = Date.now;
  let now = 1_800_000_000_000;
  Date.now = () => now;
  try {
    assert.ok(!economy.playCrash(user, 1000, 2, () => 0.5).error);
    const blocked = economy.playCrash(user, 1000, 2, () => 0.5);
    assert.equal(blocked.error, 'cooldown');
    assert.ok(blocked.remaining > 0 && blocked.remaining <= cfg.COOLDOWN_POLICIES.crash.intervalMs);
    for (let i = 1; i < cfg.COOLDOWN_POLICIES.crash.uses; i += 1) {
      now += cfg.COOLDOWN_POLICIES.crash.intervalMs + 1;
      assert.ok(!economy.playCrash(user, 1000, 2, () => 0.5).error, `use ${i + 1}`);
    }
    now += cfg.COOLDOWN_POLICIES.crash.intervalMs + 1;
    assert.equal(economy.playCrash(user, 1000, 2, () => 0.5).error, 'cooldown', 'the rest period starts after the last use');
  } finally { Date.now = originalNow; }
});

test('overflowing payouts are rejected before touching Candys or spending a cooldown use', () => {
  const nearLimit = Number.MAX_SAFE_INTEGER - 100;
  const wheelWeights = cfg.WHEEL_SEGMENTS.map((s) => s.weight);
  const best = cfg.WHEEL_SEGMENTS.reduce((acc, seg, i) => (seg.mult > cfg.WHEEL_SEGMENTS[acc].mult ? i : acc), 0);
  const attempts = [
    ['wheel', (u) => economy.playWheel(u, 1000, rngForIndex(wheelWeights, best)), 'wheel'],
    ['crash', (u) => economy.playCrash(u, 1000, 50, () => 0.9999999), 'crash'],
    ['roulette', (u) => economy.playRoulette(u, 1000, 'verde', rngForIndex(cfg.ROULETTE_COLORS.map((c) => c.weight), cfg.ROULETTE_COLORS.findIndex((c) => c.id === 'verde'))), 'roulette'],
  ];
  for (const [name, run, key] of attempts) {
    const user = player(nearLimit);
    const result = run(user);
    assert.equal(result.error, 'balance_limit', `${name} must refuse`);
    assert.equal(user.cash, nearLimit, `${name} left the balance alone`);
    assert.equal(user.cooldowns[key], undefined, `${name} did not consume a cooldown use`);
    assert.equal(user.cooldownCycles[key], undefined);
  }
  const slotsUser = player(nearLimit);
  assert.equal(economy.slots(slotsUser, 1000, () => 0).error, 'balance_limit');
  assert.equal(slotsUser.cash, nearLimit);
});

test('all casino frames and results are Components V2 messages without pings', () => {
  const user = player();
  const weights = cfg.WHEEL_SEGMENTS.map((s) => s.weight);
  const wheel = economy.playWheel(user, 1000, rngForIndex(weights, 2));
  user.cooldowns = {}; user.cooldownCycles = {};
  const roulette = economy.playRoulette(user, cfg.ROULETTE_MIN_BET, 'rojo', () => 0);
  const crash = economy.playCrash(user, 1000, 2, () => 0.5);
  const views = [
    ui.wheelSpinCard(cfg, 1000, 0), ui.wheelResultCard(cfg, 1000, wheel),
    ui.rouletteSpinCard(cfg, 1000, 3, { final: true }), ui.rouletteResultCard(cfg, cfg.ROULETTE_MIN_BET, 'rojo', roulette),
    ui.slotsFrame(cfg, ['🌀', '🌀', '🌀'], { spinning: true }), ui.diceResultCard(cfg, 100, { win: false, roll: 3, payout: 0, net: -100 }),
    ui.crashFlightCard(cfg, 1000, 200, 1), ui.crashResultCard(cfg, 1000, crash),
  ];
  views.forEach(everyMessageIsV2);
});
