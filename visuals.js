/**
 * ============================================================================
 *  XERION v1.9.1 — visuals.js
 * ----------------------------------------------------------------------------
 *  Toda la capa de diseño usa Components V2 real. El flujo del cofre y todos
 *  los paneles comparten Containers, TextDisplay, Separators y botones para
 *  que las estadísticas se puedan editar sin cambiar de formato de mensaje.
 * ============================================================================
 */

'use strict';

const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  SectionBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  AttachmentBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
} = require('discord.js');
const { createCanvas, loadImage } = require('@napi-rs/canvas');

const {
  CONFIG,
  FEATHER_EMOJI,
  CHEST_TYPE_LIST,
  SHOP_ITEMS,
  formatNumber,
  formatFeatherRange,
  toUnixSeconds,
  rollFeatherAmount,
  computeSpawnChance,
  messagesUntilNextIncrease,
  maybeTipLine,
  highestRoleKey,
  ROLE_FEATHER_BONUS,
  ROLE_PASSIVE_INCOME,
  ACHIEVEMENTS,
  countCompletedAchievements,
  achievementBonusMultiplier,
} = require('./config.js');

// ============================================================================
// MOTOR DE CANVAS — animación de "ruleta" al abrir el cofre.
// Deliberadamente simple: solo rectángulos, degradados y texto plano (sin
// emojis dibujados a mano — los emojis los pone Discord de forma nativa en
// el texto del embed, nunca en el canvas, para que nunca salgan "bugueados").
// Si algo falla aquí, quien lo llama debe capturarlo y degradar sin romper
// la secuencia — ver game.js openChestSequence().
// ============================================================================

const SPIN_W = 780;
const SPIN_H = 230;
const SPIN_CELLS = 5;
const SPIN_CELL_W = SPIN_W / SPIN_CELLS;
const SPIN_CENTER = Math.floor(SPIN_CELLS / 2);

function hexToRgb(hex) {
  return { r: (hex >> 16) & 255, g: (hex >> 8) & 255, b: hex & 255 };
}

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function wrapCenteredText(ctx, text, cx, cy, maxWidth, lineHeight) {
  const words = text.split(' ');
  const lines = [];
  let current = '';
  for (const word of words) {
    const test = current ? `${current} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth && current) {
      lines.push(current);
      current = word;
    } else {
      current = test;
    }
  }
  if (current) lines.push(current);

  const startY = cy - ((lines.length - 1) * lineHeight) / 2;
  lines.forEach((line, i) => ctx.fillText(line, cx, startY + i * lineHeight));
}

function pickFillerReward(table) {
  return table[Math.floor(Math.random() * table.length)];
}

function drawSpinCell(ctx, index, reward, highlighted, iconImg) {
  const x = index * SPIN_CELL_W;
  const pad = 6;
  const w = SPIN_CELL_W - pad * 2;
  const h = SPIN_H - pad * 2;
  const y = pad;
  const radius = 18;
  const isNothing = reward.kind === 'none';
  const { r, g, b } = hexToRgb(reward.color);

  if (highlighted) {
    // Rayos radiantes detrás de la celda ganadora — líneas finas desde el centro, cortadas fuera de la celda.
    ctx.save();
    const burstCx = x + pad + w / 2;
    const burstCy = y + h / 2;
    ctx.globalAlpha = 0.5;
    ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, 0.9)`;
    for (let a = 0; a < 16; a++) {
      const angle = (a / 16) * Math.PI * 2;
      ctx.lineWidth = a % 2 === 0 ? 3 : 1.5;
      ctx.beginPath();
      ctx.moveTo(burstCx + Math.cos(angle) * (h * 0.32), burstCy + Math.sin(angle) * (h * 0.32));
      ctx.lineTo(burstCx + Math.cos(angle) * (h * 0.62), burstCy + Math.sin(angle) * (h * 0.62));
      ctx.stroke();
    }
    ctx.restore();

    // resplandor de color detrás de la celda — más grande que antes para más impacto.
    ctx.save();
    ctx.shadowColor = `rgba(${r}, ${g}, ${b}, 0.95)`;
    ctx.shadowBlur = 42;
    roundRectPath(ctx, x + pad, y, w, h, radius);
    ctx.fillStyle = `rgba(${r}, ${g}, ${b}, 0.02)`;
    ctx.fill();
    ctx.restore();
  }

  // Cuerpo de la celda. NOTHING usa un tratamiento de "vacío" propio (radial
  // oscuro con textura sutil) en vez de simplemente verse apagada.
  if (isNothing) {
    const void_ = ctx.createRadialGradient(x + pad + w / 2, y + h * 0.35, 4, x + pad + w / 2, y + h / 2, h * 0.75);
    void_.addColorStop(0, 'rgba(74, 74, 84, 0.95)');
    void_.addColorStop(1, 'rgba(18, 18, 24, 0.97)');
    ctx.fillStyle = void_;
    roundRectPath(ctx, x + pad, y, w, h, radius);
    ctx.fill();

    // rayas diagonales muy sutiles, tipo "peligro/vacío" — puramente decorativas.
    ctx.save();
    roundRectPath(ctx, x + pad, y, w, h, radius);
    ctx.clip();
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 10;
    for (let sx = -h; sx < w + h; sx += 22) {
      ctx.beginPath();
      ctx.moveTo(x + pad + sx, y + h);
      ctx.lineTo(x + pad + sx + h, y);
      ctx.stroke();
    }
    ctx.restore();
  } else {
    const grad = ctx.createLinearGradient(0, y, 0, y + h);
    grad.addColorStop(0, `rgba(${Math.min(255, r + 25)}, ${Math.min(255, g + 25)}, ${Math.min(255, b + 25)}, 0.97)`);
    grad.addColorStop(0.55, `rgba(${r}, ${g}, ${b}, 0.97)`);
    grad.addColorStop(1, `rgba(${Math.floor(r * 0.42)}, ${Math.floor(g * 0.42)}, ${Math.floor(b * 0.42)}, 0.97)`);
    ctx.fillStyle = grad;
    roundRectPath(ctx, x + pad, y, w, h, radius);
    ctx.fill();
  }

  // Bisel metálico: un highlight claro arriba-izquierda y una sombra oscura
  // abajo-derecha, para que cada celda se sienta tallada, no plana.
  ctx.save();
  roundRectPath(ctx, x + pad, y, w, h, radius);
  ctx.clip();
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.beginPath();
  ctx.moveTo(x + pad + 3, y + h - 3);
  ctx.lineTo(x + pad + 3, y + 3);
  ctx.lineTo(x + pad + w - 3, y + 3);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.beginPath();
  ctx.moveTo(x + pad + 3, y + h - 3);
  ctx.lineTo(x + pad + w - 3, y + h - 3);
  ctx.lineTo(x + pad + w - 3, y + 3);
  ctx.stroke();
  ctx.restore();

  if (highlighted) {
    // brillo diagonal — un solo triángulo semitransparente, barato y sin texto/emoji de por medio.
    ctx.save();
    roundRectPath(ctx, x + pad, y, w, h, radius);
    ctx.clip();
    const shine = ctx.createLinearGradient(x + pad, y, x + pad + w * 0.6, y + h);
    shine.addColorStop(0, 'rgba(255,255,255,0.28)');
    shine.addColorStop(0.4, 'rgba(255,255,255,0.03)');
    shine.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = shine;
    ctx.fillRect(x + pad, y, w, h);
    ctx.restore();

    ctx.lineWidth = 5;
    ctx.strokeStyle = 'rgba(255,255,255,0.95)';
    roundRectPath(ctx, x + pad, y, w, h, radius);
    ctx.stroke();

    // esquinas acentuadas — un detalle de "carta premium" en las 4 puntas.
    const cornerLen = 14;
    ctx.strokeStyle = `rgba(${Math.min(255, r + 60)}, ${Math.min(255, g + 60)}, ${Math.min(255, b + 60)}, 1)`;
    ctx.lineWidth = 3;
    for (const [cx0, cy0, dx, dy] of [
      [x + pad, y, 1, 1],
      [x + pad + w, y, -1, 1],
      [x + pad, y + h, 1, -1],
      [x + pad + w, y + h, -1, -1],
    ]) {
      ctx.beginPath();
      ctx.moveTo(cx0 + dx * (radius + cornerLen), cy0);
      ctx.lineTo(cx0 + dx * radius, cy0);
      ctx.quadraticCurveTo(cx0, cy0, cx0, cy0 + dy * radius);
      ctx.lineTo(cx0, cy0 + dy * (radius + cornerLen));
      ctx.stroke();
    }
  } else {
    ctx.globalAlpha = 0.5;
  }

  const label =
    reward.kind === 'currency' ? `+${reward.amount ?? rollFeatherAmount(reward)}` : reward.label.toUpperCase();

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = 'rgba(0,0,0,0.6)';
  ctx.shadowBlur = highlighted ? 6 : 3;

  if (iconImg) {
    const iconSize = highlighted ? 44 : 28;
    const iconCx = x + pad + w / 2;
    const iconY = y + (highlighted ? 20 : 20);
    ctx.drawImage(iconImg, iconCx - iconSize / 2, iconY, iconSize, iconSize);
    ctx.fillStyle = '#ffffff';
    ctx.font = highlighted ? 'bold 20px sans-serif' : 'bold 14px sans-serif';
    wrapCenteredText(ctx, label, iconCx, iconY + iconSize + (highlighted ? 21 : 16), w - 18, highlighted ? 23 : 17);
  } else {
    ctx.fillStyle = '#ffffff';
    ctx.font = highlighted ? 'bold 22px sans-serif' : 'bold 16px sans-serif';
    wrapCenteredText(ctx, label, x + pad + w / 2, y + h / 2, w - 18, highlighted ? 25 : 19);
  }
  ctx.shadowBlur = 0;
  ctx.globalAlpha = 1;
}

/**
 * Dibuja un frame de la tira giratoria, coloreado según el tipo de cofre.
 * Si se pasa forcedResult, la celda central queda fijada a esa recompensa
 * (se usa en el último frame, el que "gana"); si no, también es aleatoria.
 * iconMap es opcional (Map rewardKey -> Image|null de preloadRewardIcons) —
 * si no se pasa, o si a un reward le falta el icono, se dibuja igual que
 * antes (solo texto), así que nunca es un punto de fallo.
 */
function generateSpinFrame(table, tierColor, forcedResult = null, iconMap = null) {
  const canvas = createCanvas(SPIN_W, SPIN_H);
  const ctx = canvas.getContext('2d');
  const { r, g, b } = hexToRgb(tierColor);
  const centerCx = SPIN_CENTER * SPIN_CELL_W + SPIN_CELL_W / 2;

  // Fondo base
  const bg = ctx.createLinearGradient(0, 0, 0, SPIN_H);
  bg.addColorStop(0, `rgba(${Math.floor(r * 0.3)}, ${Math.floor(g * 0.24)}, ${Math.floor(b * 0.22)}, 1)`);
  bg.addColorStop(1, '#0d0806');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, SPIN_W, SPIN_H);

  // Foco de luz radial detrás de la celda central — le da profundidad al fondo.
  const spotlight = ctx.createRadialGradient(centerCx, SPIN_H / 2, 10, centerCx, SPIN_H / 2, SPIN_H * 0.9);
  spotlight.addColorStop(0, `rgba(${r}, ${g}, ${b}, 0.35)`);
  spotlight.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = spotlight;
  ctx.fillRect(0, 0, SPIN_W, SPIN_H);

  // barra de acento superior e inferior, con un punto más brillante al centro
  for (const barY of [0, SPIN_H - 4]) {
    const bar = ctx.createLinearGradient(0, 0, SPIN_W, 0);
    bar.addColorStop(0, `rgba(${r}, ${g}, ${b}, 0.25)`);
    bar.addColorStop(0.5, `rgba(${Math.min(255, r + 70)}, ${Math.min(255, g + 70)}, ${Math.min(255, b + 70)}, 1)`);
    bar.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0.25)`);
    ctx.fillStyle = bar;
    ctx.fillRect(0, barY, SPIN_W, 4);
  }

  for (let i = 0; i < SPIN_CELLS; i++) {
    const isCenter = i === SPIN_CENTER;
    const reward = isCenter && forcedResult ? forcedResult : pickFillerReward(table);
    drawSpinCell(ctx, i, reward, isCenter, iconMap ? iconMap.get(reward.key) : null);
  }

  // punteros arriba/abajo marcando la celda central, con un pequeño resplandor propio
  ctx.save();
  ctx.shadowColor = '#ffffff';
  ctx.shadowBlur = 8;
  ctx.fillStyle = 'rgba(255,255,255,0.95)';
  ctx.beginPath();
  ctx.moveTo(centerCx - 12, 9);
  ctx.lineTo(centerCx + 12, 9);
  ctx.lineTo(centerCx, 25);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(centerCx - 12, SPIN_H - 5);
  ctx.lineTo(centerCx + 12, SPIN_H - 5);
  ctx.lineTo(centerCx, SPIN_H - 21);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  // difuminado lateral estilo tragamonedas + viñeta suave arriba/abajo
  const fadeW = 110;
  const left = ctx.createLinearGradient(0, 0, fadeW, 0);
  left.addColorStop(0, 'rgba(8,5,4,0.97)');
  left.addColorStop(1, 'rgba(8,5,4,0)');
  ctx.fillStyle = left;
  ctx.fillRect(0, 0, fadeW, SPIN_H);

  const right = ctx.createLinearGradient(SPIN_W - fadeW, 0, SPIN_W, 0);
  right.addColorStop(0, 'rgba(8,5,4,0)');
  right.addColorStop(1, 'rgba(8,5,4,0.97)');
  ctx.fillStyle = right;
  ctx.fillRect(SPIN_W - fadeW, 0, fadeW, SPIN_H);

  return canvas.toBuffer('image/png');
}

function spinFrameAttachment(table, tierColor, forcedResult = null, name = 'spin.png', iconMap = null) {
  const buffer = generateSpinFrame(table, tierColor, forcedResult, iconMap);
  return new AttachmentBuilder(buffer, { name });
}

// ============================================================================
// RULETA DE JUGADORES — misma mecánica visual que la de recompensas, pero
// gira entre avatares y nombres reales (se usa cuando nadie reclama un
// cofre a tiempo y hay que re-sortear ganador). Los avatares se cargan como
// imágenes reales (nunca como texto/emoji dibujado), y si algo falla al
// cargar uno se dibuja un círculo de respaldo — nunca un glifo roto.
// ============================================================================

const avatarImageCache = new Map();

// Códigos de Twemoji (el mismo set de emoji que ya usa Discord en toda su UI,
// así que el resultado se ve consistente con lo que la gente ya conoce — y
// evita depender de la fuente de emoji instalada en el servidor, que fue
// justo lo que causaba el bug original). Si alguno fallara al cargar, el
// icono simplemente no se dibuja — el diseño ya funciona bien sin él.
const REWARD_ICON_CODEPOINTS = {
  ARISE: '1f480',
  KING: '1f451',
  GOAT: '1f410',
  AURA_INFINITE: '1f30c',
  STAR_X: '2b50',
  FEATHERS: '1f525',
  NOTHING: '1f4a8',
};

const emojiImageCache = new Map();

/** Descarga y decodifica un icono de emoji una sola vez; nunca lanza — devuelve null si algo falla. */
async function loadEmojiImage(codepoint) {
  if (!codepoint) return null;
  if (emojiImageCache.has(codepoint)) return emojiImageCache.get(codepoint);
  try {
    const url = `https://cdn.jsdelivr.net/npm/twemoji@14.0.2/assets/72x72/${codepoint}.png`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    const img = await loadImage(buffer);
    emojiImageCache.set(codepoint, img);
    return img;
  } catch (err) {
    console.error(`[Xerion] No se pudo cargar el icono de ${codepoint} para el canvas:`, err.message);
    emojiImageCache.set(codepoint, null); // no reintentar en cada frame de la misma animación
    return null;
  }
}

/** Precarga (y cachea) los iconos que va a necesitar una tabla de recompensas. Devuelve un Map rewardKey -> Image|null. */
async function preloadRewardIcons(table) {
  const entries = await Promise.all(
    table.map(async (r) => [r.key, await loadEmojiImage(REWARD_ICON_CODEPOINTS[r.key])]),
  );
  return new Map(entries);
}

/** Descarga y decodifica un avatar una sola vez; los siguientes usos salen de caché. Nunca lanza — devuelve null si algo falla. */
async function loadAvatarImage(url) {
  if (!url) return null;
  if (avatarImageCache.has(url)) return avatarImageCache.get(url);
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    const img = await loadImage(buffer);
    avatarImageCache.set(url, img);
    return img;
  } catch (err) {
    console.error('[Xerion] No se pudo cargar un avatar para la ruleta:', err.message);
    return null;
  }
}

/** Precarga (y cachea) los avatares de una lista de discord.js Users. Devuelve un Map userId -> Image|null. */
async function preloadPlayerAvatars(users) {
  const entries = await Promise.all(
    users.map(async (user) => [user.id, await loadAvatarImage(user.displayAvatarURL({ extension: 'png', size: 128 }))]),
  );
  return new Map(entries);
}

function drawPlayerCell(ctx, index, user, avatarImg, highlighted) {
  const x = index * SPIN_CELL_W;
  const pad = 6;
  const w = SPIN_CELL_W - pad * 2;
  const h = SPIN_H - pad * 2;
  const y = pad;
  const radius = 18;
  const goldR = 255, goldG = 200, goldB = 90;

  if (highlighted) {
    // mismo tratamiento "premium" que la ruleta de recompensas: rayos + resplandor dorado.
    ctx.save();
    const burstCx = x + pad + w / 2;
    const burstCy = y + h / 2;
    ctx.globalAlpha = 0.5;
    ctx.strokeStyle = `rgba(${goldR}, ${goldG}, ${goldB}, 0.9)`;
    for (let a = 0; a < 16; a++) {
      const angle = (a / 16) * Math.PI * 2;
      ctx.lineWidth = a % 2 === 0 ? 3 : 1.5;
      ctx.beginPath();
      ctx.moveTo(burstCx + Math.cos(angle) * (h * 0.32), burstCy + Math.sin(angle) * (h * 0.32));
      ctx.lineTo(burstCx + Math.cos(angle) * (h * 0.62), burstCy + Math.sin(angle) * (h * 0.62));
      ctx.stroke();
    }
    ctx.restore();

    ctx.save();
    ctx.shadowColor = `rgba(${goldR}, ${goldG}, ${goldB}, 0.9)`;
    ctx.shadowBlur = 40;
    roundRectPath(ctx, x + pad, y, w, h, radius);
    ctx.fillStyle = `rgba(${goldR}, ${goldG}, ${goldB}, 0.02)`;
    ctx.fill();
    ctx.restore();
  }

  const grad = ctx.createLinearGradient(0, y, 0, y + h);
  if (highlighted) {
    grad.addColorStop(0, 'rgba(255, 219, 132, 0.97)');
    grad.addColorStop(0.55, 'rgba(255, 190, 60, 0.97)');
    grad.addColorStop(1, 'rgba(120, 84, 12, 0.97)');
  } else {
    grad.addColorStop(0, 'rgba(92, 92, 104, 0.55)');
    grad.addColorStop(1, 'rgba(24, 24, 32, 0.55)');
  }
  ctx.fillStyle = grad;
  roundRectPath(ctx, x + pad, y, w, h, radius);
  ctx.fill();

  // bisel metálico, igual que en la ruleta de recompensas
  ctx.save();
  roundRectPath(ctx, x + pad, y, w, h, radius);
  ctx.clip();
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.beginPath();
  ctx.moveTo(x + pad + 3, y + h - 3);
  ctx.lineTo(x + pad + 3, y + 3);
  ctx.lineTo(x + pad + w - 3, y + 3);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.beginPath();
  ctx.moveTo(x + pad + 3, y + h - 3);
  ctx.lineTo(x + pad + w - 3, y + h - 3);
  ctx.lineTo(x + pad + w - 3, y + 3);
  ctx.stroke();
  ctx.restore();

  if (highlighted) {
    ctx.lineWidth = 5;
    ctx.strokeStyle = 'rgba(255,255,255,0.95)';
    roundRectPath(ctx, x + pad, y, w, h, radius);
    ctx.stroke();
  } else {
    ctx.globalAlpha = 0.6;
  }

  const cx = x + pad + w / 2;
  const avatarSize = highlighted ? 96 : 74;
  const avatarY = y + 14;

  if (avatarImg) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, avatarY + avatarSize / 2, avatarSize / 2, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(avatarImg, cx - avatarSize / 2, avatarY, avatarSize, avatarSize);
    ctx.restore();
    ctx.lineWidth = highlighted ? 3 : 2;
    ctx.strokeStyle = highlighted ? '#ffffff' : 'rgba(255,255,255,0.5)';
    ctx.beginPath();
    ctx.arc(cx, avatarY + avatarSize / 2, avatarSize / 2, 0, Math.PI * 2);
    ctx.stroke();
  } else {
    // Sin avatar disponible: círculo simple de respaldo, nunca un glifo de texto que pueda salir "bugueado".
    ctx.fillStyle = 'rgba(255,255,255,0.28)';
    ctx.beginPath();
    ctx.arc(cx, avatarY + avatarSize / 2, avatarSize / 2, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = highlighted ? 'bold 17px sans-serif' : 'bold 13px sans-serif';
  const name = (user?.username || user?.globalName || '???').slice(0, 14);
  wrapCenteredText(ctx, name, cx, avatarY + avatarSize + 19, w - 12, highlighted ? 19 : 15);
  ctx.globalAlpha = 1;
}

/**
 * Dibuja un frame de la ruleta de jugadores. Si se pasa forcedWinner, la
 * celda central queda fijada a ese usuario (último frame, el que "gana").
 */
function generatePlayerSpinFrame(users, avatarMap, tierColor, forcedWinner = null) {
  const canvas = createCanvas(SPIN_W, SPIN_H);
  const ctx = canvas.getContext('2d');
  const { r, g, b } = hexToRgb(tierColor);
  const centerCx = SPIN_CENTER * SPIN_CELL_W + SPIN_CELL_W / 2;

  const bg = ctx.createLinearGradient(0, 0, 0, SPIN_H);
  bg.addColorStop(0, `rgba(${Math.floor(r * 0.3)}, ${Math.floor(g * 0.24)}, ${Math.floor(b * 0.22)}, 1)`);
  bg.addColorStop(1, '#0d0806');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, SPIN_W, SPIN_H);

  const spotlight = ctx.createRadialGradient(centerCx, SPIN_H / 2, 10, centerCx, SPIN_H / 2, SPIN_H * 0.9);
  spotlight.addColorStop(0, 'rgba(255, 200, 90, 0.3)');
  spotlight.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = spotlight;
  ctx.fillRect(0, 0, SPIN_W, SPIN_H);

  for (const barY of [0, SPIN_H - 4]) {
    const bar = ctx.createLinearGradient(0, 0, SPIN_W, 0);
    bar.addColorStop(0, `rgba(${r}, ${g}, ${b}, 0.25)`);
    bar.addColorStop(0.5, 'rgba(255, 220, 140, 1)');
    bar.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0.25)`);
    ctx.fillStyle = bar;
    ctx.fillRect(0, barY, SPIN_W, 4);
  }

  for (let i = 0; i < SPIN_CELLS; i++) {
    const isCenter = i === SPIN_CENTER;
    const user = isCenter && forcedWinner ? forcedWinner : users[Math.floor(Math.random() * users.length)];
    drawPlayerCell(ctx, i, user, avatarMap.get(user?.id) || null, isCenter);
  }

  ctx.save();
  ctx.shadowColor = '#ffffff';
  ctx.shadowBlur = 8;
  ctx.fillStyle = 'rgba(255,255,255,0.95)';
  ctx.beginPath();
  ctx.moveTo(centerCx - 12, 9);
  ctx.lineTo(centerCx + 12, 9);
  ctx.lineTo(centerCx, 25);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(centerCx - 12, SPIN_H - 5);
  ctx.lineTo(centerCx + 12, SPIN_H - 5);
  ctx.lineTo(centerCx, SPIN_H - 21);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  const fadeW = 110;
  const left = ctx.createLinearGradient(0, 0, fadeW, 0);
  left.addColorStop(0, 'rgba(8,5,4,0.97)');
  left.addColorStop(1, 'rgba(8,5,4,0)');
  ctx.fillStyle = left;
  ctx.fillRect(0, 0, fadeW, SPIN_H);

  const right = ctx.createLinearGradient(SPIN_W - fadeW, 0, SPIN_W, 0);
  right.addColorStop(0, 'rgba(9,6,4,0)');
  right.addColorStop(1, 'rgba(9,6,4,0.96)');
  ctx.fillStyle = right;
  ctx.fillRect(SPIN_W - fadeW, 0, fadeW, SPIN_H);

  return canvas.toBuffer('image/png');
}

function playerSpinFrameAttachment(users, avatarMap, tierColor, forcedWinner = null, name = 'player-spin.png') {
  const buffer = generatePlayerSpinFrame(users, avatarMap, tierColor, forcedWinner);
  return new AttachmentBuilder(buffer, { name });
}

function buildPlayerSpinContainer(chestType, attachmentName = 'player-spin.png') {
  return new ContainerBuilder()
    .setAccentColor(chestType.color)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`# 🎲 Re-sorteando ganador de ${chestType.name}`))
    .addMediaGalleryComponents(
      new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(`attachment://${attachmentName}`)),
    );
}

// ============================================================================
// COMPONENTS V2 — flujo del cofre (aparición, eliminación, apertura).
// ============================================================================

function buildRewardsFieldValue(table) {
  return table
    .map((r) => {
      if (r.kind === 'role') return `${r.emoji} ${r.mention} — \`${r.chance}%\``;
      if (r.kind === 'currency') return `${r.emoji} **+${formatFeatherRange(r)} Feathers** — \`${r.chance}%\``;
      return `${r.emoji} **${r.label}** — \`${r.chance}%\``;
    })
    .join('\n');
}

/** Panel de aparición del cofre con estadísticas editables en tiempo real. */
function buildChestEmbed({ chestType, participantCount, endsAt, serverStats, disabled = false, mapKey = '' }) {
  const table = chestType.rewardTable;
  const arise = table.find((r) => r.key === 'ARISE');
  const feathers = table.find((r) => r.key === 'FEATHERS');
  const nothing = table.find((r) => r.key === 'NOTHING');
  const chance = computeSpawnChance(serverStats.messages_since_chest || 0);
  const untilNext = messagesUntilNextIncrease(serverStats.messages_since_chest || 0);

  return new ContainerBuilder()
    .setAccentColor(chestType.color)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        [
          `# ${chestType.emoji} Ha aparecido un ${chestType.name}`,
          `-# ${chestType.tierLabel} · Xerion v${CONFIG.VERSION}`,
          '',
          `> ${chestType.flavor}`,
          '',
          'Nadie sabe qué guarda por dentro hasta que alguien lo abre — y solo una persona tendrá esa oportunidad.',
        ].join('\n'),
      ),
    )
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        [
          `**${chestType.emoji} Tipo:** ${chestType.name} · \`${chestType.tierLabel}\``,
          `**🏆 Mejor recompensa:** ${arise.emoji} ${arise.label} · \`${arise.chance}%\``,
          `**${FEATHER_EMOJI} Feathers:** \`${formatFeatherRange(feathers)}\` si no sale un rol`,
          `**📉 Nada:** \`${nothing.chance}%\``,
          `**⏳ Cierra:** <t:${Math.floor(endsAt / 1000)}:R>`,
          `**👥 Participantes:** \`${participantCount}\``,
        ].join('\n'),
      ),
    )
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        [
          `**🗃️ Cofres abiertos en este canal:** ${formatNumber(serverStats.chests_opened_total || 0)}`,
          `**🕰️ Última aparición:** ${serverStats.last_chest_at ? `<t:${toUnixSeconds(serverStats.last_chest_at)}:R>` : 'Es el primero de la historia'}`,
          `**💬 Mensajes del canal:** ${formatNumber(serverStats.message_counter || 0)}`,
          `**📈 Próxima probabilidad:** \`${(chance * 100).toFixed(0)}%\` · sube en \`${untilNext}\` mensajes`,
          '**🛡️ Consejo:** un Escudo o un Amuleto de `/shop` pueden salvarte.',
        ].join('\n'),
      ),
    )
    .addActionRowComponents(buildParticipateRow(disabled, mapKey));
}

function buildParticipateRow(disabled = false, mapKey = '') {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`xerion_participate::${mapKey}`)
      .setLabel('Participate')
      .setEmoji('🎲')
      .setStyle(ButtonStyle.Success)
      .setDisabled(disabled),
  );
}

function buildOpenRow(winnerId, disabled = false, mapKey = '') {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`xerion_open::${winnerId}::${mapKey}`)
      .setLabel('Open')
      .setEmoji('🔓')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(disabled),
  );
}

function buildEmptyChestEmbed(chestType) {
  return new ContainerBuilder()
    .setAccentColor(CONFIG.COLORS.NOTHING)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# ${chestType.emoji} El cofre desapareció\n-# Nadie se atrevió a entrar a tiempo.\n\nEl ${chestType.name} se fue sin dejar rastro.`,
      ),
    );
}

function buildWinnerEmbed(winnerId, { solo = false, chestType, openDeadlineAt = null, mapKey = '' }) {
  const countdown = openDeadlineAt ? `\n\n⏳ **Tienes hasta** <t:${toUnixSeconds(openDeadlineAt)}:R> **para abrirlo** — si no, se re-sortea otro ganador.` : '';
  return new ContainerBuilder()
    .setAccentColor(chestType.color)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        [
          '# 🏆 Tenemos un superviviente',
          (solo
            ? `<@${winnerId}> entró en solitario. Nadie más se presentó — el ${chestType.name} es suyo por derecho.`
            : `<@${winnerId}> ha sobrevivido a todos los demás.\n\nEl ${chestType.name} es tuyo — si te atreves a abrirlo.`) + countdown,
        ].join('\n'),
      ),
    )
    .addActionRowComponents(buildOpenRow(winnerId, false, mapKey));
}

const OPENING_STEPS = ['🔒 The chest creaks open...', '✨ Something stirs inside...'];

function buildOpeningStepEmbed(text, color) {
  return new ContainerBuilder()
    .setAccentColor(color)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`## ${text}\n-# Xerion está resolviendo tu recompensa en tiempo real...`));
}

function buildSpinContainer(chestType, attachmentName = 'spin.png') {
  return new ContainerBuilder()
    .setAccentColor(chestType.color)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`# ${chestType.emoji} Abriendo ${chestType.name}`))
    .addMediaGalleryComponents(
      new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(`attachment://${attachmentName}`)),
    );
}

const RESULT_FLAVOR = {
  ARISE: 'Lo imposible, posible. El cofre casi nunca es tan generoso.',
  KING: 'El cofre te corona. No todos pueden decir lo mismo.',
  GOAT: 'El tercer trono también es tuyo. Muy pocos llegan a esta altura.',
  AURA_INFINITE: 'Pocos llegan tan lejos. Hoy la suerte estuvo de tu lado.',
  STAR_X: 'Tu primera estrella. El comienzo de algo más grande.',
  FEATHERS: 'No es el premio mayor, pero suma para la próxima — o para la tienda.',
  NOTHING: 'El cofre estaba vacío para ti esta vez. Así de cruel es Xerion.',
};

function buildResultEmbed(reward, winnerId, roleGranted, chestType, luckBoosted, wardUsed) {
  const resultLine =
    reward.kind === 'role'
      ? `${reward.emoji} **${reward.label}**`
      : reward.kind === 'currency'
        ? `${reward.emoji} **+${reward.amount} Feathers**`
        : `${reward.emoji} **Nothing**`;

  const lines = [`# ${chestType.emoji} ${chestType.name} abierto`, `<@${winnerId}>`, '', `## ${resultLine}`, '', `*${RESULT_FLAVOR[reward.key]}*`];

  if (luckBoosted) {
    lines.push('', '🍀 **Amuleto consumido:** tus probabilidades de rol fueron un 50% más altas en esta tirada.');
  }

  if (wardUsed) {
    lines.push('', `${SHOP_ITEMS.WARD.emoji} **${SHOP_ITEMS.WARD.name} consumido:** tenías garantizado no sacar "Nothing" en esta tirada.`);
  }

  if (reward.kind === 'role' && !roleGranted) {
    lines.push('', '⚠️ **No pude asignarte el rol:** revisa el permiso `Manage Roles` y la jerarquía. El premio sí quedó guardado.');
  }

  return new ContainerBuilder()
    .setAccentColor(reward.color)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n')));
}

// ============================================================================
// COMPONENTS V2 — paneles de información. Todo con Markdown de Discord:
// encabezados (#), subtexto (-#), negrita, blockquotes, código, timestamps.
// Los mentions AQUÍ SÍ pingarían si no se suprimen — game.js siempre envía
// estos paneles con allowedMentions: SAFE_MENTIONS.
// ============================================================================

const ROLE_LABELS = { ARISE: 'ARISE 💀', KING: 'KING 👑', GOAT: 'GOAT 🐐', AURA_INFINITE: 'AURA INFINITE 🌌', STAR_X: 'STAR X ⭐' };

/** Línea que muestra el beneficio activo de rol (según el más raro que tenga el usuario). */
function roleBenefitLine(stats, heldRoleKeys = []) {
  const key = highestRoleKey(heldRoleKeys);
  const achievementPct = Math.round(achievementBonusMultiplier(stats, heldRoleKeys) * 1000) / 10;
  const achievementPart = achievementPct > 0 ? ` **+${achievementPct}%** por logros` : '';
  if (!key) {
    return achievementPct > 0
      ? `🎁 **Beneficio activo:**${achievementPart} — gana un rol para sumar también el bonus de rareza`
      : '🎁 **Beneficio de rol:** Ninguno todavía — gana un rol o desbloquea logros para sumar un bonus permanente de Feathers.';
  }
  const rolePct = Math.round(ROLE_FEATHER_BONUS[key] * 100);
  return `🎁 **Beneficio activo:** ${ROLE_LABELS[key]} **+${rolePct}%**${achievementPart} — Feathers en cada premio`;
}

/** Añade, solo a veces (ver TIP_SHOW_CHANCE), una línea de tip al final de un container. Muta y devuelve el mismo container. */
function addTipFooter(container) {
  const tip = maybeTipLine();
  if (!tip) return container;
  return container
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# ${tip}`));
}

function buildProfileContainer(stats, discordUser, heldRoleKeys = []) {
  const winRate =
    stats.chests_participated > 0 ? ((stats.chests_won / stats.chests_participated) * 100).toFixed(1) : '0.0';

  const container = new ContainerBuilder()
    .setAccentColor(CONFIG.COLORS.BRAND)
    .addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(`# ${discordUser.username}`),
          new TextDisplayBuilder().setContent('-# Xerion Player Profile'),
        )
        .setThumbnailAccessory((thumb) => thumb.setURL(discordUser.displayAvatarURL({ extension: 'png', size: 128 }))),
    )
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        [
          `${FEATHER_EMOJI} **Feathers:** ${formatNumber(stats.feathers)}`,
          `📈 **Total Earned:** ${formatNumber(stats.total_feathers_earned)}`,
          `🛒 **Total Spent:** ${formatNumber(stats.total_feathers_spent)}`,
          `🏅 **Server Rank:** #${stats.rank} of ${stats.totalPlayers}`,
        ].join('\n'),
      ),
    )
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        [
          `🎯 **Chests Participated:** ${formatNumber(stats.chests_participated)}`,
          `🏆 **Chests Won:** ${formatNumber(stats.chests_won)}`,
          `📊 **Win Rate:** ${winRate}%`,
        ].join('\n'),
      ),
    )
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        [
          `⭐ **STAR X:** ${formatNumber(stats.star_x_count)}${heldRoleKeys.includes('STAR_X') ? ' ✅' : ''}`,
          `🌌 **AURA INFINITE:** ${formatNumber(stats.aura_infinite_count)}${heldRoleKeys.includes('AURA_INFINITE') ? ' ✅' : ''}`,
          `🐐 **GOAT:** ${formatNumber(stats.goat_count)}${heldRoleKeys.includes('GOAT') ? ' ✅' : ''}`,
          `👑 **KING:** ${formatNumber(stats.king_count)}${heldRoleKeys.includes('KING') ? ' ✅' : ''}`,
          `💀 **ARISE:** ${formatNumber(stats.arise_count)}${heldRoleKeys.includes('ARISE') ? ' ✅' : ''}`,
        ].join('\n'),
      ),
    )
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent('-# ✅ = tenés el rol ahora mismo. Los números son cuántas veces lo ganaste en total.'),
    )
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(roleBenefitLine(stats, heldRoleKeys)),
    )
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        [
          `${SHOP_ITEMS.SHIELD.emoji} **Escudos:** ${formatNumber(stats.shields)}`,
          `${SHOP_ITEMS.CHARM.emoji} **Amuletos:** ${formatNumber(stats.luck_charms)}`,
          `${SHOP_ITEMS.REVIVE.emoji} **Plumas Fénix:** ${formatNumber(stats.revives)}`,
        ].join('\n'),
      ),
    )
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# Player since <t:${toUnixSeconds(stats.created_at)}:D>`));
  addTipFooter(container);
  return container;
}

function buildQuickInventoryContainer(stats, discordUser) {
  const container = new ContainerBuilder()
    .setAccentColor(CONFIG.COLORS.FEATHERS)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        [
          `**${discordUser.username}'s Inventory**`,
          `${FEATHER_EMOJI} **${formatNumber(stats.feathers)}** Feathers`,
          `⭐ ${stats.star_x_count}  ·  🌌 ${stats.aura_infinite_count}  ·  🐐 ${stats.goat_count}  ·  👑 ${stats.king_count}  ·  💀 ${stats.arise_count}`,
          `${SHOP_ITEMS.SHIELD.emoji} ${stats.shields} Escudo(s)  ·  ${SHOP_ITEMS.CHARM.emoji} ${stats.luck_charms} Amuleto(s)  ·  ${SHOP_ITEMS.REVIVE.emoji} ${stats.revives} Pluma(s) Fénix`,
        ].join('\n'),
      ),
    )
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent('-# Usa `/profile` para el detalle completo o `/shop` para gastar tus Feathers'));
  return addTipFooter(container);
}

function buildLeaderboardContainer(rows, page = 0, totalPages = 1, ownerId = '') {
  const medals = ['🥇', '🥈', '🥉'];
  const lines = rows.length
    ? rows.map((row, i) => {
      const rank = page * 10 + i + 1;
      const label = row.display_name || row.username || row.resolved_name || `Usuario ${row.user_id.slice(-4)}`;
      return `${medals[rank - 1] || `**#${rank}**`}  **${label}** · <@${row.user_id}> — ${FEATHER_EMOJI} ${formatNumber(row.feathers)}`;
    })
    : ['Todavía no hay usuarios con Feathers. Sé el primero en sobrevivir.'];

  return new ContainerBuilder()
    .setAccentColor(CONFIG.COLORS.FEATHERS)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`# Leaderboard · Top 100\n-# Página ${page + 1} de ${totalPages} · Feathers del servidor`))
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n')))
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`xerion_leaderboard_prev::${page}::${ownerId}`).setLabel('Anterior').setEmoji('◀️').setStyle(ButtonStyle.Secondary).setDisabled(page <= 0),
        new ButtonBuilder().setCustomId(`xerion_leaderboard_next::${page}::${ownerId}`).setLabel('Siguiente').setEmoji('▶️').setStyle(ButtonStyle.Primary).setDisabled(page >= totalPages - 1),
      ),
    );
}

function buildRatesContainer() {
  const container = new ContainerBuilder()
    .setAccentColor(CONFIG.COLORS.ARISE)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent('# Chest Odds\n-# Las probabilidades de los 3 tipos de cofre — el sistema es difícil a propósito'));

  for (const type of CHEST_TYPE_LIST) {
    container
      .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          [
            `### ${type.emoji} ${type.name} — \`${type.tierLabel}\``,
            `> ${type.flavor}`,
            buildRewardsFieldValue(type.rewardTable),
          ].join('\n'),
        ),
      );
  }

  container
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `-# En <#${CONFIG.CHEST_CHANNEL_ID}> empieza en \`${(CONFIG.BASE_SPAWN_CHANCE * 100).toFixed(0)}%\` y sube \`+${(CONFIG.PROBABILITY_STEP_INCREASE * 100).toFixed(0)}%\` cada \`${CONFIG.PROBABILITY_STEP_MESSAGES}\` mensajes del canal sin cofre, hasta \`${(CONFIG.MAX_SPAWN_CHANCE * 100).toFixed(0)}%\`. Ventana de 5 minutos.`,
      ),
    );

  return container;
}

function buildShopContainer(shopCounts, ownerId = '') {
  return new ContainerBuilder()
    .setAccentColor(CONFIG.COLORS.KING)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`# Tienda de Xerion\n-# Tu saldo: ${FEATHER_EMOJI} **${formatNumber(shopCounts.feathers)}** Feathers`))
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        [
          `### ${SHOP_ITEMS.SHIELD.emoji} ${SHOP_ITEMS.SHIELD.name} — \`${SHOP_ITEMS.SHIELD.cost}\` ${FEATHER_EMOJI}`,
          `> ${SHOP_ITEMS.SHIELD.description}`,
          `-# Tienes: **${shopCounts.shields}**`,
        ].join('\n'),
      ),
    )
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        [
          `### ${SHOP_ITEMS.CHARM.emoji} ${SHOP_ITEMS.CHARM.name} — \`${SHOP_ITEMS.CHARM.cost}\` ${FEATHER_EMOJI}`,
          `> ${SHOP_ITEMS.CHARM.description}`,
          `-# Tienes: **${shopCounts.luck_charms}**`,
        ].join('\n'),
      ),
    )
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        [
          `### ${SHOP_ITEMS.REVIVE.emoji} ${SHOP_ITEMS.REVIVE.name} — \`${SHOP_ITEMS.REVIVE.cost}\` ${FEATHER_EMOJI}`,
          `> ${SHOP_ITEMS.REVIVE.description}`,
          `-# Tienes: **${shopCounts.revives}**`,
        ].join('\n'),
      ),
    )
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        [
          `### ${SHOP_ITEMS.WARD.emoji} ${SHOP_ITEMS.WARD.name} — \`${SHOP_ITEMS.WARD.cost}\` ${FEATHER_EMOJI}`,
          `> ${SHOP_ITEMS.WARD.description}`,
          `-# Tienes: **${shopCounts.void_wards}**`,
        ].join('\n'),
      ),
    )
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        [
          `### ${SHOP_ITEMS.TIME_SKIP.emoji} ${SHOP_ITEMS.TIME_SKIP.name} — \`${SHOP_ITEMS.TIME_SKIP.cost}\` ${FEATHER_EMOJI}`,
          `> ${SHOP_ITEMS.TIME_SKIP.description}`,
          `-# Tienes: **${shopCounts.time_skips}**`,
        ].join('\n'),
      ),
    )
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`xerion_buy_shield::${ownerId}`)
          .setLabel(`Escudo (${SHOP_ITEMS.SHIELD.cost})`)
          .setEmoji(SHOP_ITEMS.SHIELD.emoji)
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(`xerion_buy_charm::${ownerId}`)
          .setLabel(`Amuleto (${SHOP_ITEMS.CHARM.cost})`)
          .setEmoji(SHOP_ITEMS.CHARM.emoji)
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(`xerion_buy_revive::${ownerId}`)
          .setLabel(`Pluma Fénix (${SHOP_ITEMS.REVIVE.cost})`)
          .setEmoji(SHOP_ITEMS.REVIVE.emoji)
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(`xerion_buy_ward::${ownerId}`)
          .setLabel(`Vacío (${SHOP_ITEMS.WARD.cost})`)
          .setEmoji(SHOP_ITEMS.WARD.emoji)
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(`xerion_buy_timeskip::${ownerId}`)
          .setLabel(`Acelerador (${SHOP_ITEMS.TIME_SKIP.cost})`)
          .setEmoji(SHOP_ITEMS.TIME_SKIP.emoji)
          .setStyle(ButtonStyle.Secondary),
      ),
    );
}

function buildNotificationContainer(enabled, ownerId = '') {
  return new ContainerBuilder()
    .setAccentColor(enabled ? CONFIG.COLORS.KING : CONFIG.COLORS.NOTHING)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        [
          '# Notificaciones de Cofre',
          '-# Recibe un DM en cuanto aparezca un cofre en el servidor',
          '',
          enabled ? '🔔 **Estado actual: Activadas**' : '🔕 **Estado actual: Desactivadas**',
        ].join('\n'),
      ),
    )
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`xerion_notif_toggle::${ownerId}`)
          .setLabel(enabled ? 'Desactivar' : 'Activar')
          .setEmoji(enabled ? '🔕' : '🔔')
          .setStyle(enabled ? ButtonStyle.Danger : ButtonStyle.Success),
      ),
    );
}

function buildStatsContainer(serverStats) {
  const chance = computeSpawnChance(serverStats.messages_since_chest);
  const untilNext = messagesUntilNextIncrease(serverStats.messages_since_chest);

  const container = new ContainerBuilder()
    .setAccentColor(CONFIG.COLORS.BRAND)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`# Xerion Server Stats\n-# v${CONFIG.VERSION}`))
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        [
          `🗃️ **Cofres aparecidos:** ${formatNumber(serverStats.chests_spawned_total)}`,
          `🔓 **Cofres abiertos:** ${formatNumber(serverStats.chests_opened_total)}`,
          `💬 **Mensajes procesados:** ${formatNumber(serverStats.message_counter)}`,
          `👥 **Jugadores registrados:** ${formatNumber(serverStats.totalPlayers)}`,
          `${FEATHER_EMOJI} **Feathers en circulación:** ${formatNumber(serverStats.totalFeathersInCirculation)}`,
        ].join('\n'),
      ),
    )
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        [
          `📈 **Probabilidad actual de cofre:** \`${(chance * 100).toFixed(0)}%\``,
          `⏭️ **Sube de nuevo en:** \`${untilNext}\` mensajes`,
          `🕰️ **Última aparición:** ${serverStats.last_chest_at ? `<t:${toUnixSeconds(serverStats.last_chest_at)}:R>` : 'Aún no ha aparecido ninguno'}`,
        ].join('\n'),
      ),
    );
  return addTipFooter(container);
}

/** Panel enviado por DM a quien tenga las notificaciones activadas cuando aparece un cofre. */
function buildChestAlertContainer(chestType, jumpUrl) {
  return new ContainerBuilder()
    .setAccentColor(chestType.color)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        [
          `# ${chestType.emoji} ¡Ha aparecido un ${chestType.name}!`,
          `-# ${chestType.tierLabel} · Xerion v${CONFIG.VERSION}`,
          '',
          'Tienes **5 minutos** para entrar antes de que se cierre.',
          '',
          jumpUrl,
        ].join('\n'),
      ),
    )
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent('-# Desactiva estos avisos cuando quieras con `/notification`'),
    );
}

function buildHelpContainer() {
  const container = new ContainerBuilder()
    .setAccentColor(CONFIG.COLORS.BRAND)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`# Xerion\n-# v${CONFIG.VERSION} · Chest-drop & elimination game`))
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        [
           '**Comandos de Jugador**',
          '`/profile` [`xn profile`] — tus estadísticas completas',
          '`/inventory` [`xn inv`] — balance rápido',
          '`/leaderboard` [`xn top`] — top Feather holders',
          '`/rates` [`xn rates`] — probabilidades de los 3 tipos de cofre',
          '`/shop` [`xn shop`] — gasta tus Feathers en Escudos, Amuletos y Plumas Fénix',
          '`/notification` [`xn notif`] — activa o desactiva los DM de cofre',
          '`/stats` [`xn stats`] — estadísticas del servidor',
           '`/help` [`xn help`] — este menú',
           '`/chest` [`xn chest`] — estado del cofre y probabilidad actual',
           '`/daily` [`xn daily`] — reclama 25 Feathers cada 24 horas y suma racha',
           '`/claim` [`xn claim`] — recolecta las Feathers pasivas que dan tus roles',
           '`/history` [`xn history`] — últimas recompensas obtenidas',
           '`/achievements` [`xn achievements`] — logros desbloqueados',
           '`/rank` [`xn rank`] — tu posición y progreso',
           '`/rewards` [`xn rewards`] — resumen de recompensas',
           '`/streak` [`xn streak`] — tu racha de dailies, y si se muestra en tu apodo',
           '`/ping` [`xn ping`] — latencia actual del bot',
           '`/about` [`xn about`] — versión y estado de Xerion',
           '`/rules` [`xn rules`] — reglas rápidas del juego',
        ].join('\n'),
      ),
    )
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(['**Comando de Administrador**', '`/spawn` [`xn spawn`] — fuerza la aparición de un cofre (opcionalmente elige el tipo), sin importar si ya hay uno activo — máximo 5 a la vez, uno cada 30s'].join('\n')),
    )
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        ['**Habla con Xerion**', 'Mencióname (`@Xerion`) o responde a uno de mis mensajes generados por IA para charlar.'].join('\n'),
      ),
    )
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        [
          '> Un cofre puede aparecer en cualquier momento en el canal designado — y entre más tiempo pase sin uno, más sube la probabilidad.',
          '> Cuando aparezca, todos tienen 5 minutos para participar, pero solo una persona se lo lleva.',
        ].join('\n'),
      ),
    );
  return addTipFooter(container);
}

function buildSimpleContainer(title, subtitle, lines, accent = CONFIG.COLORS.BRAND) {
  const container = new ContainerBuilder()
    .setAccentColor(accent)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`# ${title}\n-# ${subtitle}`))
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n')));
  return addTipFooter(container);
}

function buildDailyContainer(result) {
  return buildSimpleContainer(
    'Daily Drop',
    result.claimed ? 'Recompensa reclamada' : 'Todavía no está disponible',
    result.claimed
      ? [
          `✅ Recibiste **+${result.reward} Feathers**.`,
          `${FEATHER_EMOJI} Saldo actual: **${formatNumber(result.feathers)}**`,
          `📅 Dailies reclamadas: **${result.daily_claims}**`,
          `🔥 Racha actual: **${formatNumber(result.current_streak || 0)}** día(s)${result.streak_visible === false ? ' (oculta de tu apodo)' : ''}`,
        ]
      : [`⏱️ Ya reclamaste tu recompensa diaria.`, `Disponible <t:${toUnixSeconds(new Date(new Date(result.last_daily_claim_at).getTime() + 24 * 60 * 60 * 1000))}:R>.`, `${FEATHER_EMOJI} Saldo actual: **${formatNumber(result.feathers)}**`],
    CONFIG.COLORS.FEATHERS,
  );
}

function buildHistoryContainer(rows) {
  const lines = rows.length
    ? rows.map((row, index) => `${index + 1}. **${row.reward_key}**${row.reward_amount ? ` · +${row.reward_amount} Feathers` : ''} · <t:${toUnixSeconds(row.created_at)}:R>`)
    : ['Todavía no has abierto ningún cofre.'];
  return buildSimpleContainer('Historial', 'Tus últimas recompensas', lines, CONFIG.COLORS.BRAND);
}

function buildAchievementsContainer(stats, heldRoleKeys = []) {
  const completed = countCompletedAchievements(stats, heldRoleKeys);
  const bonusPct = Math.round(achievementBonusMultiplier(stats, heldRoleKeys) * 1000) / 10; // 1 decimal
  const lines = ACHIEVEMENTS.map((a) => `${a.check(stats, heldRoleKeys) ? '✅' : '⬜'} **${a.name}** — ${a.description}`);
  lines.push(
    '',
    `🎖️ **${completed}/${ACHIEVEMENTS.length} logros** — +${bonusPct}% Feathers extra por logros desbloqueados`,
  );
  return buildSimpleContainer('Achievements', 'Logros permanentes', lines, CONFIG.COLORS.AURA_INFINITE);
}

function buildRankContainer(stats) {
  return buildSimpleContainer(
    'Tu rango',
    'Progreso en el servidor',
    [
      `🏅 **Posición:** #${stats.rank} de ${stats.totalPlayers}`,
      `${FEATHER_EMOJI} **Feathers:** ${formatNumber(stats.feathers)}`,
      `📈 **Te faltan:** ${formatNumber(Math.max(0, stats.nextRankFeathers || 0))} para subir un puesto`,
      `🏆 **Victorias:** ${formatNumber(stats.chests_won)}`,
    ],
    CONFIG.COLORS.KING,
  );
}

function buildRewardsContainer() {
  const lines = CHEST_TYPE_LIST.map((type) => {
    const best = type.rewardTable.find((reward) => reward.key === 'ARISE');
    const nothing = type.rewardTable.find((reward) => reward.key === 'NOTHING');
    return `${type.emoji} **${type.name}** · ${type.tierLabel}\n> Mejor: ${best.chance}% · Nada: ${nothing.chance}%`;
  });
  return buildSimpleContainer('Rewards', 'Resumen de recompensas', lines, CONFIG.COLORS.ARISE);
}

function buildChestStatusContainer(channelId, state, active) {
  const chance = computeSpawnChance(state.messages_since_chest || 0);
  return buildSimpleContainer(
    'Chest Status',
    `<#${channelId}> · estado en tiempo real`,
    [
      active ? `🟢 **Cofre activo:** ${active.chestType?.name || 'en juego'}` : '⚫ **Cofre activo:** ninguno',
      `💬 **Mensajes desde el último cofre:** ${formatNumber(state.messages_since_chest || 0)}`,
      `📈 **Probabilidad actual:** ${(chance * 100).toFixed(0)}%`,
      `🗃️ **Cofres aparecidos:** ${formatNumber(state.chests_spawned_total || 0)}`,
      `🔓 **Cofres abiertos:** ${formatNumber(state.chests_opened_total || 0)}`,
    ],
    active?.chestType?.color || CONFIG.COLORS.BRAND,
  );
}

/** Panel de resultado para /claim (el ingreso pasivo por rol, no cofres — eso ya lo resuelve el auto re-sorteo). */
function buildRoleIncomeContainer(result) {
  if (!result.hasAnyRole) {
    return buildSimpleContainer(
      'Ingreso de Roles',
      'Todavía no tienes ningún rol',
      [
        '🎁 Cada rol que ganes en un cofre te da Feathers cada cierto tiempo, solo por tenerlo.',
        'Entre más raro el rol, más Feathers da y más tiempo hay que esperar entre cobro y cobro.',
        'Gana tu primer rol en un cofre y vuelve a usar `/claim` cuando esté listo.',
      ],
      CONFIG.COLORS.FEATHERS,
    );
  }

  const lines = [];
  if (result.usedTimeSkip) {
    lines.push(`${SHOP_ITEMS.TIME_SKIP.emoji} **Usaste un ${SHOP_ITEMS.TIME_SKIP.name}** — todo tu ingreso pendiente se completó al instante.`, '');
  }
  if (result.claimed.length > 0) {
    lines.push(`✅ **Recolectaste ${FEATHER_EMOJI} +${formatNumber(result.totalAmount)} Feathers:**`);
    for (const c of result.claimed) {
      lines.push(`${ROLE_LABELS[c.key]} — +${formatNumber(c.amount)} ${FEATHER_EMOJI}`);
    }
  } else {
    lines.push('⏱️ Ningún rol tiene ingreso listo para cobrar todavía.');
  }

  if (result.pending.length > 0) {
    lines.push('', '**Próximos cobros:**');
    for (const p of result.pending) {
      lines.push(`${ROLE_LABELS[p.key]} — listo <t:${toUnixSeconds(p.readyAt)}:R>`);
    }
  }

  return buildSimpleContainer('Ingreso de Roles', 'Recolecta el ingreso pasivo de tus roles', lines, CONFIG.COLORS.FEATHERS);
}

function buildStreakContainer(stats, ownerId = '') {
  const visible = stats.streak_visible !== false;
  const container = new ContainerBuilder()
    .setAccentColor(CONFIG.COLORS.FEATHERS)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        [
          '# Racha de Daily',
          '-# Reclama tu `/daily` todos los días para mantenerla viva',
        ].join('\n'),
      ),
    )
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        [
          `🔥 **Racha actual:** ${formatNumber(stats.current_streak || 0)} día(s)`,
          `🏅 **Mejor racha:** ${formatNumber(stats.best_streak || 0)} día(s)`,
          `📆 **Dailies reclamadas:** ${formatNumber(stats.daily_claims || 0)}`,
        ].join('\n'),
      ),
    )
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        visible
          ? `🔥 **Visibilidad en tu apodo:** Activada — se muestra como \`(🔥${formatNumber(stats.current_streak || 0)})\` al final de tu apodo`
          : '🙈 **Visibilidad en tu apodo:** Desactivada',
      ),
    )
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`xerion_streak_toggle::${ownerId}`)
          .setLabel(visible ? 'Ocultar de mi apodo' : 'Mostrar en mi apodo')
          .setEmoji(visible ? '🙈' : '🔥')
          .setStyle(visible ? ButtonStyle.Secondary : ButtonStyle.Success),
      ),
    );
  return addTipFooter(container);
}

function buildPingContainer(latency) {
  return buildSimpleContainer('Pong', 'Conexión con Discord', [`⚡ **Latencia del bot:** ${latency} ms`, '✅ Xerion está respondiendo.'], CONFIG.COLORS.KING);
}

function buildAboutContainer() {
  return buildSimpleContainer(
    'Xerion',
    `v${CONFIG.VERSION} · Components V2`,
    ['Cofres difíciles, eliminación por rondas y recompensas persistentes.', 'Los contadores de probabilidad están separados por canal.', 'El progreso de usuarios se conserva entre reinicios.'],
    CONFIG.COLORS.BRAND,
  );
}

function buildRulesContainer() {
  return buildSimpleContainer(
    'Reglas',
    'Cómo sobrevivir',
    ['1. Cada 100 mensajes del canal, la probabilidad sube 1%.', '2. Entra al cofre antes de que cierre.', '3. La eliminación decide un único superviviente.', '4. El superviviente abre el cofre y recibe una recompensa.', '5. Usa `/shop` para comprar Escudos y Amuletos.'],
    CONFIG.COLORS.ARISE,
  );
}

module.exports = {
  generateSpinFrame,
  spinFrameAttachment,
  preloadRewardIcons,
  preloadPlayerAvatars,
  generatePlayerSpinFrame,
  playerSpinFrameAttachment,
  buildPlayerSpinContainer,
  buildRewardsFieldValue,
  buildChestEmbed,
  buildParticipateRow,
  buildOpenRow,
  buildEmptyChestEmbed,
  buildWinnerEmbed,
  buildOpeningStepEmbed,
  buildSpinContainer,
  buildResultEmbed,
  OPENING_STEPS,
  buildProfileContainer,
  buildQuickInventoryContainer,
  buildLeaderboardContainer,
  buildRatesContainer,
  buildShopContainer,
  buildNotificationContainer,
  buildChestAlertContainer,
  buildStatsContainer,
  buildHelpContainer,
  buildSimpleContainer,
  buildDailyContainer,
  buildRoleIncomeContainer,
  buildHistoryContainer,
  buildAchievementsContainer,
  buildRankContainer,
  buildRewardsContainer,
  buildChestStatusContainer,
  buildStreakContainer,
  buildPingContainer,
  buildAboutContainer,
  buildRulesContainer,
};
