/**
 * ============================================================================
 *  XERION v1.0
 *  Discord chest-drop & last-one-standing elimination bot — single file build.
 * ----------------------------------------------------------------------------
 *  Stack: discord.js v14 (Components V2) + Express + PostgreSQL (Neon)
 *
 *  Todo lo específico de tu servidor (canal, dueño, roles, probabilidades,
 *  prefijo) vive en el objeto CONFIG de aquí abajo. No deberías necesitar
 *  tocar nada más abajo de esa sección para adaptar el bot a tu server.
 *
 *  Diseño: el flujo del cofre (aparición → eliminación → apertura) usa
 *  embeds clásicos + botones, porque Discord no permite mezclar embeds con
 *  Components V2 en un mismo mensaje, y ese flujo se edita muchas veces en
 *  poco tiempo — los embeds clásicos son más predecibles para eso. Los
 *  paneles de información (/profile, /leaderboard, /rates, /help) usan
 *  Components V2 real (Container, Section, TextDisplay, Separator).
 * ============================================================================
 */

'use strict';

const path = require('node:path');
const express = require('express');
const { Pool } = require('pg');
const {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  SectionBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  MessageFlags,
  AttachmentBuilder,
  ActivityType,
} = require('discord.js');

// ============================================================================
// CONFIG — todo lo ajustable a tu servidor vive aquí.
// ============================================================================

const CONFIG = {
  BOT_NAME: 'Xerion',
  VERSION: '1.0.0',
  PREFIX: 'xn',

  // Secretos / infraestructura — se leen del entorno, nunca se hardcodean.
  TOKEN: process.env.DISCORD_TOKEN,
  CLIENT_ID: process.env.CLIENT_ID,
  GUILD_ID: process.env.GUILD_ID || null, // opcional: registro instantáneo de slash commands
  DATABASE_URL: process.env.DATABASE_URL,
  PORT: process.env.PORT || 3000,

  // Específico de tu servidor
  CHEST_CHANNEL_ID: '1489672925299605555',
  OWNER_ID: '1064678074010058752',

  ROLE_IDS: {
    AURA_INFINITE: '1494579589752684614',
    KING: '1531508465174970518',
    ARISE: '1531512361104572507',
  },

  // Ritmo del sistema de aparición
  MESSAGES_PER_CHECK: 10, // se evalúa cada 10 mensajes en el canal del cofre
  SPAWN_CHANCE: 0.003, // 0.3% por cada checkpoint de 10 mensajes
  JOIN_WINDOW_MS: 5 * 60 * 1000, // 5 minutos para pulsar "Participate"

  // Ritmo del minijuego de eliminación
  INTRO_DELAY_MS: 10_000, // pausa tras el mensaje de inicio, antes de la 1ª eliminación
  ELIMINATION_DELAY_MIN_MS: 2200,
  ELIMINATION_DELAY_MAX_MS: 3400,
  BATCH_THRESHOLD: 10, // por encima de esto, se elimina en lotes; por debajo, de uno en uno
  BATCH_FRACTION: 0.25, // % del grupo restante eliminado por tanda mientras el grupo sea grande

  // Colores de marca (también usados por el motor de canvas)
  COLORS: {
    BRAND: 0xe8442c,
    FEATHERS: 0xff9f43,
    AURA_INFINITE: 0x8b5cf6,
    KING: 0xe8b613,
    ARISE: 0x9d0208,
    NOTHING: 0x57534e,
    DARK: 0x1a1410,
  },
};

// Validación temprana — mejor fallar rápido y con un mensaje claro que a medias.
for (const [key, val] of Object.entries({
  DISCORD_TOKEN: CONFIG.TOKEN,
  CLIENT_ID: CONFIG.CLIENT_ID,
  DATABASE_URL: CONFIG.DATABASE_URL,
})) {
  if (!val) {
    console.error(`[Xerion] Falta la variable de entorno ${key}. Revisa tu .env — el bot no puede arrancar sin ella.`);
    process.exit(1);
  }
}

// ============================================================================
// TABLA DE RECOMPENSAS
// Orden irrelevante para la probabilidad (se acumula), pero se mantiene de
// más rara a más común por legibilidad.
// ============================================================================

const REWARD_TABLE = [
  {
    key: 'ARISE',
    label: 'ARISE',
    emoji: '💀',
    chance: 0.3,
    color: CONFIG.COLORS.ARISE,
    kind: 'role',
    roleId: CONFIG.ROLE_IDS.ARISE,
    mention: `<@&${CONFIG.ROLE_IDS.ARISE}>`,
  },
  {
    key: 'KING',
    label: 'KING',
    emoji: '👑',
    chance: 0.6,
    color: CONFIG.COLORS.KING,
    kind: 'role',
    roleId: CONFIG.ROLE_IDS.KING,
    mention: `<@&${CONFIG.ROLE_IDS.KING}>`,
  },
  {
    key: 'AURA_INFINITE',
    label: 'AURA INFINITE',
    emoji: '🌌',
    chance: 0.9,
    color: CONFIG.COLORS.AURA_INFINITE,
    kind: 'role',
    roleId: CONFIG.ROLE_IDS.AURA_INFINITE,
    mention: `<@&${CONFIG.ROLE_IDS.AURA_INFINITE}>`,
  },
  {
    key: 'FEATHERS',
    label: 'Feathers',
    emoji: '🐦\u200d🔥',
    chance: 7,
    color: CONFIG.COLORS.FEATHERS,
    kind: 'currency',
    amount: 10,
  },
  {
    key: 'NOTHING',
    label: 'Nothing',
    emoji: '💨',
    chance: 91.2,
    color: CONFIG.COLORS.NOTHING,
    kind: 'none',
  },
];

const FEATHER_EMOJI = '🐦\u200d🔥'; // bird + ZWJ + fire — así es como Discord espera el emoji compuesto

function rollReward() {
  const roll = Math.random() * 100;
  let cumulative = 0;
  for (const reward of REWARD_TABLE) {
    cumulative += reward.chance;
    if (roll < cumulative) return reward;
  }
  return REWARD_TABLE[REWARD_TABLE.length - 1]; // red de seguridad ante redondeos de punto flotante
}

function getReward(key) {
  return REWARD_TABLE.find((r) => r.key === key);
}

// ============================================================================
// UTILIDADES GENERALES
// ============================================================================

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function randomInt(maxExclusive) {
  return Math.floor(Math.random() * maxExclusive);
}

function shuffle(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function randomBetween(min, max) {
  return Math.floor(min + Math.random() * (max - min));
}

/** Formatea una lista de nombres al estilo "A, B y C" (conector en español). */
function formatSpanishList(names) {
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(', ')} y ${names[names.length - 1]}`;
}

function formatNumber(n) {
  return new Intl.NumberFormat('en-US').format(n);
}

/** Cooldown simple en memoria: clave -> timestamp de expiración. */
const cooldowns = new Map();
function isOnCooldown(key, ms) {
  const now = Date.now();
  const expiresAt = cooldowns.get(key);
  if (expiresAt && expiresAt > now) return true;
  cooldowns.set(key, now + ms);
  return false;
}

console.log(`[Xerion] Configuración cargada — v${CONFIG.VERSION}`);

// ============================================================================
// BASE DE DATOS (PostgreSQL / Neon)
// Todo lo persistente (usuarios, contador de mensajes) vive aquí, así que
// sobrevive a reinicios del bot. Lo único que se pierde si Render reinicia
// el proceso a mitad de un cofre es el estado de ESE cofre en memoria.
// ============================================================================

const pool = new Pool({
  connectionString: CONFIG.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // requerido por Neon
  max: 5,
});

pool.on('error', (err) => {
  // Un error en una conexión inactiva del pool no debe tumbar el proceso.
  console.error('[Xerion][DB] Error inesperado en el pool de Postgres:', err.message);
});

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS xerion_users (
      user_id TEXT PRIMARY KEY,
      feathers INTEGER NOT NULL DEFAULT 0,
      total_feathers_earned INTEGER NOT NULL DEFAULT 0,
      chests_participated INTEGER NOT NULL DEFAULT 0,
      chests_won INTEGER NOT NULL DEFAULT 0,
      aura_infinite_count INTEGER NOT NULL DEFAULT 0,
      king_count INTEGER NOT NULL DEFAULT 0,
      arise_count INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS xerion_state (
      id SMALLINT PRIMARY KEY DEFAULT 1,
      message_counter INTEGER NOT NULL DEFAULT 0,
      CONSTRAINT xerion_state_singleton CHECK (id = 1)
    );
  `);

  await pool.query(`
    INSERT INTO xerion_state (id, message_counter)
    VALUES (1, 0)
    ON CONFLICT (id) DO NOTHING;
  `);

  console.log('[Xerion][DB] Esquema listo.');
}

async function ensureUser(userId) {
  await pool.query(
    `INSERT INTO xerion_users (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING;`,
    [userId],
  );
}

async function incrementChestsParticipated(userId) {
  await ensureUser(userId);
  await pool.query(
    `UPDATE xerion_users SET chests_participated = chests_participated + 1 WHERE user_id = $1;`,
    [userId],
  );
}

async function incrementChestsWon(userId) {
  await ensureUser(userId);
  await pool.query(
    `UPDATE xerion_users SET chests_won = chests_won + 1 WHERE user_id = $1;`,
    [userId],
  );
}

/** Aplica el resultado de abrir un cofre (feathers, rol, o nada) a las stats del usuario. */
async function applyRewardToUser(userId, reward) {
  await ensureUser(userId);
  if (reward.kind === 'currency') {
    await pool.query(
      `UPDATE xerion_users
       SET feathers = feathers + $2, total_feathers_earned = total_feathers_earned + $2
       WHERE user_id = $1;`,
      [userId, reward.amount],
    );
  } else if (reward.kind === 'role') {
    const column =
      reward.key === 'AURA_INFINITE'
        ? 'aura_infinite_count'
        : reward.key === 'KING'
          ? 'king_count'
          : 'arise_count';
    await pool.query(
      `UPDATE xerion_users SET ${column} = ${column} + 1 WHERE user_id = $1;`,
      [userId],
    );
  }
  // 'none' no toca la fila — no le tocó nada, literalmente.
}

async function getUserStats(userId) {
  await ensureUser(userId);
  const { rows } = await pool.query(`SELECT * FROM xerion_users WHERE user_id = $1;`, [userId]);
  const user = rows[0];

  const { rows: rankRows } = await pool.query(
    `SELECT COUNT(*) + 1 AS rank FROM xerion_users WHERE feathers > $1;`,
    [user.feathers],
  );
  const { rows: totalRows } = await pool.query(`SELECT COUNT(*) AS total FROM xerion_users;`);

  return {
    ...user,
    rank: Number(rankRows[0].rank),
    totalPlayers: Number(totalRows[0].total),
  };
}

async function getLeaderboard(limit = 10) {
  const { rows } = await pool.query(
    `SELECT user_id, feathers FROM xerion_users ORDER BY feathers DESC, user_id ASC LIMIT $1;`,
    [limit],
  );
  return rows;
}

/** Incrementa el contador global de mensajes del canal del cofre de forma atómica. */
async function incrementMessageCounter() {
  const { rows } = await pool.query(
    `UPDATE xerion_state SET message_counter = message_counter + 1 WHERE id = 1 RETURNING message_counter;`,
  );
  return rows[0].message_counter;
}

// ============================================================================
// MOTOR DE CANVAS — animación de "ruleta" al abrir el cofre
// Deliberadamente simple: solo rectángulos, degradados y texto plano (sin
// emojis dibujados a mano — los emojis los pone Discord de forma nativa en
// el texto del embed, nunca en el canvas, para que nunca salgan "bugueados").
// Si algo falla aquí, quien lo llama debe capturarlo y degradar sin romper
// la secuencia — ver openChestForWinner().
// ============================================================================

const { createCanvas } = require('@napi-rs/canvas');

const SPIN_W = 720;
const SPIN_H = 220;
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

function drawSpinCell(ctx, index, reward, highlighted) {
  const x = index * SPIN_CELL_W;
  const pad = 6;
  const w = SPIN_CELL_W - pad * 2;
  const h = SPIN_H - pad * 2;
  const y = pad;
  const radius = 16;
  const { r, g, b } = hexToRgb(reward.color);

  const grad = ctx.createLinearGradient(0, y, 0, y + h);
  grad.addColorStop(0, `rgba(${r}, ${g}, ${b}, 0.95)`);
  grad.addColorStop(1, `rgba(${Math.floor(r * 0.5)}, ${Math.floor(g * 0.5)}, ${Math.floor(b * 0.5)}, 0.95)`);
  ctx.fillStyle = grad;
  roundRectPath(ctx, x + pad, y, w, h, radius);
  ctx.fill();

  if (highlighted) {
    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(255,255,255,0.92)';
    roundRectPath(ctx, x + pad, y, w, h, radius);
    ctx.stroke();
  } else {
    ctx.globalAlpha = 0.55;
  }

  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = highlighted ? 'bold 21px sans-serif' : 'bold 16px sans-serif';
  const label = reward.kind === 'currency' ? `+${reward.amount}` : reward.label.toUpperCase();
  wrapCenteredText(ctx, label, x + pad + w / 2, y + h / 2, w - 18, highlighted ? 24 : 19);
  ctx.globalAlpha = 1;
}

function pickFillerReward() {
  return REWARD_TABLE[randomInt(REWARD_TABLE.length)];
}

/**
 * Dibuja un frame de la tira giratoria. Si se pasa forcedResult, la celda
 * central queda fijada a esa recompensa (se usa en el último frame, el que
 * "gana"); si no, la celda central también es aleatoria (relleno visual).
 */
function generateSpinFrame(forcedResult = null) {
  const canvas = createCanvas(SPIN_W, SPIN_H);
  const ctx = canvas.getContext('2d');

  const bg = ctx.createLinearGradient(0, 0, 0, SPIN_H);
  bg.addColorStop(0, '#26190f');
  bg.addColorStop(1, '#120b08');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, SPIN_W, SPIN_H);

  for (let i = 0; i < SPIN_CELLS; i++) {
    const isCenter = i === SPIN_CENTER;
    const reward = isCenter && forcedResult ? forcedResult : pickFillerReward();
    drawSpinCell(ctx, i, reward, isCenter);
  }

  // punteros arriba/abajo marcando la celda central
  const cx = SPIN_CENTER * SPIN_CELL_W + SPIN_CELL_W / 2;
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.beginPath();
  ctx.moveTo(cx - 11, 5);
  ctx.lineTo(cx + 11, 5);
  ctx.lineTo(cx, 19);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(cx - 11, SPIN_H - 5);
  ctx.lineTo(cx + 11, SPIN_H - 5);
  ctx.lineTo(cx, SPIN_H - 19);
  ctx.closePath();
  ctx.fill();

  // difuminado lateral estilo tragamonedas
  const fadeW = 100;
  const left = ctx.createLinearGradient(0, 0, fadeW, 0);
  left.addColorStop(0, 'rgba(9,6,4,0.95)');
  left.addColorStop(1, 'rgba(9,6,4,0)');
  ctx.fillStyle = left;
  ctx.fillRect(0, 0, fadeW, SPIN_H);

  const right = ctx.createLinearGradient(SPIN_W - fadeW, 0, SPIN_W, 0);
  right.addColorStop(0, 'rgba(9,6,4,0)');
  right.addColorStop(1, 'rgba(9,6,4,0.95)');
  ctx.fillStyle = right;
  ctx.fillRect(SPIN_W - fadeW, 0, fadeW, SPIN_H);

  return canvas.toBuffer('image/png');
}

function spinFrameAttachment(forcedResult = null, name = 'spin.png') {
  const buffer = generateSpinFrame(forcedResult);
  return new AttachmentBuilder(buffer, { name });
}

// ============================================================================
// EMBEDS CLÁSICOS — flujo del cofre (aparición, eliminación, apertura)
// ============================================================================

function toUnixSeconds(date) {
  return Math.floor(new Date(date).getTime() / 1000);
}

function buildRewardsFieldValue() {
  return REWARD_TABLE.map((r) => {
    if (r.kind === 'role') return `${r.emoji} ${r.mention} — \`${r.chance}%\``;
    if (r.kind === 'currency') return `${r.emoji} **+${r.amount} Feathers** — \`${r.chance}%\``;
    return `${r.emoji} **${r.label}** — \`${r.chance}%\``;
  }).join('\n');
}

function buildChestEmbed({ participantCount, endsAt }) {
  return new EmbedBuilder()
    .setColor(CONFIG.COLORS.BRAND)
    .setTitle('⚔️ A Chest Has Appeared')
    .setDescription(
      [
        'Nadie sabe qué guarda por dentro hasta que alguien lo abre — y solo una persona tendrá esa oportunidad.',
        '',
        'Press **Participate** to enter. Cuando el tiempo se agote, el juego empieza.',
      ].join('\n'),
    )
    .addFields(
      { name: '🎁 Possible Rewards', value: buildRewardsFieldValue(), inline: false },
      { name: '⏳ Closes', value: `<t:${Math.floor(endsAt / 1000)}:R>`, inline: true },
      { name: '👥 Participants', value: `${participantCount}`, inline: true },
    )
    .setFooter({ text: `Xerion v${CONFIG.VERSION}` });
}

function buildParticipateRow(disabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('xerion_participate')
      .setLabel('Participate')
      .setEmoji('🎲')
      .setStyle(ButtonStyle.Success)
      .setDisabled(disabled),
  );
}

function buildOpenRow(winnerId, disabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`xerion_open_${winnerId}`)
      .setLabel('Open')
      .setEmoji('🔓')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(disabled),
  );
}

function buildEmptyChestEmbed() {
  return new EmbedBuilder()
    .setColor(CONFIG.COLORS.NOTHING)
    .setTitle('The chest is gone')
    .setDescription('Nadie se atrevió a entrar a tiempo. El cofre desaparece sin dejar rastro.')
    .setFooter({ text: `Xerion v${CONFIG.VERSION}` });
}

function buildWinnerEmbed(winnerId, { solo = false } = {}) {
  return new EmbedBuilder()
    .setColor(CONFIG.COLORS.BRAND)
    .setTitle('🏆 We Have a Survivor')
    .setDescription(
      solo
        ? `<@${winnerId}> entró en solitario. Nadie más se presentó — el cofre es suyo por derecho.`
        : `<@${winnerId}> ha sobrevivido a todos los demás.\n\nEl cofre es tuyo — si te atreves a abrirlo.`,
    );
}

const OPENING_STEPS = [
  '🔒 The chest creaks open...',
  '✨ Something stirs inside...',
];

function buildOpeningStepEmbed(text) {
  return new EmbedBuilder().setColor(CONFIG.COLORS.BRAND).setDescription(`**${text}**`);
}

const RESULT_FLAVOR = {
  ARISE: 'Lo imposible, posible. El cofre casi nunca es tan generoso.',
  KING: 'El cofre te corona. No todos pueden decir lo mismo.',
  AURA_INFINITE: 'Pocos llegan tan lejos. Hoy la suerte estuvo de tu lado.',
  FEATHERS: 'No es el premio mayor, pero suma para la próxima.',
  NOTHING: 'El cofre estaba vacío para ti esta vez. Así de cruel es Xerion.',
};

function buildResultEmbed(reward, winnerId, roleGranted) {
  const resultLine =
    reward.kind === 'role'
      ? `${reward.emoji} **${reward.label}**`
      : reward.kind === 'currency'
        ? `${reward.emoji} **+${reward.amount} Feathers**`
        : `${reward.emoji} **Nothing**`;

  const embed = new EmbedBuilder()
    .setColor(reward.color)
    .setTitle('The chest has opened')
    .setDescription(
      [`<@${winnerId}>`, '', `# ${resultLine}`, '', `*${RESULT_FLAVOR[reward.key]}*`].join('\n'),
    )
    .setFooter({ text: `Xerion v${CONFIG.VERSION}` });

  if (reward.kind === 'role' && !roleGranted) {
    embed.addFields({
      name: '⚠️ Heads up',
      value:
        "No pude asignarte el rol automáticamente — probablemente me falta el permiso **Manage Roles** o mi rol está por debajo del tuyo en la jerarquía. Pide a un admin que lo revise; tu premio ya quedó guardado en tus estadísticas.",
    });
  }

  return embed;
}

// ============================================================================
// COMPONENTS V2 — paneles de información (/profile, /leaderboard, /rates, /help)
// ============================================================================

function buildProfileContainer(stats, discordUser) {
  const winRate =
    stats.chests_participated > 0
      ? ((stats.chests_won / stats.chests_participated) * 100).toFixed(1)
      : '0.0';

  return new ContainerBuilder()
    .setAccentColor(CONFIG.COLORS.BRAND)
    .addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(`# ${discordUser.username}`),
          new TextDisplayBuilder().setContent('-# Xerion Player Profile'),
        )
        .setThumbnailAccessory((thumb) =>
          thumb.setURL(discordUser.displayAvatarURL({ extension: 'png', size: 128 })),
        ),
    )
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        [
          `${FEATHER_EMOJI} **Feathers:** ${formatNumber(stats.feathers)}`,
          `📈 **Total Earned:** ${formatNumber(stats.total_feathers_earned)}`,
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
          `🌌 **AURA INFINITE:** ${formatNumber(stats.aura_infinite_count)}`,
          `👑 **KING:** ${formatNumber(stats.king_count)}`,
          `💀 **ARISE:** ${formatNumber(stats.arise_count)}`,
        ].join('\n'),
      ),
    )
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`-# Player since <t:${toUnixSeconds(stats.created_at)}:D>`),
    );
}

function buildQuickInventoryContainer(stats, discordUser) {
  return new ContainerBuilder()
    .setAccentColor(CONFIG.COLORS.FEATHERS)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        [
          `**${discordUser.username}'s Inventory**`,
          `${FEATHER_EMOJI} **${formatNumber(stats.feathers)}** Feathers`,
          `🌌 ${stats.aura_infinite_count}  ·  👑 ${stats.king_count}  ·  💀 ${stats.arise_count}`,
        ].join('\n'),
      ),
    )
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent('-# Use `/profile` for the full breakdown'));
}

function buildLeaderboardContainer(rows) {
  const medals = ['🥇', '🥈', '🥉'];
  const lines = rows.length
    ? rows.map(
        (row, i) => `${medals[i] || `**#${i + 1}**`}  <@${row.user_id}> — ${FEATHER_EMOJI} ${formatNumber(row.feathers)}`,
      )
    : ['Nobody has earned Feathers yet — be the first to survive a chest.'];

  return new ContainerBuilder()
    .setAccentColor(CONFIG.COLORS.FEATHERS)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent('# Leaderboard\n-# Top Feather holders'))
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n')));
}

function buildRatesContainer() {
  return new ContainerBuilder()
    .setAccentColor(CONFIG.COLORS.ARISE)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent('# Chest Odds\n-# What you can get when the chest opens'))
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(buildRewardsFieldValue()))
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `-# Un cofre puede aparecer en <#${CONFIG.CHEST_CHANNEL_ID}> cada ${CONFIG.MESSAGES_PER_CHECK} mensajes, con ${(CONFIG.SPAWN_CHANCE * 100).toFixed(1)}% de probabilidad.`,
      ),
    );
}

function buildHelpContainer() {
  return new ContainerBuilder()
    .setAccentColor(CONFIG.COLORS.BRAND)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`# Xerion\n-# v${CONFIG.VERSION} · Chest-drop & elimination game`),
    )
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        [
          '**Slash Commands**',
          '`/profile` — view your stats',
          '`/leaderboard` — top Feather holders',
          '`/rates` — chest reward odds',
          '`/help` — this menu',
        ].join('\n'),
      ),
    )
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        [
          `**Prefix Commands** (\`${CONFIG.PREFIX}\`)`,
          `\`${CONFIG.PREFIX} inv\` — quick balance check`,
          `\`${CONFIG.PREFIX} top\` — leaderboard`,
          `\`${CONFIG.PREFIX} help\` — this menu`,
        ].join('\n'),
      ),
    )
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        'Un cofre puede aparecer en cualquier momento en el canal designado. Cuando aparezca, todos tienen 5 minutos para participar — pero solo uno se lo lleva.',
      ),
    );
}

// ============================================================================
// ESTADO DE PARTIDA (en memoria) — un cofre activo como máximo por canal.
// Los datos permanentes (stats, contador de mensajes) ya viven en Postgres;
// esto es solo el estado efímero de la partida en curso.
// ============================================================================

/** @type {Map<string, object>} channelId -> ChestState */
const activeChests = new Map();

const ELIMINATION_PHRASES_SINGLE = [
  '{name} ha sido eliminado.',
  '{name} no lo logró.',
  '{name} se quedó en el camino.',
  'El destino no sonrió hoy para {name}.',
  '{name} cayó, como tantos otros.',
  'Silencio para {name}.',
  '{name} ya no está en el juego.',
  'Otro menos: {name}.',
  '{name} se desvaneció entre la multitud.',
  'Sin piedad — {name} queda fuera.',
];

const ELIMINATION_PHRASES_BATCH = [
  '{name} han sido eliminados.',
  '{name} no lo lograron.',
  'El destino no sonrió hoy para {name}.',
  'Silencio para {name}.',
  'Sin piedad — {name} quedan fuera.',
];

let lastPhraseIndex = -1;
function pickPhrase(pool) {
  let idx = randomInt(pool.length);
  if (pool.length > 1) {
    while (idx === lastPhraseIndex) idx = randomInt(pool.length);
  }
  lastPhraseIndex = idx;
  return pool[idx];
}

async function resolveDisplayName(guild, userId) {
  try {
    const member = await guild.members.fetch(userId);
    return member.displayName;
  } catch {
    return `<@${userId}>`;
  }
}

async function formatEliminationLine(guild, eliminatedIds) {
  const names = await Promise.all(eliminatedIds.map((id) => resolveDisplayName(guild, id)));
  const pool = names.length === 1 ? ELIMINATION_PHRASES_SINGLE : ELIMINATION_PHRASES_BATCH;
  const phrase = pickPhrase(pool);
  const nameText = names.length === 1 ? `**${names[0]}**` : `**${formatSpanishList(names)}**`;
  return phrase.replace('{name}', nameText);
}

function decideBatchSize(remainingCount) {
  if (remainingCount <= CONFIG.BATCH_THRESHOLD) return 1;
  return Math.max(2, Math.floor(remainingCount * CONFIG.BATCH_FRACTION));
}

/**
 * Punto de entrada único para generar un cofre, ya sea automático o forzado
 * con /spawn. Reserva el slot de forma SÍNCRONA antes de cualquier await,
 * para cerrar la ventana de carrera entre una aparición automática y un
 * /spawn casi simultáneos.
 */
async function trySpawnChest(channel) {
  if (activeChests.has(channel.id)) return false;
  activeChests.set(channel.id, { status: 'pending' });
  try {
    await spawnChest(channel);
    return true;
  } catch (err) {
    activeChests.delete(channel.id);
    throw err;
  }
}

async function spawnChest(channel) {
  const endsAt = Date.now() + CONFIG.JOIN_WINDOW_MS;
  const message = await channel.send({
    embeds: [buildChestEmbed({ participantCount: 0, endsAt })],
    components: [buildParticipateRow()],
  });

  const state = activeChests.get(channel.id);
  Object.assign(state, {
    channelId: channel.id,
    messageId: message.id,
    participants: new Set(),
    status: 'waiting',
    endsAt,
    winnerId: null,
    updateScheduled: false,
  });

  state.timeoutHandle = setTimeout(() => {
    resolveJoinPhase(channel, state).catch((err) =>
      console.error('[Xerion] Error resolviendo la fase de unión del cofre:', err),
    );
  }, CONFIG.JOIN_WINDOW_MS);

  console.log(`[Xerion] Cofre generado en #${channel.id} (mensaje ${message.id}).`);
}

function scheduleParticipantCountUpdate(state, message) {
  if (state.updateScheduled) return;
  state.updateScheduled = true;
  setTimeout(async () => {
    state.updateScheduled = false;
    if (state.status !== 'waiting') return;
    const embed = buildChestEmbed({ participantCount: state.participants.size, endsAt: state.endsAt });
    await message.edit({ embeds: [embed] }).catch(() => {});
  }, 2500);
}

async function handleParticipate(interaction) {
  const state = activeChests.get(interaction.channelId);

  if (!state || state.status !== 'waiting') {
    return interaction.reply({ content: 'This chest is no longer active.', flags: MessageFlags.Ephemeral });
  }

  if (state.participants.has(interaction.user.id)) {
    return interaction.reply({ content: "You're already in — good luck.", flags: MessageFlags.Ephemeral });
  }

  state.participants.add(interaction.user.id);
  await interaction.reply({ content: '✅ You are in. Wait for the timer to run out.', flags: MessageFlags.Ephemeral });

  incrementChestsParticipated(interaction.user.id).catch((err) =>
    console.error('[Xerion] Error registrando participación:', err),
  );
  scheduleParticipantCountUpdate(state, interaction.message);
}

async function resolveJoinPhase(channel, state) {
  state.status = 'battling';

  const message = await channel.messages.fetch(state.messageId).catch(() => null);
  if (message) {
    const finalEmbed = buildChestEmbed({ participantCount: state.participants.size, endsAt: state.endsAt });
    await message.edit({ embeds: [finalEmbed], components: [buildParticipateRow(true)] }).catch(() => {});
  }

  const participantIds = [...state.participants];

  if (participantIds.length === 0) {
    await channel.send({ embeds: [buildEmptyChestEmbed()] }).catch(() => {});
    activeChests.delete(channel.id);
    return;
  }

  if (participantIds.length === 1) {
    const winnerId = participantIds[0];
    await incrementChestsWon(winnerId).catch((err) => console.error('[Xerion] Error registrando victoria en solitario:', err));
    state.status = 'awaiting_open';
    state.winnerId = winnerId;
    await channel
      .send({ embeds: [buildWinnerEmbed(winnerId, { solo: true })], components: [buildOpenRow(winnerId)] })
      .catch(() => {});
    return;
  }

  await runBattleRoyale(channel, state, participantIds);
}

async function runBattleRoyale(channel, state, participantIds) {
  await channel.send('**El juego ha comenzado. Buena suerte — la van a necesitar...**').catch(() => {});
  await sleep(CONFIG.INTRO_DELAY_MS);

  let remaining = shuffle(participantIds);

  while (remaining.length > 1) {
    const batchSize = decideBatchSize(remaining.length);
    const eliminated = [];
    for (let i = 0; i < batchSize && remaining.length > 1; i++) {
      const idx = randomInt(remaining.length);
      eliminated.push(remaining[idx]);
      remaining.splice(idx, 1);
    }

    const line = await formatEliminationLine(channel.guild, eliminated);
    await channel.send(line).catch((err) => console.error('[Xerion] Error enviando eliminación:', err));
    await sleep(randomBetween(CONFIG.ELIMINATION_DELAY_MIN_MS, CONFIG.ELIMINATION_DELAY_MAX_MS));
  }

  const winnerId = remaining[0];
  await incrementChestsWon(winnerId).catch((err) => console.error('[Xerion] Error registrando victoria:', err));
  state.status = 'awaiting_open';
  state.winnerId = winnerId;
  await channel.send({ embeds: [buildWinnerEmbed(winnerId)], components: [buildOpenRow(winnerId)] }).catch(() => {});
}

async function grantRewardRole(guild, userId, roleId) {
  try {
    const member = await guild.members.fetch(userId);
    await member.roles.add(roleId);
    return true;
  } catch (err) {
    console.error(`[Xerion] No se pudo asignar el rol ${roleId} a ${userId}:`, err.message);
    return false;
  }
}

async function openChestSequence(channel, winnerId) {
  const seqMessage = await channel
    .send({ embeds: [buildOpeningStepEmbed(OPENING_STEPS[0])] })
    .catch((err) => {
      console.error('[Xerion] No se pudo enviar el mensaje de apertura:', err);
      return null;
    });

  if (seqMessage) {
    await sleep(1100);
    await seqMessage.edit({ embeds: [buildOpeningStepEmbed(OPENING_STEPS[1])] }).catch(() => {});
    await sleep(1100);
  }

  const reward = rollReward();
  let spinSucceeded = false;

  if (seqMessage) {
    try {
      const spinDelays = [500, 550, 650, 800, 1000, 1300, 1700];
      for (let i = 0; i < spinDelays.length; i++) {
        const isLast = i === spinDelays.length - 1;
        const attachment = spinFrameAttachment(isLast ? reward : null);
        await seqMessage.edit({ content: '', embeds: [], files: [attachment], attachments: [] });
        await sleep(spinDelays[i]);
      }
      spinSucceeded = true;
    } catch (err) {
      console.error('[Xerion] El motor de canvas falló a mitad de la animación, se degrada a texto:', err);
    }
  }

  if (!spinSucceeded) {
    const fallbackPayload = { content: '🎰 Rolling...', embeds: [], files: [], attachments: [] };
    if (seqMessage) await seqMessage.edit(fallbackPayload).catch(() => {});
    else await channel.send('🎰 Rolling...').catch(() => {});
    await sleep(900);
  }

  await applyRewardToUser(winnerId, reward).catch((err) =>
    console.error('[Xerion] Error guardando la recompensa en la base de datos:', err),
  );

  let roleGranted = false;
  if (reward.kind === 'role') {
    roleGranted = await grantRewardRole(channel.guild, winnerId, reward.roleId);
  }

  await channel.send({ embeds: [buildResultEmbed(reward, winnerId, roleGranted)] }).catch((err) =>
    console.error('[Xerion] Error enviando el embed de resultado:', err),
  );
}

async function handleOpenChest(interaction) {
  const state = activeChests.get(interaction.channelId);
  const expectedCustomId = state ? `xerion_open_${state.winnerId}` : null;

  if (!state || state.status !== 'awaiting_open' || interaction.customId !== expectedCustomId) {
    return interaction.reply({ content: 'This chest is no longer available to open.', flags: MessageFlags.Ephemeral });
  }

  if (interaction.user.id !== state.winnerId) {
    return interaction.reply({ content: "This isn't your chest to open.", flags: MessageFlags.Ephemeral });
  }

  state.status = 'done';
  await interaction.deferUpdate();
  await interaction.message.edit({ components: [buildOpenRow(state.winnerId, true)] }).catch(() => {});

  activeChests.delete(interaction.channelId);
  await openChestSequence(interaction.channel, state.winnerId);
}

// ============================================================================
// SLASH COMMANDS
// ============================================================================

const slashCommandDefinitions = [
  new SlashCommandBuilder()
    .setName('spawn')
    .setDescription('Force a chest to appear (owner only).')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('profile')
    .setDescription('View your Xerion stats.')
    .addUserOption((opt) => opt.setName('user').setDescription('Whose profile to view').setRequired(false)),

  new SlashCommandBuilder().setName('leaderboard').setDescription('Top Feather holders on the server.'),

  new SlashCommandBuilder().setName('rates').setDescription('See the chest reward odds.'),

  new SlashCommandBuilder().setName('help').setDescription('List all Xerion commands.'),
].map((cmd) => cmd.toJSON());

async function registerSlashCommands() {
  const rest = new REST().setToken(CONFIG.TOKEN);
  const route = CONFIG.GUILD_ID
    ? Routes.applicationGuildCommands(CONFIG.CLIENT_ID, CONFIG.GUILD_ID)
    : Routes.applicationCommands(CONFIG.CLIENT_ID);

  try {
    await rest.put(route, { body: slashCommandDefinitions });
    console.log(
      `[Xerion] Slash commands registrados ${
        CONFIG.GUILD_ID ? `en el servidor ${CONFIG.GUILD_ID} (al instante)` : 'globalmente (puede tardar hasta 1h en propagarse)'
      }.`,
    );
  } catch (err) {
    console.error('[Xerion] Error registrando slash commands:', err);
  }
}

async function cmdSpawn(interaction) {
  if (interaction.user.id !== CONFIG.OWNER_ID) {
    return interaction.reply({ content: 'This command is owner-only.', flags: MessageFlags.Ephemeral });
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const channel = await interaction.client.channels.fetch(CONFIG.CHEST_CHANNEL_ID).catch(() => null);
  if (!channel) return interaction.editReply('No pude encontrar el canal configurado para los cofres.');

  let spawned;
  try {
    spawned = await trySpawnChest(channel);
  } catch (err) {
    console.error('[Xerion] Error forzando la aparición del cofre:', err);
    return interaction.editReply('Something went wrong spawning the chest — check the logs.');
  }

  if (!spawned) return interaction.editReply('There is already an active chest in that channel.');
  return interaction.editReply(`✅ Chest spawned in <#${CONFIG.CHEST_CHANNEL_ID}>.`);
}

async function cmdProfile(interaction) {
  const target = interaction.options.getUser('user') || interaction.user;
  await interaction.deferReply();
  try {
    const stats = await getUserStats(target.id);
    await interaction.editReply({
      components: [buildProfileContainer(stats, target)],
      flags: MessageFlags.IsComponentsV2,
    });
  } catch (err) {
    console.error('[Xerion] Error en /profile:', err);
    await interaction.editReply('Could not load that profile right now — try again in a moment.');
  }
}

async function cmdLeaderboard(interaction) {
  await interaction.deferReply();
  try {
    const rows = await getLeaderboard(10);
    await interaction.editReply({
      components: [buildLeaderboardContainer(rows)],
      flags: MessageFlags.IsComponentsV2,
    });
  } catch (err) {
    console.error('[Xerion] Error en /leaderboard:', err);
    await interaction.editReply('Could not load the leaderboard right now — try again in a moment.');
  }
}

async function cmdRates(interaction) {
  await interaction.reply({ components: [buildRatesContainer()], flags: MessageFlags.IsComponentsV2 });
}

async function cmdHelp(interaction) {
  await interaction.reply({ components: [buildHelpContainer()], flags: MessageFlags.IsComponentsV2 });
}

async function handleSlashCommand(interaction) {
  switch (interaction.commandName) {
    case 'spawn':
      return cmdSpawn(interaction);
    case 'profile':
      return cmdProfile(interaction);
    case 'leaderboard':
      return cmdLeaderboard(interaction);
    case 'rates':
      return cmdRates(interaction);
    case 'help':
      return cmdHelp(interaction);
    default:
      return interaction.reply({ content: 'Unknown command.', flags: MessageFlags.Ephemeral });
  }
}

// ============================================================================
// COMANDOS CON PREFIJO ("xn ...")
// ============================================================================

async function prefixInventory(message) {
  const stats = await getUserStats(message.author.id);
  return message.reply({
    components: [buildQuickInventoryContainer(stats, message.author)],
    flags: MessageFlags.IsComponentsV2,
  });
}

async function prefixLeaderboard(message) {
  const rows = await getLeaderboard(10);
  return message.reply({ components: [buildLeaderboardContainer(rows)], flags: MessageFlags.IsComponentsV2 });
}

async function handlePrefixCommand(message) {
  const withoutPrefix = message.content.slice(CONFIG.PREFIX.length).trim();
  const [sub] = withoutPrefix.split(/\s+/);
  const subcommand = (sub || '').toLowerCase();

  if (isOnCooldown(`prefix:${message.author.id}`, 2000)) return;

  try {
    switch (subcommand) {
      case 'inv':
      case 'inventory':
        return await prefixInventory(message);
      case 'top':
      case 'leaderboard':
        return await prefixLeaderboard(message);
      case 'help':
      case '':
        return await message.reply({ components: [buildHelpContainer()], flags: MessageFlags.IsComponentsV2 });
      default:
        return await message.reply(`Unknown command. Try \`${CONFIG.PREFIX} help\` to see everything I can do.`);
    }
  } catch (err) {
    console.error('[Xerion] Error manejando comando con prefijo:', err);
    await message.reply('Something went wrong — try again in a moment.').catch(() => {});
  }
}

// ============================================================================
// SERVIDOR WEB — página informativa + endpoint de salud para UptimeRobot
// Todo el HTML vive aquí mismo como plantilla, para no salir del archivo único.
// ============================================================================

const REWARD_CARDS_HTML = REWARD_TABLE.map((r) => {
  const pct = r.chance < 1 ? r.chance.toFixed(1) : r.chance;
  const sub =
    r.kind === 'role' ? 'Exclusive server role' : r.kind === 'currency' ? `+${r.amount} currency` : 'Better luck next time';
  const hex = `#${r.color.toString(16).padStart(6, '0')}`;
  return `
        <div class="reward-card" style="--accent:${hex}">
          <span class="reward-emoji">${r.emoji}</span>
          <span class="reward-name">${r.label}</span>
          <span class="reward-pct">${pct}%</span>
          <span class="reward-sub">${sub}</span>
        </div>`;
}).join('\n');

const WEBSITE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Xerion — Chest-drop &amp; elimination bot</title>
<meta name="description" content="Xerion: a Discord bot where a chest can appear at any moment, but only one survivor gets to open it." />
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Anton&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@500;700&display=swap" rel="stylesheet">
<style>
  :root {
    --bg: #0c0805;
    --bg-alt: #150f0a;
    --panel: #1b140d;
    --ember: #ff5a36;
    --ember-dim: #e8442c;
    --gold: #e8b613;
    --violet: #8b5cf6;
    --crimson: #9d0208;
    --ash: #7a7168;
    --text: #f5efe6;
    --text-dim: #b6ab9d;
    --border: rgba(245, 239, 230, 0.08);
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html { scroll-behavior: smooth; }
  body {
    background: radial-gradient(ellipse at 20% -10%, #241609 0%, var(--bg) 45%), var(--bg);
    color: var(--text);
    font-family: 'Inter', sans-serif;
    line-height: 1.6;
    overflow-x: hidden;
  }
  .noise {
    position: fixed; inset: 0; pointer-events: none; z-index: 1; opacity: .035;
    background-image: radial-gradient(circle at 1px 1px, #fff 1px, transparent 0);
    background-size: 3px 3px;
  }
  .wrap { max-width: 980px; margin: 0 auto; padding: 0 24px; position: relative; z-index: 2; }
  .ember-field { position: absolute; inset: 0; overflow: hidden; z-index: 0; pointer-events: none; }
  .ember-dot {
    position: absolute; bottom: -20px; width: 5px; height: 5px; border-radius: 50%;
    background: var(--ember); box-shadow: 0 0 12px 3px rgba(255, 90, 54, .55);
    animation: rise 9s linear infinite;
    opacity: 0;
  }
  @keyframes rise {
    0% { transform: translateY(0) translateX(0); opacity: 0; }
    10% { opacity: .8; }
    90% { opacity: .3; }
    100% { transform: translateY(-620px) translateX(30px); opacity: 0; }
  }
  header.hero {
    position: relative; padding: 120px 24px 90px; text-align: center;
    border-bottom: 1px solid var(--border);
  }
  .badge {
    display: inline-flex; align-items: center; gap: 8px; font-family: 'JetBrains Mono', monospace;
    font-size: 12px; letter-spacing: .06em; color: var(--gold); background: rgba(232,182,19,.1);
    border: 1px solid rgba(232,182,19,.3); padding: 6px 14px; border-radius: 100px; margin-bottom: 28px;
  }
  .badge::before { content: '●'; color: var(--gold); font-size: 8px; }
  h1.wordmark {
    font-family: 'Anton', sans-serif; font-weight: 400; letter-spacing: .02em;
    font-size: clamp(64px, 14vw, 128px); line-height: .95;
    background: linear-gradient(180deg, #fff 0%, #ffd9c9 45%, var(--ember) 100%);
    -webkit-background-clip: text; background-clip: text; color: transparent;
    text-shadow: 0 0 80px rgba(255,90,54,.25);
  }
  .tagline { font-size: clamp(16px, 2.4vw, 20px); color: var(--text-dim); max-width: 560px; margin: 22px auto 0; }
  .tagline strong { color: var(--text); font-weight: 600; }
  section { padding: 84px 24px; position: relative; }
  section.alt { background: linear-gradient(180deg, transparent, rgba(255,255,255,.015) 15%, rgba(255,255,255,.015) 85%, transparent); }
  .eyebrow {
    font-family: 'JetBrains Mono', monospace; font-size: 12px; letter-spacing: .12em; text-transform: uppercase;
    color: var(--ember); margin-bottom: 10px;
  }
  h2 { font-family: 'Anton', sans-serif; font-weight: 400; font-size: clamp(30px, 5vw, 44px); letter-spacing: .01em; margin-bottom: 14px; }
  .lede { color: var(--text-dim); max-width: 620px; font-size: 16px; margin-bottom: 48px; }
  .steps { display: grid; grid-template-columns: repeat(4, 1fr); gap: 20px; counter-reset: step; }
  .step {
    background: var(--panel); border: 1px solid var(--border); border-radius: 14px; padding: 26px 22px;
    position: relative;
  }
  .step-num {
    font-family: 'Anton', sans-serif; font-size: 34px; color: transparent; -webkit-text-stroke: 1.5px var(--ember);
    display: block; margin-bottom: 14px;
  }
  .step h3 { font-size: 16px; margin-bottom: 8px; font-weight: 600; }
  .step p { font-size: 14px; color: var(--text-dim); }
  .rewards-grid { display: grid; grid-template-columns: repeat(5, 1fr); gap: 14px; }
  .reward-card {
    background: linear-gradient(160deg, color-mix(in srgb, var(--accent) 16%, var(--panel)), var(--panel));
    border: 1px solid color-mix(in srgb, var(--accent) 35%, var(--border));
    border-radius: 14px; padding: 22px 14px; text-align: center; display: flex; flex-direction: column; gap: 6px;
  }
  .reward-emoji { font-size: 30px; }
  .reward-name { font-weight: 700; font-size: 13px; letter-spacing: .02em; text-transform: uppercase; color: var(--text); }
  .reward-pct { font-family: 'JetBrains Mono', monospace; font-weight: 700; font-size: 19px; color: var(--accent); }
  .reward-sub { font-size: 11.5px; color: var(--text-dim); }
  .odds-note { margin-top: 22px; font-size: 13px; color: var(--text-dim); font-family: 'JetBrains Mono', monospace; }
  .cmd-table { width: 100%; border-collapse: collapse; background: var(--panel); border: 1px solid var(--border); border-radius: 14px; overflow: hidden; }
  .cmd-table th { text-align: left; font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: var(--text-dim); padding: 14px 18px; border-bottom: 1px solid var(--border); }
  .cmd-table td { padding: 14px 18px; border-bottom: 1px solid var(--border); font-size: 14px; }
  .cmd-table tr:last-child td { border-bottom: none; }
  .cmd-table code { font-family: 'JetBrains Mono', monospace; color: var(--gold); background: rgba(232,182,19,.08); padding: 3px 8px; border-radius: 6px; font-size: 13px; }
  footer { padding: 56px 24px 70px; text-align: center; border-top: 1px solid var(--border); }
  .tech { display: flex; justify-content: center; gap: 10px; flex-wrap: wrap; margin: 18px 0 26px; }
  .tech span {
    font-family: 'JetBrains Mono', monospace; font-size: 11.5px; color: var(--text-dim);
    border: 1px solid var(--border); padding: 5px 12px; border-radius: 100px;
  }
  footer .fine { font-size: 12.5px; color: var(--text-dim); max-width: 480px; margin: 0 auto; }
  footer .ver { font-family: 'JetBrains Mono', monospace; color: var(--ash); font-size: 12px; margin-top: 18px; }
  @media (max-width: 760px) {
    .steps { grid-template-columns: repeat(2, 1fr); }
    .rewards-grid { grid-template-columns: repeat(2, 1fr); }
    header.hero { padding: 90px 20px 64px; }
    section { padding: 60px 20px; }
  }
</style>
</head>
<body>
  <div class="noise"></div>

  <header class="hero">
    <div class="ember-field">
      ${Array.from({ length: 14 })
        .map(
          (_, i) =>
            `<div class="ember-dot" style="left:${(i * 137) % 100}%; animation-delay:${(i * 0.7).toFixed(1)}s; animation-duration:${7 + (i % 5)}s;"></div>`,
        )
        .join('')}
    </div>
    <div class="wrap">
      <div class="badge">v${CONFIG.VERSION} · live on Discord</div>
      <h1 class="wordmark">XERION</h1>
      <p class="tagline">A chest can appear <strong>at any moment</strong>. Everyone who enters thinks it's a giveaway. It isn't.</p>
    </div>
  </header>

  <section>
    <div class="wrap">
      <div class="eyebrow">How it works</div>
      <h2>Four steps. One survivor.</h2>
      <p class="lede">Xerion drops a chest into the server at random. What looks like a simple giveaway is actually the opposite — only the last person standing gets a shot at what's inside.</p>
      <div class="steps">
        <div class="step"><span class="step-num">01</span><h3>A chest appears</h3><p>Rare and unannounced — it can show up after any message in the designated channel.</p></div>
        <div class="step"><span class="step-num">02</span><h3>Everyone enters</h3><p>Press Participate before the 5-minute timer runs out. Looks harmless enough.</p></div>
        <div class="step"><span class="step-num">03</span><h3>Only one remains</h3><p>The moment the timer hits zero, the group is eliminated one by one until a single survivor is left.</p></div>
        <div class="step"><span class="step-num">04</span><h3>Open it — if you dare</h3><p>The survivor pulls the lever. Legendary role, a handful of Feathers, or absolutely nothing.</p></div>
      </div>
    </div>
  </section>

  <section class="alt">
    <div class="wrap">
      <div class="eyebrow">The odds</div>
      <h2>It's called Xerion for a reason.</h2>
      <p class="lede">This isn't a generous loot table. Most chests give nothing at all — but the rare ones are worth the risk.</p>
      <div class="rewards-grid">
        ${REWARD_CARDS_HTML}
      </div>
      <p class="odds-note">Spawn chance: ${(CONFIG.SPAWN_CHANCE * 100).toFixed(1)}% checked every ${CONFIG.MESSAGES_PER_CHECK} messages · 5 minute join window</p>
    </div>
  </section>

  <section>
    <div class="wrap">
      <div class="eyebrow">Commands</div>
      <h2>Slash &amp; prefix, your call.</h2>
      <p class="lede">Prefix commands use <code style="font-family:'JetBrains Mono',monospace;color:var(--gold)">${CONFIG.PREFIX}</code>.</p>
      <table class="cmd-table">
        <tr><th>Command</th><th>Description</th></tr>
        <tr><td><code>/profile</code></td><td>View your Feathers, roles won, rank and win rate</td></tr>
        <tr><td><code>/leaderboard</code></td><td>Top Feather holders on the server</td></tr>
        <tr><td><code>/rates</code></td><td>See the full chest reward odds</td></tr>
        <tr><td><code>/help</code></td><td>List every command</td></tr>
        <tr><td><code>${CONFIG.PREFIX} inv</code></td><td>Quick balance check</td></tr>
        <tr><td><code>${CONFIG.PREFIX} top</code></td><td>Leaderboard, prefix style</td></tr>
        <tr><td><code>${CONFIG.PREFIX} help</code></td><td>Command list, prefix style</td></tr>
      </table>
    </div>
  </section>

  <footer>
    <div class="tech">
      <span>discord.js v14</span>
      <span>Components V2</span>
      <span>PostgreSQL / Neon</span>
      <span>Express</span>
    </div>
    <p class="fine">This page is informational only — there's no dashboard or login here, just what Xerion is and how it plays.</p>
    <p class="ver">Xerion v${CONFIG.VERSION}</p>
  </footer>
</body>
</html>`;

function createWebServer() {
  const app = express();

  app.get('/', (_req, res) => {
    res.type('html').send(WEBSITE_HTML);
  });

  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      bot: CONFIG.BOT_NAME,
      version: CONFIG.VERSION,
      discordReady: client.isReady(),
      uptimeSeconds: Math.floor(process.uptime()),
    });
  });

  return app;
}

// ============================================================================
// CLIENTE DE DISCORD
// ============================================================================

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.Message, Partials.Channel],
});

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`[Xerion] Conectado como ${readyClient.user.tag}.`);

  readyClient.user.setPresence({
    status: 'dnd',
    activities: [{ name: `${CONFIG.PREFIX} help · v${CONFIG.VERSION}`, type: ActivityType.Watching }],
  });

  await registerSlashCommands();
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || !message.guild) return;

  const lowerContent = message.content.toLowerCase();
  if (lowerContent === CONFIG.PREFIX || lowerContent.startsWith(`${CONFIG.PREFIX} `)) {
    return handlePrefixCommand(message);
  }

  if (message.channelId === CONFIG.CHEST_CHANNEL_ID) {
    try {
      const count = await incrementMessageCounter();
      if (count % CONFIG.MESSAGES_PER_CHECK === 0 && Math.random() < CONFIG.SPAWN_CHANCE) {
        await trySpawnChest(message.channel);
      }
    } catch (err) {
      console.error('[Xerion] Error en el contador de mensajes / intento de aparición:', err);
    }
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      await handleSlashCommand(interaction);
    } else if (interaction.isButton()) {
      if (interaction.customId === 'xerion_participate') {
        await handleParticipate(interaction);
      } else if (interaction.customId.startsWith('xerion_open_')) {
        await handleOpenChest(interaction);
      }
    }
  } catch (err) {
    console.error('[Xerion] Error manejando una interacción:', err);
    const payload = { content: 'Something went wrong — try again in a moment.', flags: MessageFlags.Ephemeral };
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp(payload).catch(() => {});
    } else {
      await interaction.reply(payload).catch(() => {});
    }
  }
});

client.on(Events.Error, (err) => console.error('[Xerion] Error del cliente de Discord:', err));

process.on('unhandledRejection', (err) => console.error('[Xerion] Unhandled rejection:', err));
process.on('uncaughtException', (err) => console.error('[Xerion] Uncaught exception:', err));

// ============================================================================
// ARRANQUE
// ============================================================================

async function main() {
  await initDatabase();

  const app = createWebServer();
  const server = app.listen(CONFIG.PORT, () => {
    console.log(`[Xerion] Servidor web escuchando en el puerto ${CONFIG.PORT}.`);
  });

  await client.login(CONFIG.TOKEN);

  const shutdown = async (signal) => {
    console.log(`[Xerion] ${signal} recibido — cerrando de forma ordenada...`);
    server.close();
    client.destroy();
    await pool.end().catch(() => {});
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('[Xerion] Error fatal durante el arranque:', err);
  process.exit(1);
});
