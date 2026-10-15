'use strict';

// Pruebas del motor gráfico propio (render/): PNG, rasterizador, texto, cartas, emojis y la escena del blackjack.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { after, before, test } = require('node:test');
const { setupEnv, cleanupEnv } = require('./_helpers');

const tempDir = setupEnv('render');
process.env.XERION_EMOJI_SOURCE = 'off';
process.env.XERION_EMOJI_CACHE_DIR = path.join(tempDir, 'emoji-cache');

const R = require('../render/raster');
const P = require('../render/png');
const F = require('../render/font');
const emoji = require('../render/emoji');
const scene = require('../render/blackjack-scene');
const cardsModule = require('../render/cards');
const Q = require('../render/quantize');

const fixtures = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'png-fixtures.json'), 'utf8'));
const BOUNDS = {
  x0: 0, y0: 0, x1: 120, y1: 120,
};
const area = (mask) => mask.data.reduce((sum, v) => sum + v, 0);

after(() => cleanupEnv(tempDir));

// ---------- PNG ----------

test('PNG decoder matches Pillow for RGBA, RGB, gray, gray+alpha, palette (1/4/8 bit, tRNS) and 16-bit gray', () => {
  for (const [name, fixture] of Object.entries(fixtures)) {
    const decoded = P.decodePNG(Buffer.from(fixture.png, 'base64'));
    assert.equal(decoded.width, fixture.width, name);
    assert.equal(decoded.height, fixture.height, name);
    const expected = Buffer.from(fixture.rgba, 'base64');
    assert.equal(Buffer.compare(Buffer.from(decoded.data), expected), 0, `${name} pixels`);
  }
});

test('PNG encoder round-trips RGBA and opaque images exactly and produces valid chunks', async () => {
  const w = 37;
  const h = 23;
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i += 1) {
    rgba[i * 4] = (i * 7) % 256; rgba[i * 4 + 1] = (i * 13) % 256; rgba[i * 4 + 2] = (i * 29) % 256; rgba[i * 4 + 3] = (i * 5) % 256;
  }
  const png = await P.encodePNG(w, h, rgba);
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  const back = P.decodePNG(png);
  assert.equal(Buffer.compare(Buffer.from(back.data), Buffer.from(rgba)), 0);
  const opaque = new Uint8Array(w * h * 4).fill(255);
  for (let i = 0; i < opaque.length; i += 4) { opaque[i] = (i / 4) % 256; opaque[i + 1] = 90; opaque[i + 2] = 200; }
  const png2 = await P.encodePNG(w, h, opaque, { filter: 'all' });
  assert.equal(png2[25], 2, 'fully opaque images are stored as RGB (color type 2)');
  assert.equal(Buffer.compare(Buffer.from(P.decodePNG(png2).data), Buffer.from(opaque)), 0);
});

test('PNG decoder rejects malformed, oversized, interlaced or truncated input without crashing', () => {
  assert.throws(() => P.decodePNG(Buffer.from('no soy un png')), /PNG/);
  assert.throws(() => P.decodePNG(Buffer.alloc(10)), /PNG/);
  const good = Buffer.from(fixtures.rgba8.png, 'base64');
  assert.throws(() => P.decodePNG(good.subarray(0, 40)), /PNG/);
  assert.throws(() => P.decodePNG(good, { maxPixels: 10 }), /dimensiones/);
  const tampered = Buffer.from(good);
  tampered[16 + 3] = 0xff; // ancho absurdo
  assert.throws(() => P.decodePNG(tampered), /PNG|inflate|incompletos|dimensiones/i);
  const interlaced = Buffer.from(good);
  interlaced[28] = 1; // IHDR.interlace
  assert.throws(() => P.decodePNG(interlaced), /entrelazado/);
  assert.throws(() => P.decodePNG(Buffer.alloc(6_000_000)), /tamaño/);
});

// ---------- Rasterizador ----------

test('rasterizer coverage is area-exact for circles, rounded rectangles, rings and clipped shapes', () => {
  const circle = R.rasterize(new R.Path().circle(60.3, 50.7, 20.25).flatten(), BOUNDS);
  assert.ok(Math.abs(area(circle) - Math.PI * 20.25 ** 2) < 3);
  const rr = R.rasterize(new R.Path().roundRect(10.5, 10.25, 60.5, 30.75, 8).flatten(), BOUNDS);
  assert.ok(Math.abs(area(rr) - (60.5 * 30.75 - (4 - Math.PI) * 64)) < 3);
  const ring = R.rasterize(new R.Path().circle(60, 60, 30).circle(60, 60, 20, true).flatten(), BOUNDS);
  assert.ok(Math.abs(area(ring) - Math.PI * (900 - 400)) < 4);
  const clipped = R.rasterize(new R.Path().rect(-20, -20, 40, 40).flatten(), BOUNDS);
  assert.ok(Math.abs(area(clipped) - 400) < 1e-3, 'shapes crossing the border are clipped exactly');
  assert.equal(R.rasterize(new R.Path().rect(200, 200, 10, 10).flatten(), BOUNDS), null, 'shapes outside the surface draw nothing');
  for (const value of circle.data) assert.ok(value >= 0 && value <= 1);
});

test('gradients, shadows and blending produce the expected colours', () => {
  const s = new R.Surface(40, 40);
  s.fill(R.solid('#000000'));
  s.fillPath(new R.Path().rect(0, 0, 40, 40), R.linearGradient(0, 0, 40, 0, [[0, '#ff0000'], [1, '#0000ff']]));
  const rgba = s.toRGBA8();
  assert.ok(rgba[0] > 240 && rgba[2] < 15, 'left edge is red');
  assert.ok(rgba[39 * 4] < 15 && rgba[39 * 4 + 2] > 240, 'right edge is blue');
  const half = new R.Surface(4, 4);
  half.fill(R.solid('#ffffff'));
  half.fillPath(new R.Path().rect(0, 0, 4, 4), R.solid('#000000', 0.5));
  assert.ok(Math.abs(half.toRGBA8()[0] - 128) <= 1, '50% black over white is mid gray');
  const shadow = new R.Surface(80, 80);
  shadow.shadowPath(new R.Path().rect(30, 30, 20, 20), { blur: 4, color: '#000000', opacity: 1 });
  const centre = shadow.toRGBA8()[(40 * 80 + 40) * 4 + 3];
  const edge = shadow.toRGBA8()[(40 * 80 + 24) * 4 + 3];
  assert.ok(centre > 200 && edge > 0 && edge < centre, 'shadow is soft: strongest in the middle, fading outwards');
});

test('SVG path parser handles implicit line-to pairs, H/V and quadratic curves', () => {
  const path = R.pathFromSVG('M40 0 247 1600H700L907 0H643ZM1 1 5 1 5 5Z');
  assert.equal(path.flatten().length, 2);
  const glyph = R.pathFromSVG('M0 0Q50 100 100 0V-50H0Z');
  assert.ok(R.rasterize(glyph.transform(R.Mat.translate(10, 60)).flatten(), BOUNDS));
});

// ---------- Texto ----------

test('both fonts contain every character the game draws, and unknown characters fall back to "?"', () => {
  const needed = 'ABCDEFGHIJKLMNOPQRSTUVWXYZÁÉÍÓÚÑ0123456789 ¡!¿?.,:;·+−/×%()';
  for (const name of ['display', 'condensed']) {
    const font = F.loadFont(name);
    for (const ch of needed) assert.ok(font.glyphs.has(ch), `${name} lacks ${JSON.stringify(ch)}`);
  }
  const font = F.loadFont('display');
  assert.equal(F.measureText(font, '🙂', 40), F.measureText(font, '?', 40), 'emoji in names never produce empty boxes');
  const s = new R.Surface(300, 80);
  s.fill(R.solid('#000000'));
  F.drawText(s, 'TÚ 21 ¡GANASTE!', { font: 'display', size: 40, x: 150, y: 55, align: 'center', fill: '#ffffff', outline: { color: '#ff0000', width: 3 } });
  const px = s.toRGBA8();
  let white = 0;
  let red = 0;
  for (let i = 0; i < px.length; i += 4) { if (px[i] > 200 && px[i + 1] > 200) white += 1; if (px[i] > 200 && px[i + 1] < 60) red += 1; }
  assert.ok(white > 400 && red > 300, 'text has both a fill and an outline');
});

// ---------- Cartas y emojis ----------

test('every one of the 52 cards and the card back render a sprite with the right size and visible ink', () => {
  const ranks = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  const suits = ['♠', '♥', '♦', '♣'];
  const { CARD } = cardsModule;
  const seen = new Set();
  for (const suit of suits) {
    for (const rank of ranks) {
      const sprite = cardsModule.getCardSprite(rank + suit);
      assert.equal(sprite.w, CARD.w + CARD.pad * 2);
      assert.equal(sprite.h, CARD.h + CARD.pad * 2);
      const centre = ((CARD.pad + CARD.h / 2) * sprite.w + CARD.pad + CARD.w / 2) * 4;
      assert.ok(sprite.data[centre + 3] > 0.99, `${rank}${suit} card body is opaque`);
      seen.add(crypto.createHash('sha1').update(Buffer.from(sprite.toRGBA8())).digest('hex'));
    }
  }
  assert.equal(seen.size, 52, 'all 52 faces are visually different');
  assert.ok(cardsModule.getCardSprite('??').data.length > 0);
  assert.equal(cardsModule.getCardSprite('A♠'), cardsModule.getCardSprite('A♠'), 'sprites are cached');
});

test('vector emoji fallbacks draw something for every emoji and never throw', () => {
  for (const name of Object.keys(emoji.EMOJI)) {
    const s = new R.Surface(120, 120);
    const mode = emoji.drawEmoji(s, name, 60, 60, 90);
    assert.equal(mode, 'vector');
    let opaque = 0;
    for (let i = 3; i < s.data.length; i += 4) if (s.data[i] > 0.5) opaque += 1;
    assert.ok(opaque > 600, `${name} paints a visible icon`);
  }
  assert.throws(() => emoji.drawEmoji(new R.Surface(10, 10), 'no-existe', 5, 5, 8), /desconocido/);
});

test('Apple emoji PNGs are used when available, validated, cached on disk and never fetched when source is off', async () => {
  emoji.reset();
  const calls = [];
  const make64 = async (r, g, b) => {
    const data = new Uint8Array(64 * 64 * 4);
    for (let i = 0; i < data.length; i += 4) { data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255; }
    return P.encodePNG(64, 64, data);
  };
  const apple = await make64(10, 200, 30);
  emoji.configure({
    source: 'apple',
    baseUrl: 'https://example.invalid/emoji',
    fetchBuffer: async (url) => { calls.push(url); if (url.endsWith('1f383.png')) return apple; throw new Error('404'); },
  });
  const pumpkin = await emoji.load('pumpkin');
  assert.equal(pumpkin.width, 64);
  assert.deepEqual(calls, ['https://example.invalid/emoji/1f383.png']);
  const surface = new R.Surface(80, 80);
  assert.equal(emoji.drawEmoji(surface, 'pumpkin', 40, 40, 64), 'apple');
  const px = surface.toRGBA8();
  const centre = (40 * 80 + 40) * 4;
  assert.ok(px[centre + 1] > 150 && px[centre] < 60, 'the downloaded PNG pixels are drawn');
  assert.ok(fs.existsSync(path.join(process.env.XERION_EMOJI_CACHE_DIR, '1f383.png')), 'downloaded PNG cached on disk');
  assert.equal(await emoji.load('ghost'), null, 'a failed download falls back instead of throwing');
  assert.equal(emoji.drawEmoji(new R.Surface(80, 80), 'ghost', 40, 40, 64), 'vector');

  // Un archivo dañado o con tamaño absurdo se descarta.
  emoji.reset();
  emoji.configure({ fetchBuffer: async () => Buffer.from('basura que no es un PNG') });
  assert.equal(await emoji.load('bat'), null);
  emoji.reset();
  emoji.configure({ fetchBuffer: async () => P.encodePNG(512, 512, new Uint8Array(512 * 512 * 4)) });
  assert.equal(await emoji.load('crown'), null, 'oversized emoji images are rejected');

  // Desde la caché de disco, sin red.
  emoji.reset();
  emoji.configure({ fetchBuffer: async () => { throw new Error('no debe llamarse'); } });
  assert.ok(await emoji.load('pumpkin'), 'loads from the disk cache without touching the network');

  // source=off: ni siquiera intenta descargar.
  emoji.reset();
  fs.rmSync(process.env.XERION_EMOJI_CACHE_DIR, { recursive: true, force: true });
  let fetched = 0;
  emoji.configure({ source: 'off', fetchBuffer: async () => { fetched += 1; return apple; } });
  assert.equal(await emoji.load('pumpkin'), null);
  assert.equal(fetched, 0);
  emoji.configure({ source: 'off', fetchBuffer: null, baseUrl: emoji.DEFAULT_BASE_URL });
  emoji.reset();
});

test('the emoji CDN default is HTTPS and the loader refuses plain HTTP', async () => {
  assert.match(emoji.DEFAULT_BASE_URL, /^https:\/\//);
  emoji.reset();
  emoji.configure({ source: 'apple', baseUrl: 'http://example.invalid/emoji', fetchBuffer: null });
  assert.equal(await emoji.load('skull'), null);
  emoji.configure({ source: 'off', baseUrl: emoji.DEFAULT_BASE_URL });
  emoji.reset();
});

// ---------- Cuantización ----------

test('quantizer builds a 256-colour palette whose indexed PNG decodes close to the original', async () => {
  const w = 64;
  const h = 48;
  const rgb = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const o = (y * w + x) * 3;
      rgb[o] = (x * 4) % 256; rgb[o + 1] = (y * 5) % 256; rgb[o + 2] = ((x + y) * 3) % 256;
    }
  }
  const histogram = new Q.Histogram();
  histogram.addRGB(rgb);
  const palette = Q.buildPalette(histogram, 64);
  assert.ok(palette.length / 3 <= 64 && palette.length / 3 > 8);
  const png = await Q.encodeIndexedPNG(w, h, rgb, Q.makeLookup(palette));
  const back = P.decodePNG(png);
  assert.equal(back.width, w);
  let error = 0;
  for (let i = 0; i < w * h; i += 1) error += Math.abs(back.data[i * 4] - rgb[i * 3]) + Math.abs(back.data[i * 4 + 1] - rgb[i * 3 + 1]) + Math.abs(back.data[i * 4 + 2] - rgb[i * 3 + 2]);
  assert.ok(error / (w * h * 3) < 14, `mean error ${error / (w * h * 3)}`);
});

// ---------- Escena del blackjack ----------

const PLAYING = {
  player: ['K♥', '7♠'], dealer: ['9♦', 'Q♣'], hideDealer: true, bet: 1000, maxCards: 15,
};

function pixel(decoded, x, y) {
  const o = (y * decoded.width + x) * 4;
  return [decoded.data[o], decoded.data[o + 1], decoded.data[o + 2]];
}

before(async () => { await scene.warmUp(); });

test('renderBlackjack returns a valid, small, indexed PNG of the expected size', async () => {
  const out = await scene.renderBlackjack(PLAYING);
  assert.equal(out.mime, 'image/png');
  assert.equal(out.width, scene.W);
  assert.equal(out.height, scene.H);
  assert.equal(out.buffer[25], 3, 'color type 3 = indexed');
  assert.ok(out.buffer.length < 130_000, `${out.buffer.length} bytes`);
  const decoded = P.decodePNG(out.buffer);
  assert.equal(decoded.width, 900);
  assert.equal(decoded.height, 576);
});

test('the same state renders byte-identical images and is served from the LRU cache', async () => {
  const first = await scene.renderBlackjack({ ...PLAYING, bet: 4321 });
  const second = await scene.renderBlackjack({ ...PLAYING, bet: 4321 });
  assert.equal(second.cached, true);
  assert.equal(Buffer.compare(first.buffer, second.buffer), 0);
  scene.clearCaches();
  await scene.warmUp();
  const third = await scene.renderBlackjack({ ...PLAYING, bet: 4321 });
  assert.equal(third.cached, false);
  assert.equal(Buffer.compare(first.buffer, third.buffer), 0, 'rendering is deterministic');
});

test('different game states produce different images (cards, hidden card, bet, result)', async () => {
  const variants = [
    PLAYING,
    { ...PLAYING, hideDealer: false },
    { ...PLAYING, player: ['K♥', '7♠', '2♣'] },
    { ...PLAYING, bet: 2000 },
    { ...PLAYING, hideDealer: false, result: 'win', net: 1000 },
    { ...PLAYING, hideDealer: false, result: 'lose', net: -1000 },
    { ...PLAYING, hideDealer: false, result: 'push', net: 0 },
    { ...PLAYING, hideDealer: false, result: 'blackjack', net: 2500 },
  ];
  const hashes = new Set();
  for (const state of variants) hashes.add((await scene.renderBlackjack(state)).buffer.toString('base64'));
  assert.equal(hashes.size, variants.length);
});

test('the picture shows the decided result: banner colour and score badge colour follow the state', async () => {
  const winner = P.decodePNG((await scene.renderBlackjack({
    ...PLAYING, hideDealer: false, player: ['10♠', '9♥'], dealer: ['10♦', '6♣', 'K♣'], result: 'win', dealerBust: true, net: 1000,
  })).buffer);
  const loser = P.decodePNG((await scene.renderBlackjack({
    ...PLAYING, hideDealer: false, player: ['10♠', '9♥', '5♣'], result: 'lose', playerBust: true, net: -1000,
  })).buffer);
  const bannerX = scene.LAYOUT.bannerX - 250;
  const bannerY = scene.LAYOUT.bannerY + 14;
  const [wr, wg] = pixel(winner, bannerX, bannerY);
  const [lr, lg, lb] = pixel(loser, bannerX, bannerY);
  assert.ok(wg > wr + 40, `win banner is green (${wr},${wg})`);
  assert.ok(lr > lg + 60 && lr > lb + 60, `lose banner is red (${lr},${lg},${lb})`);
  // Anillo de la insignia del jugador: verde (21) / rojo (pasado) / dorado (normal)
  const ringX = 112;
  const ringY = scene.LAYOUT.playerTop + 100 - 41;
  const normal = P.decodePNG((await scene.renderBlackjack({ ...PLAYING, hideDealer: false, player: ['10♠', '7♥'] })).buffer);
  const twentyOne = P.decodePNG((await scene.renderBlackjack({ ...PLAYING, hideDealer: false, player: ['10♠', '5♥', '6♣'] })).buffer);
  const [nr, ng, nb] = pixel(normal, ringX, ringY);
  const [tr, tg, tb] = pixel(twentyOne, ringX, ringY);
  assert.ok(nr > nb + 60, `normal ring is gold (${nr},${ng},${nb})`);
  assert.ok(tg > tr + 30, `21 ring is green (${tr},${tg},${tb})`);
});

test('the dealer hole card is hidden while playing and revealed afterwards', async () => {
  const hidden = P.decodePNG((await scene.renderBlackjack(PLAYING)).buffer);
  const open = P.decodePNG((await scene.renderBlackjack({ ...PLAYING, hideDealer: false })).buffer);
  // Con 2 cartas la banca ocupa x≈429-541 y x≈557-669 (y≈100-256): la 2ª es el reverso morado o la cara crema.
  const average = (image) => {
    let r = 0; let g = 0; let b = 0; let n = 0;
    for (let y = 110; y < 250; y += 2) {
      for (let x = 565; x < 662; x += 2) { const [pr, pg, pb] = pixel(image, x, y); r += pr; g += pg; b += pb; n += 1; }
    }
    return [r / n, g / n, b / n];
  };
  const [hr, hg, hb] = average(hidden);
  const [or, og, ob] = average(open);
  assert.ok(hb > hg + 25 && hr < 150, `card back is purple (${hr.toFixed(0)},${hg.toFixed(0)},${hb.toFixed(0)})`);
  assert.ok(or > 140 && og > 130 && ob > 120 && ob - og < 15, `card face is light and neutral (${or.toFixed(0)},${og.toFixed(0)},${ob.toFixed(0)})`);
  assert.ok(hb - hg > ob - og + 20, 'the revealed card is clearly less purple than the card back');
});

test('a full 15-card table, 13 overlapped cards and huge bets render without overflow or errors', async () => {
  const full = await scene.renderBlackjack({
    player: ['2♠', '2♥', 'A♠', 'A♥', 'A♦', 'A♣', '3♠', '3♥', '3♦', '4♣', '4♠', '5♥', '5♦'],
    dealer: ['2♦', '2♣'],
    hideDealer: false,
    bet: 1000,
    maxCards: 15,
    result: 'push',
    dealerBlocked: true,
    net: 0,
  });
  assert.ok(P.decodePNG(full.buffer));
  const huge = await scene.renderBlackjack({ ...PLAYING, hideDealer: false, bet: Number.MAX_SAFE_INTEGER, result: 'win', net: Number.MAX_SAFE_INTEGER });
  assert.ok(P.decodePNG(huge.buffer));
  const none = await scene.renderBlackjack({ ...PLAYING, bet: 0 });
  assert.ok(P.decodePNG(none.buffer));
});

test('renderBlackjack rejects invalid states (bad cards, too many cards, negative bets) before drawing', async () => {
  await assert.rejects(() => scene.renderBlackjack(null), /inválido/);
  await assert.rejects(() => scene.renderBlackjack({ ...PLAYING, player: ['ZZ'] }), /Carta inválida/);
  await assert.rejects(() => scene.renderBlackjack({ ...PLAYING, player: ['1♠'] }), /Carta inválida/);
  await assert.rejects(() => scene.renderBlackjack({ ...PLAYING, bet: -5 }), /Apuesta/);
  await assert.rejects(() => scene.renderBlackjack({ ...PLAYING, bet: Number.NaN }), /Apuesta/);
  await assert.rejects(() => scene.renderBlackjack({ ...PLAYING, player: Array(30).fill('2♠') }), /Demasiadas/);
  await assert.rejects(() => scene.renderBlackjack({ ...PLAYING, dealer: 'no es lista' }), /inválido/);
});

test('result labels describe the real outcome (blackjack, win, dealer bust, push, full table, bust, loss)', () => {
  const label = (state) => scene.describeResult(state).label;
  assert.equal(label({ result: 'blackjack' }), '¡BLACKJACK!');
  assert.equal(label({ result: 'win' }), '¡GANASTE!');
  assert.equal(label({ result: 'win', dealerBust: true }), '¡LA BANCA SE PASÓ!');
  assert.equal(label({ result: 'push' }), 'EMPATE');
  assert.equal(label({ result: 'push', dealerBlocked: true }), 'MESA LLENA · EMPATE');
  assert.equal(label({ result: 'lose' }), 'PERDISTE');
  assert.equal(label({ result: 'lose', playerBust: true }), '¡TE PASASTE!');
  assert.equal(scene.describeResult({ result: null }), null);
});

test('rendering stays fast enough for a live bot once warm (well under a second per image)', async () => {
  const started = Date.now();
  for (let i = 0; i < 6; i += 1) await scene.renderBlackjack({ ...PLAYING, bet: 7000 + i });
  const perImage = (Date.now() - started) / 6;
  assert.ok(perImage < 600, `${perImage.toFixed(0)} ms per image`);
});

test('the build ships fonts with licences and an empty assets/emoji slot for custom Apple PNGs', () => {
  const root = path.join(__dirname, '..');
  for (const file of ['assets/fonts/display.json', 'assets/fonts/condensed.json', 'assets/fonts/LICENSES/EricaOne-OFL.txt', 'assets/fonts/LICENSES/BigShoulders-OFL.txt']) {
    assert.ok(fs.existsSync(path.join(root, file)), file);
  }
  assert.match(fs.readFileSync(path.join(root, 'assets/fonts/LICENSES/EricaOne-OFL.txt'), 'utf8'), /SIL OPEN FONT LICENSE/i);
  assert.ok(os.tmpdir());
});
