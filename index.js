/* ============================================================================
 *  XERION — v1.0
 *  Bot de Discord con sistema de cofres, ruleta de eliminación y economía.
 *  Un solo archivo. Node.js 18+. discord.js v14 (Components V2) + pg + express.
 * ==========================================================================*/

require('dotenv').config();
const crypto = require('node:crypto');
const express = require('express');
const { Pool } = require('pg');
const {
  Client,
  GatewayIntentBits,
  Partials,
  ActivityType,
  MessageFlags,
  ComponentType,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  SlashCommandBuilder,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
} = require('discord.js');

/* ============================================================================
 *  CONFIGURACIÓN — toca esto para ajustar el bot a tu servidor
 * ==========================================================================*/

const CONFIG = {
  PREFIX: 'xn',
  OWNER_ID: '1064678074010058752',
  CHEST_CHANNEL_ID: '1489672925299605555',

  ROLES: {
    AURA_INFINITE: { id: '1494579589752684614', emoji: '🌌', name: 'AURA INFINITE', chance: 0.9 },
    KING: { id: '1531508465174970518', emoji: '👑', name: 'KING', chance: 0.6 },
    ARISE: { id: '1531512361104572507', emoji: '💀', name: 'ARISE', chance: 0.3 },
  },

  CURRENCY: { emoji: '🐦‍🔥', name: 'Plumas Ardientes', dropAmount: 10, dropChance: 12 },

  MESSAGES_PER_ROLL: 10, // cada cuántos mensajes se intenta un spawn
  SPAWN_CHANCE: 0.3, // % de probabilidad por intento
  JOIN_WINDOW_MS: 5 * 60 * 1000, // 5 minutos para participar
  OPEN_WINDOW_MS: 10 * 60 * 1000, // 10 minutos para que el ganador abra el cofre

  COLOR_PRIMARY: 0xff4d1f,
  COLOR_DANGER: 0x2b2d31,
  COLOR_SUCCESS: 0x2ecc71,
  COLOR_LEGENDARY: 0xffd700,
};

const VERSION = '1.0';

/* ============================================================================
 *  BASE DE DATOS (Neon / Postgres)
 * ==========================================================================*/

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('localhost')
    ? false
    : { rejectUnauthorized: false },
});

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS xerion_users (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      currency BIGINT NOT NULL DEFAULT 0,
      messages_sent BIGINT NOT NULL DEFAULT 0,
      chests_participated INTEGER NOT NULL DEFAULT 0,
      chests_won INTEGER NOT NULL DEFAULT 0,
      aura_infinite_count INTEGER NOT NULL DEFAULT 0,
      king_count INTEGER NOT NULL DEFAULT 0,
      arise_count INTEGER NOT NULL DEFAULT 0,
      registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (guild_id, user_id)
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS xerion_guild_state (
      guild_id TEXT PRIMARY KEY,
      message_counter INTEGER NOT NULL DEFAULT 0
    );
  `);
  console.log('[DB] Tablas listas.');
}

async function ensureUser(guildId, userId) {
  await pool.query(
    `INSERT INTO xerion_users (guild_id, user_id) VALUES ($1, $2)
     ON CONFLICT (guild_id, user_id) DO NOTHING;`,
    [guildId, userId]
  );
}

async function getUser(guildId, userId) {
  await ensureUser(guildId, userId);
  const { rows } = await pool.query(
    `SELECT * FROM xerion_users WHERE guild_id = $1 AND user_id = $2;`,
    [guildId, userId]
  );
  return rows[0];
}

async function incrementMessages(guildId, userId) {
  await ensureUser(guildId, userId);
  await pool.query(
    `UPDATE xerion_users SET messages_sent = messages_sent + 1 WHERE guild_id = $1 AND user_id = $2;`,
    [guildId, userId]
  );
}

async function addCurrency(guildId, userId, amount) {
  await ensureUser(guildId, userId);
  await pool.query(
    `UPDATE xerion_users SET currency = currency + $3 WHERE guild_id = $1 AND user_id = $2;`,
    [guildId, userId, amount]
  );
}

async function registerParticipation(guildId, userId) {
  await ensureUser(guildId, userId);
  await pool.query(
    `UPDATE xerion_users SET chests_participated = chests_participated + 1 WHERE guild_id = $1 AND user_id = $2;`,
    [guildId, userId]
  );
}

async function registerWin(guildId, userId) {
  await ensureUser(guildId, userId);
  await pool.query(
    `UPDATE xerion_users SET chests_won = chests_won + 1 WHERE guild_id = $1 AND user_id = $2;`,
    [guildId, userId]
  );
}

async function registerRoleDrop(guildId, userId, key) {
  const column = { AURA_INFINITE: 'aura_infinite_count', KING: 'king_count', ARISE: 'arise_count' }[key];
  if (!column) return;
  await ensureUser(guildId, userId);
  await pool.query(
    `UPDATE xerion_users SET ${column} = ${column} + 1 WHERE guild_id = $1 AND user_id = $2;`,
    [guildId, userId]
  );
}

async function getLeaderboard(guildId, limit = 10) {
  const { rows } = await pool.query(
    `SELECT user_id, currency, chests_won FROM xerion_users
     WHERE guild_id = $1 ORDER BY currency DESC, chests_won DESC LIMIT $2;`,
    [guildId, limit]
  );
  return rows;
}

async function getRank(guildId, userId) {
  const { rows } = await pool.query(
    `SELECT COUNT(*) + 1 AS rank FROM xerion_users
     WHERE guild_id = $1 AND currency > (
       SELECT currency FROM xerion_users WHERE guild_id = $1 AND user_id = $2
     );`,
    [guildId, userId]
  );
  return rows[0] ? Number(rows[0].rank) : null;
}

async function bumpGuildMessageCounter(guildId) {
  await pool.query(
    `INSERT INTO xerion_guild_state (guild_id, message_counter) VALUES ($1, 1)
     ON CONFLICT (guild_id) DO UPDATE SET message_counter = xerion_guild_state.message_counter + 1;`,
    [guildId]
  );
  const { rows } = await pool.query(
    `SELECT message_counter FROM xerion_guild_state WHERE guild_id = $1;`,
    [guildId]
  );
  return rows[0] ? Number(rows[0].message_counter) : 0;
}

/* ============================================================================
 *  UTILIDADES
 * ==========================================================================*/

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function shuffle(array) {
  const copy = array.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function pick(array) {
  return array[Math.floor(Math.random() * array.length)];
}

function formatPercent(n) {
  return `${n}%`;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function computeEliminationDelay(playerCount) {
  const target = 65000; // duración aproximada objetivo, en ms
  return clamp(Math.floor(target / playerCount), 1100, 2800);
}

const ELIMINATION_LINES = [
  (m) => `💀 **${m}** ha sido eliminado...`,
  (m) => `⚔️ **${m}** no lo logró...`,
  (m) => `🩸 **${m}** cae en esta ronda.`,
  (m) => `🕯️ **${m}** se apaga en la oscuridad...`,
  (m) => `☠️ **${m}** queda fuera del juego.`,
  (m) => `🔻 El destino no fue piadoso con **${m}**.`,
];

function randomEliminationLine(mention) {
  return pick(ELIMINATION_LINES)(mention);
}

/* ============================================================================
 *  ECONOMÍA DEL COFRE — probabilidad de recompensas
 * ==========================================================================*/

function rollChestReward() {
  const roll = Math.random() * 100;
  let acc = 0;

  // Se evalúan primero las recompensas más raras para que no queden "tapadas"
  // por el rango, más ancho, de la moneda.
  const table = [
    { key: 'AURA_INFINITE', chance: CONFIG.ROLES.AURA_INFINITE.chance },
    { key: 'KING', chance: CONFIG.ROLES.KING.chance },
    { key: 'ARISE', chance: CONFIG.ROLES.ARISE.chance },
    { key: 'CURRENCY', chance: CONFIG.CURRENCY.dropChance },
  ];

  for (const entry of table) {
    if (roll < acc + entry.chance) return entry.key;
    acc += entry.chance;
  }
  return 'NONE';
}

async function applyReward(guild, member, guildId, userId, rewardKey) {
  if (rewardKey === 'NONE') {
    return { key: 'NONE', text: 'El cofre estaba vacío. Solo cenizas frías.' };
  }
  if (rewardKey === 'CURRENCY') {
    await addCurrency(guildId, userId, CONFIG.CURRENCY.dropAmount);
    return {
      key: 'CURRENCY',
      text: `+${CONFIG.CURRENCY.dropAmount} ${CONFIG.CURRENCY.emoji} **${CONFIG.CURRENCY.name}**`,
    };
  }

  const roleData = CONFIG.ROLES[rewardKey];
  let assigned = true;
  try {
    if (member) await member.roles.add(roleData.id);
  } catch (err) {
    assigned = false;
    console.error(`[ROLES] No se pudo asignar ${roleData.name}:`, err.message);
  }
  await registerRoleDrop(guildId, userId, rewardKey);
  return {
    key: rewardKey,
    text: assigned
      ? `${roleData.emoji} **${roleData.name}** — <@&${roleData.id}>`
      : `${roleData.emoji} **${roleData.name}** (no se pudo asignar el rol automáticamente, pide a un administrador que te lo dé)`,
    legendary: true,
  };
}

/* ============================================================================
 *  CLIENTE DE DISCORD
 * ==========================================================================*/

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.Message, Partials.Channel],
});

// Eventos de cofre activos, indexados por eventId y por canal
const activeEvents = new Map(); // eventId -> event
const activeChannels = new Set(); // channelId con evento activo

/* ============================================================================
 *  CONSTRUCCIÓN DE EMBEDS (juego del cofre — Embeds clásicos + botones)
 * ==========================================================================*/

function buildRewardsField() {
  const r = CONFIG.ROLES;
  return [
    `${r.AURA_INFINITE.emoji} <@&${r.AURA_INFINITE.id}> — \`${formatPercent(r.AURA_INFINITE.chance)}\``,
    `${r.KING.emoji} <@&${r.KING.id}> — \`${formatPercent(r.KING.chance)}\``,
    `${r.ARISE.emoji} <@&${r.ARISE.id}> — \`${formatPercent(r.ARISE.chance)}\``,
    `${CONFIG.CURRENCY.emoji} +${CONFIG.CURRENCY.dropAmount} ${CONFIG.CURRENCY.name} — \`${formatPercent(CONFIG.CURRENCY.dropChance)}\``,
    `⬛ Nada — probabilidad restante`,
  ].join('\n');
}

function buildChestEmbed({ participants, deadline, closed = false }) {
  const embed = new EmbedBuilder()
    .setColor(closed ? CONFIG.COLOR_DANGER : CONFIG.COLOR_PRIMARY)
    .setTitle(closed ? '🔥 El cofre se ha cerrado' : '🔥 ¡Un cofre de Xerion ha aparecido!')
    .setDescription(
      closed
        ? 'Las inscripciones se cerraron. El destino ya está echado...'
        : 'Algo brilla entre las cenizas. Pulsa **Participar** si te atreves.\n' +
          '_No todos los que entren volverán a salir con las manos vacías... ni con vida en el juego._'
    )
    .addFields(
      { name: '🎁 Recompensas posibles', value: buildRewardsField(), inline: false },
      {
        name: '⏱️ Cierra',
        value: closed ? 'Cerrado' : `<t:${Math.floor(deadline / 1000)}:R>`,
        inline: true,
      },
      { name: '👥 Participantes', value: `${participants}`, inline: true }
    )
    .setFooter({ text: `XERION v${VERSION}` })
    .setTimestamp();

  if (client.user) embed.setThumbnail(client.user.displayAvatarURL());
  return embed;
}

function buildJoinRow(eventId, disabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`xerion_join_${eventId}`)
      .setLabel(disabled ? 'Cerrado' : 'Participar')
      .setEmoji('🔥')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(disabled)
  );
}

function buildOpenRow(eventId, disabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`xerion_open_${eventId}`)
      .setLabel(disabled ? 'Abierto' : 'Abrir')
      .setEmoji('📦')
      .setStyle(ButtonStyle.Success)
      .setDisabled(disabled)
  );
}

/* ============================================================================
 *  LÓGICA DEL COFRE
 * ==========================================================================*/

async function spawnChest(channel) {
  if (activeChannels.has(channel.id)) return null;

  const eventId = crypto.randomUUID();
  const deadline = Date.now() + CONFIG.JOIN_WINDOW_MS;

  const event = {
    id: eventId,
    guildId: channel.guild.id,
    channelId: channel.id,
    participants: new Set(),
    deadline,
    message: null,
    pendingEdit: false,
  };

  const embed = buildChestEmbed({ participants: 0, deadline });
  const row = buildJoinRow(eventId);

  const message = await channel.send({ embeds: [embed], components: [row] });
  event.message = message;

  activeEvents.set(eventId, event);
  activeChannels.add(channel.id);

  const collector = message.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: CONFIG.JOIN_WINDOW_MS,
  });

  collector.on('collect', async (interaction) => {
    if (interaction.customId !== `xerion_join_${eventId}`) return;
    if (event.participants.has(interaction.user.id)) {
      await interaction.reply({ content: '🔥 Ya estás dentro. Ahora solo queda esperar...', flags: MessageFlags.Ephemeral });
      return;
    }
    event.participants.add(interaction.user.id);
    await interaction.reply({ content: '🔥 Has entrado al desafío del cofre. Suerte.', flags: MessageFlags.Ephemeral });
    queueEmbedUpdate(event);
  });

  collector.on('end', async () => {
    await resolveChest(event.guildId, eventId);
  });

  return event;
}

function queueEmbedUpdate(event) {
  if (event.pendingEdit) return;
  event.pendingEdit = true;
  setTimeout(async () => {
    event.pendingEdit = false;
    if (!activeEvents.has(event.id)) return; // el evento ya se cerró, no lo pisamos
    try {
      const embed = buildChestEmbed({ participants: event.participants.size, deadline: event.deadline });
      await event.message.edit({ embeds: [embed], components: [buildJoinRow(event.id)] });
    } catch (err) {
      console.error('[CHEST] Error actualizando embed:', err.message);
    }
  }, 2000);
}

async function resolveChest(guildId, eventId) {
  const event = activeEvents.get(eventId);
  if (!event) return;
  activeEvents.delete(eventId);
  activeChannels.delete(event.channelId);

  const channel = event.message.channel;
  const participants = [...event.participants];

  try {
    const closedEmbed = buildChestEmbed({ participants: participants.length, deadline: event.deadline, closed: true });
    await event.message.edit({ embeds: [closedEmbed], components: [buildJoinRow(eventId, true)] });
  } catch (err) {
    console.error('[CHEST] Error cerrando embed:', err.message);
  }

  if (participants.length === 0) {
    await channel.send('💨 El cofre se desvaneció en el aire. Nadie se atrevió a acercarse.');
    return;
  }

  for (const uid of participants) {
    try {
      await registerParticipation(guildId, uid);
    } catch (err) {
      console.error('[DB] Error registrando participación:', err.message);
    }
  }

  let winnerId;

  if (participants.length === 1) {
    winnerId = participants[0];
    await channel.send(`🥀 Solo <@${winnerId}> se atrevió a acercarse... nadie más se presentó al desafío.`);
  } else {
    await channel.send('🔥 **El juego ha comenzado. Buena suerte. La necesitarán...**');
    await sleep(10000);

    let alive = shuffle(participants);
    const delay = computeEliminationDelay(alive.length);

    while (alive.length > 1) {
      const idx = Math.floor(Math.random() * alive.length);
      const eliminated = alive.splice(idx, 1)[0];
      try {
        await channel.send(randomEliminationLine(`<@${eliminated}>`));
      } catch (err) {
        console.error('[GAME] Error enviando eliminación:', err.message);
      }
      await sleep(delay);
    }

    winnerId = alive[0];
    await channel.send(`⚡ El polvo se asienta... <@${winnerId}> sigue en pie.`);
  }

  await announceWinner(guildId, channel, winnerId);
}

async function announceWinner(guildId, channel, winnerId) {
  try {
    await registerWin(guildId, winnerId);
  } catch (err) {
    console.error('[DB] Error registrando victoria:', err.message);
  }

  const openEventId = crypto.randomUUID();
  const embed = new EmbedBuilder()
    .setColor(CONFIG.COLOR_SUCCESS)
    .setTitle('🏆 Tenemos un sobreviviente')
    .setDescription(`<@${winnerId}> se ha ganado el cofre.\n\nPulsa **Abrir** para reclamar tu recompensa.`)
    .setFooter({ text: `XERION v${VERSION}` })
    .setTimestamp();
  if (client.user) embed.setThumbnail(client.user.displayAvatarURL());

  const message = await channel.send({ embeds: [embed], components: [buildOpenRow(openEventId)] });

  let resolved = false;
  const collector = message.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: CONFIG.OPEN_WINDOW_MS,
    filter: (i) => i.customId === `xerion_open_${openEventId}`,
  });

  collector.on('collect', async (interaction) => {
    if (interaction.user.id !== winnerId) {
      // No consume la ventana del ganador: solo se rechaza a quien no ganó.
      await interaction.reply({ content: '❌ Solo el ganador puede abrir este cofre.', flags: MessageFlags.Ephemeral });
      return;
    }
    resolved = true;
    collector.stop('opened');
    await interaction.deferUpdate();
    await playOpenAnimation(interaction, message, guildId, winnerId);
  });

  collector.on('end', async () => {
    if (!resolved) {
      try {
        await message.edit({ components: [buildOpenRow(openEventId, true)] });
      } catch (err) {
        console.error('[CHEST] Error deshabilitando botón de apertura:', err.message);
      }
    }
  });
}

async function playOpenAnimation(interaction, message, guildId, winnerId) {
  const frames = [
    '🔒 Abriendo el cofre...',
    '📦 Algo se mueve dentro...',
    '✨ Una luz escapa por las grietas...',
    `${pick(['🌌', '👑', '💀', CONFIG.CURRENCY.emoji, '⬛'])} ${pick(['🌌', '👑', '💀', CONFIG.CURRENCY.emoji, '⬛'])} ${pick(['🌌', '👑', '💀', CONFIG.CURRENCY.emoji, '⬛'])}`,
    `${pick(['🌌', '👑', '💀', CONFIG.CURRENCY.emoji, '⬛'])} ${pick(['🌌', '👑', '💀', CONFIG.CURRENCY.emoji, '⬛'])} ${pick(['🌌', '👑', '💀', CONFIG.CURRENCY.emoji, '⬛'])}`,
  ];

  const animEmbed = new EmbedBuilder().setColor(CONFIG.COLOR_PRIMARY).setTitle('📦 Abriendo cofre...');

  for (const frame of frames) {
    try {
      await message.edit({ embeds: [animEmbed.setDescription(frame)], components: [] });
    } catch (err) {
      console.error('[ANIM] Error en animación:', err.message);
    }
    await sleep(700);
  }

  const rewardKey = rollChestReward();
  const guild = message.guild;
  let member = null;
  try {
    member = await guild.members.fetch(winnerId);
  } catch (err) {
    console.error('[GAME] No se pudo obtener el miembro ganador:', err.message);
  }

  const result = await applyReward(guild, member, guildId, winnerId, rewardKey);

  const finalEmbed = new EmbedBuilder()
    .setColor(result.legendary ? CONFIG.COLOR_LEGENDARY : result.key === 'NONE' ? CONFIG.COLOR_DANGER : CONFIG.COLOR_SUCCESS)
    .setTitle(result.legendary ? '🌟 ¡RECOMPENSA LEGENDARIA!' : result.key === 'NONE' ? '💨 Cofre vacío' : '🎉 ¡Recompensa obtenida!')
    .setDescription(`<@${winnerId}> abrió el cofre y obtuvo:\n\n${result.text}`)
    .setFooter({ text: `XERION v${VERSION}` })
    .setTimestamp();
  if (client.user) finalEmbed.setThumbnail(client.user.displayAvatarURL());

  try {
    await message.edit({ embeds: [finalEmbed], components: [] });
  } catch (err) {
    console.error('[ANIM] Error al mostrar recompensa final:', err.message);
  }
}

/* ============================================================================
 *  COMPONENTS V2 — paneles de información (perfil, ranking, ayuda, tasas, ping)
 * ==========================================================================*/

function statLine(label, value) {
  return `**${label}:** ${value}`;
}

async function buildProfileContainer(guild, targetUser) {
  const row = await getUser(guild.id, targetUser.id);
  const rank = await getRank(guild.id, targetUser.id);
  const winRate = row.chests_participated > 0
    ? ((row.chests_won / row.chests_participated) * 100).toFixed(1)
    : '0.0';
  const registeredTs = Math.floor(new Date(row.registered_at).getTime() / 1000);

  const container = new ContainerBuilder()
    .setAccentColor(CONFIG.COLOR_PRIMARY)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`## 📊 Perfil de ${targetUser.username}`)
    )
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small))
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        [
          statLine(`${CONFIG.CURRENCY.emoji} Saldo`, `${row.currency} ${CONFIG.CURRENCY.name}`),
          statLine('📨 Mensajes enviados', row.messages_sent),
          statLine('🎲 Cofres participados', row.chests_participated),
          statLine('🏆 Cofres ganados', row.chests_won),
          statLine('📈 Tasa de victoria', `${winRate}%`),
        ].join('\n')
      )
    )
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small))
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        [
          statLine('🌌 AURA INFINITE obtenidas', row.aura_infinite_count),
          statLine('👑 KING obtenidas', row.king_count),
          statLine('💀 ARISE obtenidas', row.arise_count),
          statLine('🕰️ Miembro de Xerion desde', `<t:${registeredTs}:D>`),
          statLine('🏅 Posición en el ranking', rank ? `#${rank}` : 'Sin datos'),
        ].join('\n')
      )
    )
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small))
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`xerion_refresh_profile_${targetUser.id}`)
          .setLabel('Actualizar')
          .setEmoji('🔄')
          .setStyle(ButtonStyle.Secondary)
      )
    );

  return container;
}

async function buildLeaderboardContainer(guild) {
  const rows = await getLeaderboard(guild.id, 10);
  const medals = ['🥇', '🥈', '🥉'];

  const lines = rows.length
    ? rows.map((r, i) => {
        const medal = medals[i] || `\`#${i + 1}\``;
        return `${medal} <@${r.user_id}> — **${r.currency}** ${CONFIG.CURRENCY.emoji} · 🏆 ${r.chests_won}`;
      })
    : ['_Todavía nadie tiene registros en este servidor._'];

  const container = new ContainerBuilder()
    .setAccentColor(CONFIG.COLOR_LEGENDARY)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent('## 🏅 Ranking de Xerion'))
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n')))
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small))
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('xerion_refresh_leaderboard')
          .setLabel('Actualizar')
          .setEmoji('🔄')
          .setStyle(ButtonStyle.Secondary)
      )
    );

  return container;
}

function buildRatesContainer() {
  const r = CONFIG.ROLES;
  const container = new ContainerBuilder()
    .setAccentColor(CONFIG.COLOR_PRIMARY)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent('## 🎁 Tabla de probabilidades del cofre'))
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small))
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        [
          `${r.AURA_INFINITE.emoji} **AURA INFINITE** — \`${formatPercent(r.AURA_INFINITE.chance)}\``,
          `${r.KING.emoji} **KING** — \`${formatPercent(r.KING.chance)}\``,
          `${r.ARISE.emoji} **ARISE** — \`${formatPercent(r.ARISE.chance)}\``,
          `${CONFIG.CURRENCY.emoji} **+${CONFIG.CURRENCY.dropAmount} ${CONFIG.CURRENCY.name}** — \`${formatPercent(CONFIG.CURRENCY.dropChance)}\``,
          `⬛ **Nada** — el resto de la probabilidad`,
        ].join('\n')
      )
    )
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small))
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent('> _Un cofre puede aparecer solo, o forzarse con `/spawn`. Solo sobrevive uno._')
    );
  return container;
}

function buildHelpContainer() {
  const container = new ContainerBuilder()
    .setAccentColor(CONFIG.COLOR_PRIMARY)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent('## 🔥 Comandos de Xerion'))
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small))
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        [
          `\`/profile\` · \`${CONFIG.PREFIX} profile\` — tu perfil y estadísticas`,
          `\`/inventory\` · \`${CONFIG.PREFIX} inv\` — tu saldo y objetos`,
          `\`/leaderboard\` · \`${CONFIG.PREFIX} top\` — ranking del servidor`,
          `\`/rates\` · \`${CONFIG.PREFIX} rates\` — probabilidades del cofre`,
          `\`/ping\` · \`${CONFIG.PREFIX} ping\` — estado del bot`,
          `\`/help\` · \`${CONFIG.PREFIX} help\` — este menú`,
        ].join('\n')
      )
    )
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small))
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        '_Los cofres aparecen solos por el chat, o un administrador puede forzarlos con_ `/spawn`.'
      )
    );
  return container;
}

function buildPingContainer(latency, wsPing) {
  const uptime = process.uptime();
  const h = Math.floor(uptime / 3600);
  const m = Math.floor((uptime % 3600) / 60);
  const s = Math.floor(uptime % 60);

  const container = new ContainerBuilder()
    .setAccentColor(CONFIG.COLOR_SUCCESS)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent('## 🟢 Xerion está en línea'))
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small))
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        [
          statLine('📶 Latencia del bot', `${latency}ms`),
          statLine('🛰️ Latencia de la API', `${wsPing}ms`),
          statLine('⏳ Tiempo activo', `${h}h ${m}m ${s}s`),
          statLine('🏷️ Versión', `v${VERSION}`),
          statLine('🌐 Servidores', client.guilds.cache.size),
        ].join('\n')
      )
    );
  return container;
}

/* ============================================================================
 *  COMANDOS
 * ==========================================================================*/

const commands = [
  {
    name: 'spawn',
    description: 'Fuerza la aparición de un cofre (solo propietario)',
    ownerOnly: true,
    slash: () => new SlashCommandBuilder().setName('spawn').setDescription('Fuerza la aparición de un cofre'),
    async execute(ctx) {
      const channel = await client.channels.fetch(CONFIG.CHEST_CHANNEL_ID).catch(() => null);
      if (!channel) {
        await ctx.reply({ content: '❌ No pude acceder al canal configurado para los cofres.' });
        return;
      }
      if (activeChannels.has(channel.id)) {
        await ctx.reply({ content: '⚠️ Ya hay un cofre activo en ese canal.' });
        return;
      }
      await ctx.reply({ content: `✅ Cofre invocado en <#${CONFIG.CHEST_CHANNEL_ID}>.` });
      await spawnChest(channel);
    },
  },
  {
    name: 'profile',
    description: 'Muestra tu perfil de Xerion',
    slash: () =>
      new SlashCommandBuilder()
        .setName('profile')
        .setDescription('Muestra tu perfil de Xerion')
        .addUserOption((o) => o.setName('usuario').setDescription('Usuario a consultar').setRequired(false)),
    async execute(ctx) {
      const target = ctx.getUserOption('usuario') || ctx.user;
      const container = await buildProfileContainer(ctx.guild, target);
      await ctx.reply({ components: [container], flags: MessageFlags.IsComponentsV2 });
    },
  },
  {
    name: 'inventory',
    aliases: ['inv'],
    description: 'Muestra tu saldo y objetos',
    slash: () => new SlashCommandBuilder().setName('inventory').setDescription('Muestra tu saldo y objetos'),
    async execute(ctx) {
      const row = await getUser(ctx.guild.id, ctx.user.id);
      const r = CONFIG.ROLES;
      const container = new ContainerBuilder()
        .setAccentColor(CONFIG.COLOR_PRIMARY)
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(`## 🎒 Inventario de ${ctx.user.username}`))
        .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small))
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            [
              `${CONFIG.CURRENCY.emoji} **${row.currency}** ${CONFIG.CURRENCY.name}`,
              `${r.AURA_INFINITE.emoji} AURA INFINITE — ${row.aura_infinite_count}`,
              `${r.KING.emoji} KING — ${row.king_count}`,
              `${r.ARISE.emoji} ARISE — ${row.arise_count}`,
            ].join('\n')
          )
        );
      await ctx.reply({ components: [container], flags: MessageFlags.IsComponentsV2 });
    },
  },
  {
    name: 'leaderboard',
    aliases: ['top'],
    description: 'Muestra el ranking del servidor',
    slash: () => new SlashCommandBuilder().setName('leaderboard').setDescription('Muestra el ranking del servidor'),
    async execute(ctx) {
      const container = await buildLeaderboardContainer(ctx.guild);
      await ctx.reply({ components: [container], flags: MessageFlags.IsComponentsV2 });
    },
  },
  {
    name: 'rates',
    aliases: ['rewards'],
    description: 'Muestra las probabilidades del cofre',
    slash: () => new SlashCommandBuilder().setName('rates').setDescription('Muestra las probabilidades del cofre'),
    async execute(ctx) {
      await ctx.reply({ components: [buildRatesContainer()], flags: MessageFlags.IsComponentsV2 });
    },
  },
  {
    name: 'help',
    description: 'Muestra los comandos disponibles',
    slash: () => new SlashCommandBuilder().setName('help').setDescription('Muestra los comandos disponibles'),
    async execute(ctx) {
      await ctx.reply({ components: [buildHelpContainer()], flags: MessageFlags.IsComponentsV2 });
    },
  },
  {
    name: 'ping',
    description: 'Muestra el estado del bot',
    slash: () => new SlashCommandBuilder().setName('ping').setDescription('Muestra el estado del bot'),
    async execute(ctx) {
      const sentAt = Date.now();
      const container = buildPingContainer(0, Math.round(client.ws.ping));
      const reply = await ctx.reply({ components: [container], flags: MessageFlags.IsComponentsV2 });
      const latency = Date.now() - sentAt;
      const updated = buildPingContainer(latency, Math.round(client.ws.ping));
      await ctx.editReply({ components: [updated], flags: MessageFlags.IsComponentsV2 }, reply);
    },
  },
  {
    name: 'give',
    description: `Otorga ${CONFIG.CURRENCY.name} a un usuario (solo propietario)`,
    ownerOnly: true,
    slash: () =>
      new SlashCommandBuilder()
        .setName('give')
        .setDescription(`Otorga ${CONFIG.CURRENCY.name} a un usuario`)
        .addUserOption((o) => o.setName('usuario').setDescription('Usuario destino').setRequired(true))
        .addIntegerOption((o) => o.setName('cantidad').setDescription('Cantidad a otorgar').setRequired(true).setMinValue(1)),
    async execute(ctx) {
      const target = ctx.getUserOption('usuario');
      const amount = ctx.getIntegerOption('cantidad');
      if (!target || !amount) {
        await ctx.reply({ content: `❌ Uso: \`${CONFIG.PREFIX} give @usuario <cantidad>\`` });
        return;
      }
      await addCurrency(ctx.guild.id, target.id, amount);
      await ctx.reply({ content: `✅ Se otorgaron ${amount} ${CONFIG.CURRENCY.emoji} a <@${target.id}>.` });
    },
  },
];

/* ============================================================================
 *  CONTEXTO UNIFICADO (slash + prefix)
 * ==========================================================================*/

function buildSlashContext(interaction) {
  return {
    isSlash: true,
    guild: interaction.guild,
    channel: interaction.channel,
    member: interaction.member,
    user: interaction.user,
    getUserOption: (name) => interaction.options.getUser(name),
    getIntegerOption: (name) => interaction.options.getInteger(name),
    async reply(payload) {
      const response = await interaction.reply({ ...payload, withResponse: true });
      return response?.resource?.message ?? null;
    },
    async editReply(payload) {
      return interaction.editReply(payload);
    },
  };
}

function buildPrefixContext(message, args) {
  return {
    isSlash: false,
    guild: message.guild,
    channel: message.channel,
    member: message.member,
    user: message.author,
    getUserOption: () => message.mentions.users.first() || null,
    getIntegerOption: () => {
      const raw = args.find((a) => /^\d+$/.test(a));
      return raw ? parseInt(raw, 10) : null;
    },
    async reply(payload) {
      return message.reply({ ...payload, allowedMentions: { repliedUser: false } });
    },
    async editReply(payload, ref) {
      return ref.edit(payload);
    },
  };
}

/* ============================================================================
 *  REGISTRO Y MANEJO DE COMANDOS SLASH
 * ==========================================================================*/

async function registerSlashCommands() {
  const data = commands.map((c) => c.slash().toJSON());
  if (process.env.GUILD_ID) {
    await client.application.commands.set(data, process.env.GUILD_ID);
    console.log(`[COMMANDS] ${data.length} comandos registrados en el servidor ${process.env.GUILD_ID}.`);
  } else {
    await client.application.commands.set(data);
    console.log(`[COMMANDS] ${data.length} comandos registrados globalmente.`);
  }
}

/* ============================================================================
 *  EVENTOS
 * ==========================================================================*/

client.once('ready', async () => {
  console.log(`[XERION] Conectado como ${client.user.tag}`);
  client.user.setPresence({
    status: 'dnd',
    activities: [{ name: `xn help | v${VERSION}`, type: ActivityType.Watching }],
  });
  try {
    await registerSlashCommands();
  } catch (err) {
    console.error('[COMMANDS] Error registrando comandos:', err);
  }
});

client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild) return;

  // Comandos con prefijo
  const lowerContent = message.content.trim().toLowerCase();
  if (lowerContent.startsWith(CONFIG.PREFIX + ' ') || lowerContent === CONFIG.PREFIX) {
    const rest = message.content.trim().slice(CONFIG.PREFIX.length).trim();
    const args = rest.split(/\s+/).filter(Boolean);
    const cmdName = (args.shift() || '').toLowerCase();
    const command = commands.find((c) => c.name === cmdName || (c.aliases || []).includes(cmdName));

    if (command) {
      if (command.ownerOnly && message.author.id !== CONFIG.OWNER_ID) {
        await message.reply('❌ No tienes permiso para usar este comando.');
        return;
      }
      try {
        await command.execute(buildPrefixContext(message, args));
      } catch (err) {
        console.error(`[CMD:${command.name}]`, err);
        await message.reply('⚠️ Ocurrió un error ejecutando el comando.').catch(() => {});
      }
      return;
    }
  }

  // Contador de mensajes -> intento de spawn de cofre
  try {
    await incrementMessages(message.guild.id, message.author.id);
    const counter = await bumpGuildMessageCounter(message.guild.id);
    if (counter % CONFIG.MESSAGES_PER_ROLL === 0) {
      if (Math.random() * 100 < CONFIG.SPAWN_CHANCE) {
        const channel = await client.channels.fetch(CONFIG.CHEST_CHANNEL_ID).catch(() => null);
        if (channel && !activeChannels.has(channel.id)) {
          await spawnChest(channel);
        }
      }
    }
  } catch (err) {
    console.error('[MESSAGE] Error procesando mensaje:', err.message);
  }
});

client.on('interactionCreate', async (interaction) => {
  if (interaction.isChatInputCommand()) {
    const command = commands.find((c) => c.name === interaction.commandName);
    if (!command) return;

    if (command.ownerOnly && interaction.user.id !== CONFIG.OWNER_ID) {
      await interaction.reply({ content: '❌ No tienes permiso para usar este comando.', flags: MessageFlags.Ephemeral });
      return;
    }

    try {
      await command.execute(buildSlashContext(interaction));
    } catch (err) {
      console.error(`[CMD:${command.name}]`, err);
      const payload = { content: '⚠️ Ocurrió un error ejecutando el comando.', flags: MessageFlags.Ephemeral };
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp(payload).catch(() => {});
      } else {
        await interaction.reply(payload).catch(() => {});
      }
    }
    return;
  }

  if (interaction.isButton()) {
    if (interaction.customId === 'xerion_refresh_leaderboard') {
      const container = await buildLeaderboardContainer(interaction.guild);
      await interaction.update({ components: [container], flags: MessageFlags.IsComponentsV2 });
      return;
    }
    if (interaction.customId.startsWith('xerion_refresh_profile_')) {
      const userId = interaction.customId.replace('xerion_refresh_profile_', '');
      const target = await client.users.fetch(userId).catch(() => interaction.user);
      const container = await buildProfileContainer(interaction.guild, target);
      await interaction.update({ components: [container], flags: MessageFlags.IsComponentsV2 });
      return;
    }
    // Los botones "xerion_join_*" y "xerion_open_*" los maneja su propio collector.
  }
});

process.on('unhandledRejection', (err) => console.error('[UNHANDLED]', err));
process.on('uncaughtException', (err) => console.error('[UNCAUGHT]', err));

/* ============================================================================
 *  SERVIDOR WEB — página informativa + endpoint de estado para UptimeRobot
 * ==========================================================================*/

const app = express();

app.get('/', (req, res) => {
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(renderLandingPage());
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    online: client.isReady(),
    guilds: client.guilds ? client.guilds.cache.size : 0,
    uptime: process.uptime(),
    version: VERSION,
  });
});

function renderLandingPage() {
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Xerion — Bot de Discord</title>
<style>
  :root {
    --bg: #0b0b0f;
    --panel: #14141b;
    --accent: #ff4d1f;
    --accent-soft: rgba(255, 77, 31, 0.15);
    --text: #f2f2f5;
    --muted: #9a9aa6;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: radial-gradient(circle at 20% -10%, var(--accent-soft), transparent 40%), var(--bg);
    color: var(--text);
    font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 60px 20px;
  }
  .badge {
    background: var(--accent-soft);
    color: var(--accent);
    padding: 6px 16px;
    border-radius: 999px;
    font-size: 13px;
    font-weight: 600;
    letter-spacing: 0.5px;
    margin-bottom: 24px;
    border: 1px solid rgba(255,77,31,0.35);
  }
  h1 {
    font-size: 56px;
    margin: 0 0 8px;
    background: linear-gradient(135deg, #fff, var(--accent));
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
  }
  .tagline { color: var(--muted); font-size: 18px; margin-bottom: 48px; text-align: center; max-width: 560px; }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
    gap: 20px;
    width: 100%;
    max-width: 900px;
  }
  .card {
    background: var(--panel);
    border: 1px solid rgba(255,255,255,0.06);
    border-radius: 16px;
    padding: 24px;
  }
  .card h3 { margin: 0 0 10px; font-size: 16px; color: var(--accent); }
  .card p { margin: 0; color: var(--muted); font-size: 14px; line-height: 1.5; }
  footer { margin-top: 60px; color: var(--muted); font-size: 13px; text-align: center; }
  .status-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #2ecc71; margin-right: 6px; }
</style>
</head>
<body>
  <span class="badge">🔥 XERION · v${VERSION}</span>
  <h1>Xerion</h1>
  <p class="tagline">Un bot de Discord con cofres, riesgo y una sola regla: no todos sobreviven al desafío.</p>

  <div class="grid">
    <div class="card">
      <h3>🔥 Cofres aleatorios</h3>
      <p>Aparecen sin previo aviso en el chat. Solo hay una ventana corta para participar antes de que el cofre se cierre.</p>
    </div>
    <div class="card">
      <h3>☠️ Eliminación en vivo</h3>
      <p>Cuando hay varios participantes, solo uno sobrevive. El resto queda eliminado, uno por uno, en tiempo real.</p>
    </div>
    <div class="card">
      <h3>🌌 Recompensas raras</h3>
      <p>Roles legendarios con probabilidades extremadamente bajas, y una moneda propia para los más constantes.</p>
    </div>
    <div class="card">
      <h3>📊 Estadísticas</h3>
      <p>Perfil, ranking y probabilidades siempre disponibles con comandos slash o de prefijo.</p>
    </div>
  </div>

  <footer>
    <p><span class="status-dot"></span>Página informativa · Xerion v${VERSION}</p>
  </footer>
</body>
</html>`;
}

/* ============================================================================
 *  ARRANQUE
 * ==========================================================================*/

async function main() {
  await initDatabase();

  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`[WEB] Página informativa activa en el puerto ${port}`));

  await client.login(process.env.DISCORD_TOKEN);
}

main().catch((err) => {
  console.error('[FATAL] No se pudo iniciar Xerion:', err);
  process.exit(1);
});
