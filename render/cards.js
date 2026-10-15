'use strict';

// ============================================================
//  CARDS — Cartas dibujadas a mano (vectoriales): índices en las esquinas, pips clásicos,
//  figuras J/Q/K con marco, ases grandes y un reverso temático de Halloween.
//  Cada carta se dibuja una sola vez en un sprite (con sombra incluida) y se reutiliza.
// ============================================================

const {
  Surface, Path, Mat, solid, linearGradient, radialGradient, rasterize, maskSampler,
} = require('./raster');
const { drawText } = require('./font');
const { ART } = require('./emoji-art');

const CARD = {
  w: 112, h: 156, r: 12, pad: 16,
};

const SUIT_INFO = {
  '♠': { red: false }, '♣': { red: false }, '♥': { red: true }, '♦': { red: true },
};

function suitUnit(suit) {
  if (suit === '♥') {
    return new Path()
      .moveTo(0.5, 0.95)
      .cubicTo(0.30, 0.79, 0.03, 0.59, 0.03, 0.31)
      .cubicTo(0.03, 0.13, 0.17, 0.04, 0.31, 0.04)
      .cubicTo(0.42, 0.04, 0.48, 0.11, 0.5, 0.2)
      .cubicTo(0.52, 0.11, 0.58, 0.04, 0.69, 0.04)
      .cubicTo(0.83, 0.04, 0.97, 0.13, 0.97, 0.31)
      .cubicTo(0.97, 0.59, 0.70, 0.79, 0.5, 0.95)
      .close();
  }
  if (suit === '♦') {
    return new Path()
      .moveTo(0.5, 0.0)
      .quadTo(0.6, 0.36, 0.93, 0.5)
      .quadTo(0.6, 0.64, 0.5, 1.0)
      .quadTo(0.4, 0.64, 0.07, 0.5)
      .quadTo(0.4, 0.36, 0.5, 0.0)
      .close();
  }
  if (suit === '♠') {
    return new Path()
      .moveTo(0.5, 0.03)
      .cubicTo(0.70, 0.22, 0.97, 0.40, 0.97, 0.62)
      .cubicTo(0.97, 0.79, 0.84, 0.87, 0.70, 0.87)
      .cubicTo(0.61, 0.87, 0.55, 0.83, 0.52, 0.77)
      .cubicTo(0.53, 0.88, 0.58, 0.95, 0.67, 0.99)
      .lineTo(0.33, 0.99)
      .cubicTo(0.42, 0.95, 0.47, 0.88, 0.48, 0.77)
      .cubicTo(0.45, 0.83, 0.39, 0.87, 0.30, 0.87)
      .cubicTo(0.16, 0.87, 0.03, 0.79, 0.03, 0.62)
      .cubicTo(0.03, 0.40, 0.30, 0.22, 0.5, 0.03)
      .close();
  }
  // trébol
  return new Path()
    .circle(0.5, 0.27, 0.235)
    .circle(0.255, 0.61, 0.235)
    .circle(0.745, 0.61, 0.235)
    .polygon([[0.5, 0.3], [0.77, 0.62], [0.23, 0.62]])
    .polygon([[0.43, 0.55], [0.57, 0.55], [0.67, 0.99], [0.33, 0.99]]);
}

// Ruta del palo centrada en (cx, cy), con alto `size`; `flip` lo gira 180°.
function suitPath(suit, cx, cy, size, flip = false) {
  const unit = suitUnit(suit);
  const place = [size, 0, 0, size, cx - size / 2, cy - size / 2];
  const path = unit.transform(place);
  return flip ? path.transform(Mat.rotateAround(Math.PI, cx, cy)) : path;
}

function suitPaint(suit, cx, cy, size) {
  if (SUIT_INFO[suit].red) {
    return linearGradient(cx - size / 2, cy - size / 2, cx + size / 2, cy + size / 2, [[0, '#ff5d73'], [0.55, '#e11d48'], [1, '#a30d27']]);
  }
  return linearGradient(cx - size / 2, cy - size / 2, cx + size / 2, cy + size / 2, [[0, '#4a4262'], [0.5, '#1d1730'], [1, '#09060f']]);
}

function drawSuit(surface, suit, cx, cy, size, flip = false) {
  const path = suitPath(suit, cx, cy, size, flip);
  surface.fillPath(path, suitPaint(suit, cx, cy, size));
  // brillo suave arriba-izquierda
  surface.fillPath(new Path().ellipse(cx - size * 0.16, cy - size * 0.2, size * 0.1, size * 0.06),
    solid('#ffffff', SUIT_INFO[suit].red ? 0.28 : 0.2));
}

const RANK_LABEL = (rank) => rank;

// Filas de pips (en px relativos a la carta) por rango numérico.
const PIP_COLS = { L: 40, C: 56, R: 72 };
function pipLayout(rank) {
  const top = 38;
  const bottom = 118;
  const mid = 78;
  const four = [top, top + (bottom - top) / 3, top + (2 * (bottom - top)) / 3, bottom];
  const two = (y) => [['L', y], ['R', y]];
  switch (rank) {
    case '2': return [['C', top], ['C', bottom]];
    case '3': return [['C', top], ['C', mid], ['C', bottom]];
    case '4': return [...two(top), ...two(bottom)];
    case '5': return [...two(top), ['C', mid], ...two(bottom)];
    case '6': return [...two(top), ...two(mid), ...two(bottom)];
    case '7': return [...two(top), ['C', (top + mid) / 2], ...two(mid), ...two(bottom)];
    case '8': return [...two(top), ['C', (top + mid) / 2], ...two(mid), ['C', (mid + bottom) / 2], ...two(bottom)];
    case '9': return [...four.flatMap((y) => two(y)), ['C', mid]];
    case '10': return [...four.flatMap((y) => two(y)), ['C', (four[0] + four[1]) / 2], ['C', (four[2] + four[3]) / 2]];
    default: return [];
  }
}

function cardParts(card) {
  return { rank: card.slice(0, -1), suit: card.slice(-1) };
}

function textColor(suit) {
  return SUIT_INFO[suit].red ? '#d11a3c' : '#17112a';
}

function makeFace(card) {
  const { rank, suit } = cardParts(card);
  const {
    w, h, r, pad,
  } = CARD;
  const s = new Surface(w + pad * 2, h + pad * 2);
  const ox = pad;
  const oy = pad;
  const body = new Path().roundRect(ox, oy, w, h, r);
  s.shadowPath(body, {
    dx: 0, dy: 7, blur: 6, color: '#000000', opacity: 0.62,
  });
  s.fillPath(body, solid('#140b22'));
  s.fillPath(new Path().roundRect(ox + 3, oy + 3, w - 6, h - 6, r - 2),
    linearGradient(ox, oy, ox + w, oy + h, [[0, '#fffdf7'], [0.55, '#f8eed6'], [1, '#e8d9b5']]));
  // veladura inferior para dar volumen
  s.fillPath(new Path().roundRect(ox + 3, oy + h * 0.55, w - 6, h * 0.45 - 3, [0, 0, r - 2, r - 2]),
    linearGradient(0, oy + h * 0.55, 0, oy + h, [[0, '#6b4a1a00'], [1, '#6b4a1a22']]));

  // Dibuja en coordenadas de la carta (desplazadas por ox, oy)
  const X = (x) => ox + x;
  const Y = (y) => oy + y;
  const ink = textColor(suit);

  const index = (flip) => {
    const matrix = flip ? Mat.rotateAround(Math.PI, X(w / 2), Y(h / 2)) : null;
    drawText(s, RANK_LABEL(rank), {
      font: 'condensed', size: 40, x: X(7), y: Y(38), align: 'left', fill: ink, matrix, spacing: -1,
    });
    drawSuit(s, suit, X(18), Y(54), 19, flip);
  };
  index(false);
  index(true);

  if (rank === 'A') {
    drawSuit(s, suit, X(w / 2), Y(h / 2 + 2), 66);
    s.fillPath(new Path().circle(X(w / 2), Y(h / 2 + 2), 44, false).circle(X(w / 2), Y(h / 2 + 2), 42.2, true), solid(ink, 0.18));
  } else if (['J', 'Q', 'K'].includes(rank)) {
    const frame = new Path().roundRect(X(24), Y(14), w - 48, h - 28, 9);
    const hole = new Path().roundRect(X(26.5), Y(16.5), w - 53, h - 33, 7, true);
    s.fillPath(new Path().append(frame).append(hole), solid(ink, 0.55));
    // fondo con rayas diagonales muy suaves dentro del marco
    const clip = maskSampler(rasterize(new Path().roundRect(X(26.5), Y(16.5), w - 53, h - 33, 7).flatten(), s.bounds));
    for (let i = -6; i < 12; i += 1) {
      const px = X(24) + i * 12;
      const stripe = new Path().polygon([[px, Y(14)], [px + 5, Y(14)], [px + 5 + (h - 28) * 0.5, Y(h - 14)], [px + (h - 28) * 0.5, Y(h - 14)]]);
      s.fillPath(stripe, solid(ink, 0.06), { clip });
    }
    drawText(s, rank, {
      font: 'display',
      size: 84,
      x: X(w / 2),
      y: Y(h / 2 + 27),
      align: 'center',
      fill: SUIT_INFO[suit].red
        ? linearGradient(0, Y(h / 2 - 40), 0, Y(h / 2 + 30), [[0, '#ff6f86'], [1, '#c4122a']])
        : linearGradient(0, Y(h / 2 - 40), 0, Y(h / 2 + 30), [[0, '#5a5078'], [1, '#150f26']]),
      outline: { color: '#140b22', width: 3 },
    });
    drawSuit(s, suit, X(40), Y(h - 30), 17, true);
    drawSuit(s, suit, X(w - 40), Y(30), 17);
  } else {
    const layout = pipLayout(rank);
    const size = { 2: 30, 3: 30, 4: 25, 5: 25, 6: 22, 7: 21, 8: 21, 9: 18, 10: 18 }[rank] || 22;
    for (const [col, y] of layout) {
      drawSuit(s, suit, X(PIP_COLS[col]), Y(y), size, y > 78 + 0.5);
    }
  }
  return s;
}

function makeBack() {
  const {
    w, h, r, pad,
  } = CARD;
  const s = new Surface(w + pad * 2, h + pad * 2);
  const ox = pad;
  const oy = pad;
  const body = new Path().roundRect(ox, oy, w, h, r);
  s.shadowPath(body, {
    dx: 0, dy: 7, blur: 6, color: '#000000', opacity: 0.62,
  });
  s.fillPath(body, solid('#140b22'));
  const face = new Path().roundRect(ox + 3, oy + 3, w - 6, h - 6, r - 2);
  s.fillPath(face, radialGradient(ox + w / 2, oy + h / 2, h * 0.75, [[0, '#6b32c9'], [0.6, '#3b1a7a'], [1, '#1d0d3d']]));
  const clipMask = rasterize(new Path().roundRect(ox + 11, oy + 11, w - 22, h - 22, 6).flatten(), s.bounds);
  const clip = maskSampler(clipMask);
  // retícula de rombos
  for (let i = -8; i < 16; i += 1) {
    const x = ox + i * 16;
    s.fillPath(new Path().polygon([[x, oy], [x + 1.6, oy], [x + 1.6 + h, oy + h], [x + h, oy + h]]), solid('#ff9a2e', 0.22), { clip });
    s.fillPath(new Path().polygon([[x, oy + h], [x + 1.6, oy + h], [x + 1.6 + h, oy], [x + h, oy]]), solid('#ff9a2e', 0.22), { clip });
  }
  // marco naranja interior
  s.fillPath(new Path().roundRect(ox + 8, oy + 8, w - 16, h - 16, 8).roundRect(ox + 11, oy + 11, w - 22, h - 22, 6, true),
    linearGradient(ox, oy, ox + w, oy + h, [[0, '#ffc45e'], [1, '#e8590c']]));
  // emblema central: calabaza en medallón
  s.fillPath(new Path().circle(ox + w / 2, oy + h / 2, 33), radialGradient(ox + w / 2, oy + h / 2, 33, [[0, '#2a1458'], [1, '#12082b']]));
  s.fillPath(new Path().circle(ox + w / 2, oy + h / 2, 33).circle(ox + w / 2, oy + h / 2, 30, true), solid('#ffb347', 0.9));
  ART.pumpkin(s, ox + w / 2, oy + h / 2 + 1, 50);
  return s;
}

const faceCache = new Map();
let backCache = null;

function getCardSprite(card) {
  if (card === '??') {
    if (!backCache) backCache = makeBack();
    return backCache;
  }
  if (!faceCache.has(card)) faceCache.set(card, makeFace(card));
  return faceCache.get(card);
}

module.exports = {
  CARD, SUIT_INFO, suitPath, drawSuit, getCardSprite, cardParts, suitUnit,
};
