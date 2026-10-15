'use strict';

// ============================================================
//  BLACKJACK-SCENE — Dibuja la mesa de blackjack como imagen PNG.
//
//  renderBlackjack(state) → { buffer, width, height, mime }
//
//  La imagen SOLO muestra el estado que recibe (cartas, apuesta, resultado ya decidido por economy.js):
//  no sortea nada ni calcula pagos, así que nunca puede contradecir lo que realmente se pagó.
//  Todo el texto sale de contornos vectoriales (assets/fonts) y los emojis de PNG Apple o iconos
//  vectoriales de respaldo (render/emoji.js): se ve igual en cualquier servidor, sin cuadros vacíos.
//
//  Costo/ancho de banda: el PNG sale indexado a 256 colores (paleta entrenada una vez) → ~90 KB por imagen
//  en lugar de ~250 KB, y los renders repetidos se sirven desde una pequeña caché LRU.
// ============================================================

const {
  Surface, Path, Mat, solid, linearGradient, radialGradient,
} = require('./raster');
const { drawText, measureText, loadFont } = require('./font');
const { encodePNG } = require('./png');
const {
  Histogram, buildPalette, makeLookup, encodeIndexedPNG,
} = require('./quantize');
const { getCardSprite, CARD } = require('./cards');
const emoji = require('./emoji');
const { ART } = require('./emoji-art');

const W = 900;
const H = 576;

const LAYOUT = {
  dealerTop: 100,
  playerTop: 338,
  cardsX: 218,
  cardsW: 662,
  bannerX: 549, // centro del área de cartas
  bannerY: 297,
  footerBase: 534,
};

const GOLD = ['#fff0a0', '#ffc933', '#e07b00'];
const INK = '#120a1c';
const BANNER = {
  win: ['#8dffae', '#1fbf5f'],
  lose: ['#ff7b7b', '#b3202a'],
  push: ['#ffe28a', '#e39b13'],
  blackjack: ['#fff08a', '#ff7a18'],
};

const fmtNumber = (value) => new Intl.NumberFormat('en-US').format(Math.trunc(value));

function handValue(hand) {
  let total = 0;
  let aces = 0;
  for (const card of hand) {
    const rank = card.slice(0, -1);
    if (rank === 'A') { total += 11; aces += 1; } else if (['J', 'Q', 'K'].includes(rank)) total += 10;
    else total += parseInt(rank, 10);
  }
  while (total > 21 && aces > 0) { total -= 10; aces -= 1; }
  return total;
}

function shade(hex, amount) {
  const n = parseInt(hex.slice(1), 16);
  const channel = (shift) => {
    const v = (n >> shift) & 255;
    const out = amount >= 0 ? v + (255 - v) * amount : v * (1 + amount);
    return Math.max(0, Math.min(255, Math.round(out)));
  };
  return `#${[16, 8, 0].map((sh) => channel(sh).toString(16).padStart(2, '0')).join('')}`;
}

// ---------- Fondo (se dibuja una vez y se clona en cada render) ----------

let backgroundCache = null;

function drawCobweb(s, cx, cy, radius, rotation) {
  const spokes = 6;
  const line = (x0, y0, x1, y1, width) => {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len = Math.hypot(dx, dy) || 1;
    const nx = (-dy / len) * (width / 2);
    const ny = (dx / len) * (width / 2);
    s.fillPath(new Path().polygon([[x0 + nx, y0 + ny], [x1 + nx, y1 + ny], [x1 - nx, y1 - ny], [x0 - nx, y0 - ny]]), solid('#e8e0ff', 0.2));
  };
  for (let i = 0; i < spokes; i += 1) {
    const angle = rotation + (i / (spokes - 1)) * (Math.PI / 2);
    line(cx, cy, cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius, 1.6);
  }
  for (let ring = 1; ring <= 4; ring += 1) {
    const r = (radius * ring) / 4;
    for (let i = 0; i < spokes - 1; i += 1) {
      const a0 = rotation + (i / (spokes - 1)) * (Math.PI / 2);
      const a1 = rotation + ((i + 1) / (spokes - 1)) * (Math.PI / 2);
      const mid = (a0 + a1) / 2;
      const sag = r * 0.88;
      line(cx + Math.cos(a0) * r, cy + Math.sin(a0) * r, cx + Math.cos(mid) * sag, cy + Math.sin(mid) * sag, 1.2);
      line(cx + Math.cos(mid) * sag, cy + Math.sin(mid) * sag, cx + Math.cos(a1) * r, cy + Math.sin(a1) * r, 1.2);
    }
  }
}

function drawPill(s, cx, cy, label) {
  const w = 138;
  const h = 32;
  const body = new Path().roundRect(cx - w / 2, cy - h / 2, w, h, h / 2);
  s.shadowPath(body, {
    dx: 3, dy: 4, blur: 2, color: '#000000', opacity: 0.55,
  });
  s.fillPath(new Path().roundRect(cx - w / 2 - 2.5, cy - h / 2 - 2.5, w + 5, h + 5, h / 2 + 2.5), linearGradient(0, cy - h / 2, 0, cy + h / 2, [[0, '#ffe08a'], [1, '#c77a00']]));
  s.fillPath(body, linearGradient(0, cy - h / 2, 0, cy + h / 2, [[0, '#4a2494'], [1, '#1c0d40']]));
  drawText(s, label, {
    font: 'condensed', size: 25, x: cx, y: cy + 8.5, align: 'center', spacing: 3, fill: '#ffffff',
  });
}

function buildBackground() {
  const s = new Surface(W, H);
  s.fill(radialGradient(W / 2, H / 2, 660, [[0, '#2a1450'], [0.6, '#150a2b'], [1, '#07030f']]));
  const table = new Path().roundRect(14, 14, W - 28, H - 28, 48);
  s.shadowPath(table, {
    dx: 0, dy: 8, blur: 12, color: '#000000', opacity: 0.8,
  });
  s.fillPath(table, linearGradient(14, 14, W - 14, H - 14, [[0, '#ffe08a'], [0.35, '#e8a21c'], [0.7, '#b86a00'], [1, '#ffcf5a']]));
  s.fillPath(new Path().roundRect(20, 20, W - 40, H - 40, 43), solid('#140b22'));
  const felt = new Path().roundRect(25, 25, W - 50, H - 50, 39);
  s.fillPath(felt, radialGradient(W / 2, H * 0.52, 520, [[0, '#1f8a64'], [0.5, '#116148'], [1, '#07291f']], { sx: 1.25, sy: 0.92 }));
  s.fillPath(felt, radialGradient(W / 2, H / 2, 580, [[0.55, '#00000000'], [1, '#00000066']], { sx: 1.35, sy: 1 }));
  s.fillPath(new Path().roundRect(36, 36, W - 72, H - 72, 30).roundRect(38.4, 38.4, W - 76.8, H - 76.8, 28, true), solid('#ffd166', 0.3));
  drawCobweb(s, W - 38, 38, 110, Math.PI / 2);
  drawCobweb(s, 38, H - 38, 90, -Math.PI / 2);

  // Leyenda impresa en el centro de la mesa (queda tapada por el banner de resultado).
  const mid = (LAYOUT.dealerTop + CARD.h + LAYOUT.playerTop) / 2;
  const legendText = 'LA BANCA SE PLANTA EN 17  ·  BLACKJACK PAGA 3:2';
  drawText(s, legendText, {
    font: 'condensed', size: 25, x: LAYOUT.bannerX, y: mid + 8, align: 'center', spacing: 4, fill: '#ffd98a', outline: { color: '#07291f', width: 2 },
  });
  const legend = measureText(loadFont('condensed'), legendText, 25, 4);
  s.fillPath(new Path().rect(LAYOUT.bannerX - legend / 2 - 40, mid - 0.8, 28, 1.6), solid('#ffd166', 0.45));
  s.fillPath(new Path().rect(LAYOUT.bannerX + legend / 2 + 12, mid - 0.8, 28, 1.6), solid('#ffd166', 0.45));

  // Etiquetas fijas
  drawPill(s, 112, LAYOUT.dealerTop + 24, 'DEALER');
  drawPill(s, 112, LAYOUT.playerTop + 24, 'TÚ');
  drawText(s, 'APUESTA', {
    font: 'condensed', size: 24, x: 122, y: LAYOUT.footerBase - 6, align: 'left', spacing: 3, fill: '#ffd98a', outline: { color: INK, width: 3 },
  });

  // Título
  const titleX = 112;
  emoji.drawEmoji(s, 'pumpkin', 66, 62, 74);
  const title = drawText(s, 'BLACKJACK', {
    font: 'display',
    size: 62,
    x: titleX,
    y: 88,
    align: 'left',
    spacing: 2,
    fill: linearGradient(0, 44, 0, 90, [[0, GOLD[0]], [0.5, GOLD[1]], [1, GOLD[2]]]),
    outline: { color: INK, width: 6 },
    shadow: {
      dx: 5, dy: 7, blur: 3, color: '#000000', opacity: 0.55,
    },
  });
  emoji.drawEmoji(s, 'ghost', titleX + title.width + 34, 64, 54);
  return s;
}

function getBackground() {
  const version = emoji.getVersion();
  if (!backgroundCache || backgroundCache.version !== version) backgroundCache = { version, surface: buildBackground() };
  return backgroundCache.surface.clone();
}

// ---------- Piezas dinámicas ----------

function drawBadge(s, cx, cy, text, tone) {
  const tones = {
    normal: { ring: ['#fff0a0', '#e8a21c'], glow: '#ffc933', text: '#ffffff' },
    twentyone: { ring: ['#b9ffcf', '#1fbf5f'], glow: '#35e07a', text: '#caffd9' },
    bust: { ring: ['#ffb3b3', '#d11f2a'], glow: '#ff3b47', text: '#ffd0d0' },
    blackjack: { ring: ['#fff6b0', '#ff8a1f'], glow: '#ffb02e', text: '#fff3b0' },
    hidden: { ring: ['#c6b3ff', '#6a3fd0'], glow: '#8b5cf6', text: '#e5dcff' },
  };
  const t = tones[tone] || tones.normal;
  const outer = new Path().circle(cx, cy, 45);
  s.shadowPath(outer, { blur: 9, color: t.glow, opacity: 0.55 });
  s.shadowPath(outer, {
    dx: 4, dy: 6, blur: 2, color: '#000000', opacity: 0.55,
  });
  s.fillPath(new Path().circle(cx, cy, 45).circle(cx, cy, 37, true), linearGradient(cx - 45, cy - 45, cx + 45, cy + 45, [[0, t.ring[0]], [1, t.ring[1]]]));
  s.fillPath(new Path().circle(cx, cy, 37), radialGradient(cx, cy - 8, 44, [[0, '#3b1d7a'], [1, '#150a2e']]));
  const size = text.length > 3 ? 32 : text.length > 2 ? 40 : 52;
  drawText(s, text, {
    font: 'condensed', size, x: cx, y: cy + size * 0.36, align: 'center', fill: t.text, outline: { color: '#0b0516', width: 2.5 },
  });
}

function drawHand(s, cards, top, hideLast) {
  const display = cards.map((card, i) => (hideLast && i === cards.length - 1 ? '??' : card));
  const count = display.length;
  const natural = CARD.w + 16;
  const step = count <= 1 ? 0 : Math.min(natural, (LAYOUT.cardsW - CARD.w) / (count - 1));
  const total = CARD.w + step * (count - 1);
  const startX = LAYOUT.cardsX + (LAYOUT.cardsW - total) / 2;
  display.forEach((card, i) => {
    s.blit(getCardSprite(card), Math.round(startX + step * i - CARD.pad), Math.round(top - CARD.pad));
  });
}

function drawChip(s, cx, cy, rx, color) {
  const ry = rx * 0.4;
  const t = rx * 0.34;
  const side = new Path().roundRect(cx - rx, cy, rx * 2, t, [0, 0, t / 2, t / 2]).ellipse(cx, cy + t, rx, ry);
  s.fillPath(side, linearGradient(cx - rx, 0, cx + rx, 0, [[0, shade(color, -0.45)], [0.5, shade(color, -0.2)], [1, shade(color, -0.55)]]));
  s.fillPath(new Path().ellipse(cx, cy, rx, ry), radialGradient(cx - rx * 0.3, cy - ry * 0.4, rx * 1.2, [[0, shade(color, 0.25)], [1, shade(color, -0.1)]]));
  for (let i = 0; i < 8; i += 1) {
    const angle = (i / 8) * Math.PI * 2;
    s.fillPath(new Path().ellipse(cx + Math.cos(angle) * rx * 0.86, cy + Math.sin(angle) * ry * 0.86, rx * 0.15, ry * 0.2), solid('#ffffff', 0.92));
  }
  s.fillPath(new Path().ellipse(cx, cy, rx * 0.6, ry * 0.6), radialGradient(cx, cy, rx * 0.6, [[0, shade(color, 0.12)], [1, shade(color, -0.2)]]));
  s.fillPath(new Path().ellipse(cx, cy, rx * 0.6, ry * 0.6).ellipse(cx, cy, rx * 0.5, ry * 0.5, true), solid('#ffffff', 0.55));
}

function chipColor(bet) {
  if (bet >= 1_000_000) return '#2b2640';
  if (bet >= 100_000) return '#d11f2a';
  if (bet >= 10_000) return '#8b5cf6';
  if (bet >= 1_000) return '#22b45b';
  return '#ff7a18';
}

function drawChipStack(s, cx, baseY, bet) {
  const count = bet >= 1_000_000 ? 6 : bet >= 100_000 ? 5 : bet >= 10_000 ? 4 : bet >= 1_000 ? 3 : 2;
  s.fillPath(new Path().ellipse(cx + 3, baseY + 7, 30, 9), solid('#000000', 0.4));
  for (let i = 0; i < count; i += 1) drawChip(s, cx, baseY - i * 8, 25, chipColor(bet));
}

function drawPips(s, count, max) {
  const r = 5.6;
  const gap = 17;
  const x0 = W - 52 - (max - 1) * gap;
  for (let i = 0; i < max; i += 1) {
    const cx = x0 + i * gap;
    const filled = i < count;
    const hot = count >= max - 2;
    const color = filled ? (count >= max ? ['#ff9a9a', '#e11d2e'] : hot ? ['#ffd29a', '#ff7a18'] : ['#fff0a0', '#e8a21c']) : ['#1a3b30', '#0d2119'];
    s.fillPath(new Path().circle(cx, 78, r + 1.5), solid('#08130f', 0.9));
    s.fillPath(new Path().circle(cx, 78, r), linearGradient(cx, 72, cx, 84, [[0, color[0]], [1, color[1]]]));
  }
}

function drawBanner(s, verdict) {
  const cx = LAYOUT.bannerX;
  const cy = LAYOUT.bannerY;
  const colors = BANNER[verdict.kind] || BANNER.push;
  const angle = -0.032;
  const matrix = Mat.rotateAround(angle, cx, cy);
  const wBan = 624;
  const hBan = 62;
  const roundBox = (grow, radius) => new Path().roundRect(cx - wBan / 2 - grow, cy - hBan / 2 - grow, wBan + grow * 2, hBan + grow * 2, radius).transform(matrix);
  s.shadowPath(roundBox(0, 15), {
    dx: 8, dy: 10, blur: 3, color: '#000000', opacity: 0.6,
  });
  s.fillPath(roundBox(5, 19), solid(INK));
  s.fillPath(roundBox(0, 15), linearGradient(0, cy - hBan / 2, 0, cy + hBan / 2, [[0, colors[0]], [1, colors[1]]]));
  s.fillPath(new Path().roundRect(cx - wBan / 2 + 6, cy - hBan / 2 + 5, wBan - 12, hBan * 0.4, 10).transform(matrix),
    linearGradient(0, cy - hBan / 2, 0, cy, [[0, '#ffffff66'], [1, '#ffffff08']]));
  const font = loadFont('display');
  const size = measureText(font, verdict.label, 50, 1) > wBan - 170 ? 36 : 50;
  drawText(s, verdict.label, {
    font: 'display',
    size,
    x: cx,
    y: cy + size * 0.36,
    align: 'center',
    spacing: 1,
    fill: '#ffffff',
    outline: { color: shade(colors[1], -0.65), width: 5 },
    shadow: {
      dx: 3, dy: 4, blur: 1, color: '#000000', opacity: 0.45,
    },
    matrix,
  });
  const iconName = {
    win: 'sparkle', blackjack: 'crown', lose: 'skull', bust: 'boom', push: 'ghost',
  }[verdict.sub] || 'sparkle';
  for (const side of [-1, 1]) {
    const x = cx + side * (wBan / 2 + 2);
    emoji.drawEmoji(s, iconName, x, cy + Math.tan(angle) * (x - cx) - 2, 62);
  }
  if (verdict.sub === 'blackjack' || verdict.sub === 'win') {
    for (const [dx, dy, size2] of [[-250, -50, 30], [270, -50, 28], [-130, 52, 26], [190, 54, 28]]) emoji.drawEmoji(s, 'sparkle', cx + dx, cy + dy, size2);
  }
}

// ---------- Escena ----------

function describeResult(state) {
  const {
    result, playerBust, dealerBust, dealerBlocked,
  } = state;
  if (!result) return null;
  if (result === 'blackjack') return { kind: 'blackjack', sub: 'blackjack', label: '¡BLACKJACK!' };
  if (result === 'win') return { kind: 'win', sub: 'win', label: dealerBust ? '¡LA BANCA SE PASÓ!' : '¡GANASTE!' };
  if (result === 'push') return { kind: 'push', sub: 'push', label: dealerBlocked ? 'MESA LLENA · EMPATE' : 'EMPATE' };
  return playerBust
    ? { kind: 'lose', sub: 'bust', label: '¡TE PASASTE!' }
    : { kind: 'lose', sub: 'lose', label: 'PERDISTE' };
}

function drawScene(state) {
  const s = getBackground();
  const maxCards = state.maxCards || 15;
  const total = state.player.length + state.dealer.length;
  const dealerHidden = !!state.hideDealer && state.dealer.length > 0;

  drawHand(s, state.dealer, LAYOUT.dealerTop, dealerHidden);
  drawHand(s, state.player, LAYOUT.playerTop, false);

  const playerValue = handValue(state.player);
  const dealerValue = handValue(dealerHidden ? state.dealer.slice(0, -1) : state.dealer);
  drawBadge(
    s,
    112,
    LAYOUT.dealerTop + 100,
    dealerHidden ? `${dealerValue}+?` : String(dealerValue),
    dealerHidden ? 'hidden' : dealerValue > 21 ? 'bust' : dealerValue === 21 ? 'twentyone' : 'normal',
  );
  const naturalBlackjack = state.player.length === 2 && playerValue === 21;
  drawBadge(
    s,
    112,
    LAYOUT.playerTop + 100,
    String(playerValue),
    playerValue > 21 ? 'bust' : naturalBlackjack ? 'blackjack' : playerValue === 21 ? 'twentyone' : 'normal',
  );

  drawText(s, `MESA ${total}/${maxCards}`, {
    font: 'condensed', size: 30, x: W - 52, y: 56, align: 'right', spacing: 2, fill: total >= maxCards ? '#ff9a9a' : '#ffe08a', outline: { color: INK, width: 3 },
  });
  drawPips(s, total, maxCards);

  const verdict = describeResult(state);
  if (verdict) drawBanner(s, verdict);

  // Pie: apuesta y neto (números en la fuente condensada: los dígitos se leen mejor)
  const base = LAYOUT.footerBase;
  drawChipStack(s, 78, base - 8, state.bet);
  const labelW = measureText(loadFont('condensed'), 'APUESTA', 24, 3);
  const betText = fmtNumber(state.bet);
  const betSize = betText.length > 14 ? 28 : betText.length > 10 ? 34 : 42;
  const betW = drawText(s, betText, {
    font: 'condensed', size: betSize, x: 122 + labelW + 14, y: base, align: 'left', fill: '#ffffff', outline: { color: INK, width: 3.5 },
  }).width;
  emoji.drawEmoji(s, 'candy', 122 + labelW + 14 + betW + 28, base - 13, 40);

  if (verdict && Number.isFinite(state.net)) {
    const positive = state.net > 0;
    const zero = state.net === 0;
    const amount = `${positive ? '+' : zero ? '' : '−'}${fmtNumber(Math.abs(state.net))}`;
    const amountSize = amount.length > 14 ? 28 : amount.length > 10 ? 34 : 44;
    emoji.drawEmoji(s, 'candy', W - 52 - 18, base - 13, 40);
    drawText(s, amount, {
      font: 'condensed',
      size: amountSize,
      x: W - 52 - 46,
      y: base,
      align: 'right',
      fill: zero ? '#ffe08a' : positive ? '#7dffa1' : '#ff8a8a',
      outline: { color: INK, width: 3.5 },
    });
  }
  return s;
}

// ---------- Paleta entrenada + caché de renders ----------

const TRAINING_STATES = [
  {
    player: ['K♥', '7♠'], dealer: ['9♦', 'Q♣'], hideDealer: true, bet: 1000, maxCards: 15,
  },
  {
    player: ['A♠', 'K♥'], dealer: ['9♦', '7♣'], bet: 2500, maxCards: 15, result: 'blackjack', net: 3750,
  },
  {
    player: ['10♥', '6♠', '9♦'], dealer: ['9♦', '7♣'], bet: 125000, maxCards: 15, result: 'lose', playerBust: true, net: -125000,
  },
  {
    player: ['2♠', '3♥', '4♦', '5♣', '7♠'], dealer: ['10♦', '8♣'], bet: 1000000, maxCards: 15, result: 'win', net: 1000000,
  },
  {
    player: ['10♠', '8♥', 'J♣', 'Q♦'], dealer: ['10♦', '8♣', 'A♠', '5♥'], bet: 5000, maxCards: 15, result: 'push', dealerBlocked: true, net: 0,
  },
  {
    player: ['2♣', '9♠', 'A♦', '7♥', '3♠', '4♥'], dealer: ['6♦', 'K♠'], hideDealer: true, bet: 90000, maxCards: 15,
  },
];

let paletteCache = null; // { version, promise }
const renderCache = new Map();
const RENDER_CACHE_LIMIT = 24;

const tick = () => new Promise((resolve) => { setImmediate(resolve); });

async function getPalette() {
  const version = emoji.getVersion();
  if (paletteCache && paletteCache.version === version) return paletteCache.promise;
  const promise = (async () => {
    const histogram = new Histogram();
    for (const state of TRAINING_STATES) {
      histogram.addRGB(drawScene(state).toRGB8(), 3);
      await tick(); // no bloquear el event loop con todas las escenas de entrenamiento de golpe
    }
    return makeLookup(buildPalette(histogram, 256));
  })();
  paletteCache = { version, promise };
  promise.catch(() => { if (paletteCache && paletteCache.promise === promise) paletteCache = null; });
  return promise;
}

function cacheKey(state) {
  return `${emoji.getVersion()}|${JSON.stringify([state.player, state.dealer, !!state.hideDealer, state.bet, state.maxCards, state.result || '', !!state.playerBust, !!state.dealerBust, !!state.dealerBlocked, state.net ?? null])}`;
}

function validateState(state) {
  if (!state || !Array.isArray(state.player) || !Array.isArray(state.dealer)) throw new TypeError('Estado de blackjack inválido');
  if (state.player.length + state.dealer.length > 24) throw new RangeError('Demasiadas cartas para dibujar');
  const valid = /^(?:[2-9]|10|[AJQK])[♠♥♦♣]$/;
  for (const card of [...state.player, ...state.dealer]) {
    if (!valid.test(card)) throw new TypeError(`Carta inválida: ${card}`);
  }
  if (!Number.isFinite(state.bet) || state.bet < 0) throw new TypeError('Apuesta inválida');
}

// state: { player[], dealer[], hideDealer, bet, maxCards, result, playerBust, dealerBust, dealerBlocked, net }
async function renderBlackjack(state, { indexed = true, level = 6 } = {}) {
  validateState(state);
  const key = `${indexed ? 'i' : 't'}|${cacheKey(state)}`;
  if (renderCache.has(key)) {
    const hit = renderCache.get(key);
    renderCache.delete(key);
    renderCache.set(key, hit); // LRU: el más reciente al final
    return { ...hit, cached: true };
  }
  let out;
  if (indexed) {
    const lookup = await getPalette();
    const surface = drawScene(state);
    const buffer = await encodeIndexedPNG(surface.w, surface.h, surface.toRGB8(), lookup, { level });
    out = {
      buffer, width: surface.w, height: surface.h, mime: 'image/png',
    };
  } else {
    const surface = drawScene(state);
    out = {
      buffer: await encodePNG(surface.w, surface.h, surface.toRGBA8(), { level }),
      width: surface.w,
      height: surface.h,
      mime: 'image/png',
    };
  }
  renderCache.set(key, out);
  while (renderCache.size > RENDER_CACHE_LIMIT) renderCache.delete(renderCache.keys().next().value);
  return { ...out, cached: false };
}

// Calienta fondo, sprites y paleta en segundo plano (al arrancar el bot) para que la primera partida no espere.
async function warmUp() {
  await getPalette();
  await tick();
  getBackground();
}

function clearCaches() {
  backgroundCache = null;
  paletteCache = null;
  renderCache.clear();
}

module.exports = {
  renderBlackjack, drawScene, describeResult, handValue, warmUp, clearCaches, validateState, W, H, LAYOUT, ART,
};
