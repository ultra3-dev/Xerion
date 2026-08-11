/**
 * ============================================================================
 *  XERION v1.5.0 — visuals.js
 * ----------------------------------------------------------------------------
 *  Toda la capa de diseño vive aquí. Discord no permite mezclar `embeds`
 *  clásicos con Components V2 en el mismo mensaje:
 *
 *  - El flujo del cofre (aparición → eliminación → apertura) usa EMBEDS
 *    CLÁSICOS + botones — se edita muchas veces en poco tiempo y los embeds
 *    son más predecibles para eso, además de que un mention dentro de un
 *    embed NUNCA pinga a nadie (a diferencia de Components V2), lo cual nos
 *    conviene para casi todo ese flujo.
 *  - Los paneles de información (perfil, inventario, leaderboard, rates,
 *    tienda, notificaciones, stats, help) usan COMPONENTS V2 real
 *    (Container, Section, TextDisplay, Separator, ActionRow) con Markdown
 *    completo de Discord: encabezados, subtexto, blockquotes, listas,
 *    timestamps, código.
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
} = require('discord.js');
const { createCanvas } = require('@napi-rs/canvas');

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
  const label =
    reward.kind === 'currency' ? `+${reward.amount ?? rollFeatherAmount(reward)}` : reward.label.toUpperCase();
  wrapCenteredText(ctx, label, x + pad + w / 2, y + h / 2, w - 18, highlighted ? 24 : 19);
  ctx.globalAlpha = 1;
}

/**
 * Dibuja un frame de la tira giratoria, coloreado según el tipo de cofre.
 * Si se pasa forcedResult, la celda central queda fijada a esa recompensa
 * (se usa en el último frame, el que "gana"); si no, también es aleatoria.
 */
function generateSpinFrame(table, tierColor, forcedResult = null) {
  const canvas = createCanvas(SPIN_W, SPIN_H);
  const ctx = canvas.getContext('2d');
  const { r, g, b } = hexToRgb(tierColor);

  const bg = ctx.createLinearGradient(0, 0, 0, SPIN_H);
  bg.addColorStop(0, `rgba(${Math.floor(r * 0.28)}, ${Math.floor(g * 0.22)}, ${Math.floor(b * 0.2)}, 1)`);
  bg.addColorStop(1, '#120b08');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, SPIN_W, SPIN_H);

  // barra de acento superior con el color del tipo de cofre
  ctx.fillStyle = `rgba(${r}, ${g}, ${b}, 0.9)`;
  ctx.fillRect(0, 0, SPIN_W, 4);

  for (let i = 0; i < SPIN_CELLS; i++) {
    const isCenter = i === SPIN_CENTER;
    const reward = isCenter && forcedResult ? forcedResult : pickFillerReward(table);
    drawSpinCell(ctx, i, reward, isCenter);
  }

  // punteros arriba/abajo marcando la celda central
  const cx = SPIN_CENTER * SPIN_CELL_W + SPIN_CELL_W / 2;
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.beginPath();
  ctx.moveTo(cx - 11, 9);
  ctx.lineTo(cx + 11, 9);
  ctx.lineTo(cx, 23);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(cx - 11, SPIN_H - 5);
  ctx.lineTo(cx + 11, SPIN_H - 5);
  ctx.lineTo(cx, SPIN_H - 19);
  ctx.closePath();
  ctx.fill();

  // difuminado lateral estilo tragamonedas
  const fadeW = 110;
  const left = ctx.createLinearGradient(0, 0, fadeW, 0);
  left.addColorStop(0, 'rgba(9,6,4,0.96)');
  left.addColorStop(1, 'rgba(9,6,4,0)');
  ctx.fillStyle = left;
  ctx.fillRect(0, 0, fadeW, SPIN_H);

  const right = ctx.createLinearGradient(SPIN_W - fadeW, 0, SPIN_W, 0);
  right.addColorStop(0, 'rgba(9,6,4,0)');
  right.addColorStop(1, 'rgba(9,6,4,0.96)');
  ctx.fillStyle = right;
  ctx.fillRect(SPIN_W - fadeW, 0, fadeW, SPIN_H);

  return canvas.toBuffer('image/png');
}

function spinFrameAttachment(table, tierColor, forcedResult = null, name = 'spin.png') {
  const buffer = generateSpinFrame(table, tierColor, forcedResult);
  return new AttachmentBuilder(buffer, { name });
}

// ============================================================================
// EMBEDS CLÁSICOS — flujo del cofre (aparición, eliminación, apertura).
// Los mentions dentro de un embed NUNCA pingan — es intencional aquí.
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

/** Embed de aparición del cofre — exactamente 10 estadísticas, como se pidió. */
function buildChestEmbed({ chestType, participantCount, endsAt, serverStats }) {
  const table = chestType.rewardTable;
  const arise = table.find((r) => r.key === 'ARISE');
  const feathers = table.find((r) => r.key === 'FEATHERS');
  const nothing = table.find((r) => r.key === 'NOTHING');

  return new EmbedBuilder()
    .setColor(chestType.color)
    .setTitle(`${chestType.emoji} Ha aparecido un ${chestType.name}`)
    .setDescription(
      [
        `**${chestType.tierLabel}** — ${chestType.flavor}`,
        '',
        'Nadie sabe qué guarda por dentro hasta que alguien lo abre — y solo una persona tendrá esa oportunidad.',
        '',
        'Press **Participate** to enter. Cuando el tiempo se agote, el juego empieza.',
      ].join('\n'),
    )
    .addFields(
      { name: `${chestType.emoji} Tipo de Cofre`, value: `**${chestType.name}**\n\`${chestType.tierLabel}\``, inline: true },
      { name: '🏆 Mejor Recompensa', value: `${arise.emoji} ${arise.label} — \`${arise.chance}%\``, inline: true },
      { name: `${FEATHER_EMOJI} Plumas en juego`, value: `\`${formatFeatherRange(feathers)}\` si no sale un rol`, inline: true },
      { name: '📉 Probabilidad de nada', value: `\`${nothing.chance}%\``, inline: true },
      { name: '⏳ Cierra', value: `<t:${Math.floor(endsAt / 1000)}:R>`, inline: true },
      { name: '👥 Participantes', value: `${participantCount}`, inline: true },
      { name: '🗃️ Cofres abiertos (server)', value: formatNumber(serverStats.chests_opened_total), inline: true },
      {
        name: '🕰️ Última aparición',
        value: serverStats.last_chest_at ? `<t:${toUnixSeconds(serverStats.last_chest_at)}:R>` : 'Es el primero de la historia',
        inline: true,
      },
      { name: '💬 Mensajes procesados', value: formatNumber(serverStats.message_counter), inline: true },
      { name: '🛡️ Consejo', value: 'Un **Escudo** o un **Amuleto** de `/shop` pueden salvarte.', inline: true },
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

function buildEmptyChestEmbed(chestType) {
  return new EmbedBuilder()
    .setColor(CONFIG.COLORS.NOTHING)
    .setTitle('The chest is gone')
    .setDescription(`Nadie se atrevió a entrar a tiempo. El ${chestType.name} desaparece sin dejar rastro.`)
    .setFooter({ text: `Xerion v${CONFIG.VERSION}` });
}

function buildWinnerEmbed(winnerId, { solo = false, chestType }) {
  return new EmbedBuilder()
    .setColor(chestType.color)
    .setTitle('🏆 We Have a Survivor')
    .setDescription(
      solo
        ? `<@${winnerId}> entró en solitario. Nadie más se presentó — el ${chestType.name} es suyo por derecho.`
        : `<@${winnerId}> ha sobrevivido a todos los demás.\n\nEl ${chestType.name} es tuyo — si te atreves a abrirlo.`,
    );
}

const OPENING_STEPS = ['🔒 The chest creaks open...', '✨ Something stirs inside...'];

function buildOpeningStepEmbed(text, color) {
  return new EmbedBuilder().setColor(color).setDescription(`**${text}**`);
}

const RESULT_FLAVOR = {
  ARISE: 'Lo imposible, posible. El cofre casi nunca es tan generoso.',
  KING: 'El cofre te corona. No todos pueden decir lo mismo.',
  AURA_INFINITE: 'Pocos llegan tan lejos. Hoy la suerte estuvo de tu lado.',
  FEATHERS: 'No es el premio mayor, pero suma para la próxima — o para la tienda.',
  NOTHING: 'El cofre estaba vacío para ti esta vez. Así de cruel es Xerion.',
};

function buildResultEmbed(reward, winnerId, roleGranted, chestType, luckBoosted) {
  const resultLine =
    reward.kind === 'role'
      ? `${reward.emoji} **${reward.label}**`
      : reward.kind === 'currency'
        ? `${reward.emoji} **+${reward.amount} Feathers**`
        : `${reward.emoji} **Nothing**`;

  const embed = new EmbedBuilder()
    .setColor(reward.color)
    .setTitle(`The ${chestType.name} has opened`)
    .setDescription(
      [`<@${winnerId}>`, '', `# ${resultLine}`, '', `*${RESULT_FLAVOR[reward.key]}*`].join('\n'),
    )
    .setFooter({ text: `Xerion v${CONFIG.VERSION}` });

  if (luckBoosted) {
    embed.addFields({ name: '🍀 Amuleto de Suerte', value: 'Se consumió un Amuleto — tus probabilidades de rol estuvieron un 50% más altas en esta tirada.' });
  }

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
// COMPONENTS V2 — paneles de información. Todo con Markdown de Discord:
// encabezados (#), subtexto (-#), negrita, blockquotes, código, timestamps.
// Los mentions AQUÍ SÍ pingarían si no se suprimen — game.js siempre envía
// estos paneles con allowedMentions: SAFE_MENTIONS.
// ============================================================================

function buildProfileContainer(stats, discordUser) {
  const winRate =
    stats.chests_participated > 0 ? ((stats.chests_won / stats.chests_participated) * 100).toFixed(1) : '0.0';

  return new ContainerBuilder()
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
          `🌌 **AURA INFINITE:** ${formatNumber(stats.aura_infinite_count)}`,
          `👑 **KING:** ${formatNumber(stats.king_count)}`,
          `💀 **ARISE:** ${formatNumber(stats.arise_count)}`,
        ].join('\n'),
      ),
    )
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        [
          `${SHOP_ITEMS.SHIELD.emoji} **Escudos:** ${formatNumber(stats.shields)}`,
          `${SHOP_ITEMS.CHARM.emoji} **Amuletos:** ${formatNumber(stats.luck_charms)}`,
        ].join('\n'),
      ),
    )
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# Player since <t:${toUnixSeconds(stats.created_at)}:D>`));
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
          `${SHOP_ITEMS.SHIELD.emoji} ${stats.shields} Escudo(s)  ·  ${SHOP_ITEMS.CHARM.emoji} ${stats.luck_charms} Amuleto(s)`,
        ].join('\n'),
      ),
    )
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent('-# Usa `/profile` para el detalle completo o `/shop` para gastar tus Feathers'));
}

function buildLeaderboardContainer(rows) {
  const medals = ['🥇', '🥈', '🥉'];
  const lines = rows.length
    ? rows.map((row, i) => `${medals[i] || `**#${i + 1}**`}  <@${row.user_id}> — ${FEATHER_EMOJI} ${formatNumber(row.feathers)}`)
    : ['Nobody has earned Feathers yet — be the first to survive a chest.'];

  return new ContainerBuilder()
    .setAccentColor(CONFIG.COLORS.FEATHERS)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent('# Leaderboard\n-# Top Feather holders'))
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n')));
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
        `-# La probabilidad de que aparezca un cofre en <#${CONFIG.CHEST_CHANNEL_ID}> empieza en \`${(CONFIG.BASE_SPAWN_CHANCE * 100).toFixed(0)}%\` y sube \`+${(CONFIG.PROBABILITY_STEP_INCREASE * 100).toFixed(0)}%\` cada \`${CONFIG.PROBABILITY_STEP_MESSAGES}\` mensajes sin cofre, hasta un tope de \`${(CONFIG.MAX_SPAWN_CHANCE * 100).toFixed(0)}%\`. Ventana de 5 minutos para participar.`,
      ),
    );

  return container;
}

function buildShopContainer(shopCounts) {
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
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('xerion_buy_shield')
          .setLabel(`Comprar Escudo (${SHOP_ITEMS.SHIELD.cost})`)
          .setEmoji(SHOP_ITEMS.SHIELD.emoji)
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('xerion_buy_charm')
          .setLabel(`Comprar Amuleto (${SHOP_ITEMS.CHARM.cost})`)
          .setEmoji(SHOP_ITEMS.CHARM.emoji)
          .setStyle(ButtonStyle.Secondary),
      ),
    );
}

function buildNotificationContainer(enabled) {
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
          .setCustomId('xerion_notif_toggle')
          .setLabel(enabled ? 'Desactivar' : 'Activar')
          .setEmoji(enabled ? '🔕' : '🔔')
          .setStyle(enabled ? ButtonStyle.Danger : ButtonStyle.Success),
      ),
    );
}

function buildStatsContainer(serverStats) {
  const chance = computeSpawnChance(serverStats.messages_since_chest);
  const untilNext = messagesUntilNextIncrease(serverStats.messages_since_chest);

  return new ContainerBuilder()
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
  return new ContainerBuilder()
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
          '`/shop` [`xn shop`] — gasta tus Feathers en Escudos y Amuletos',
          '`/notification` [`xn notif`] — activa o desactiva los DM de cofre',
          '`/stats` [`xn stats`] — estadísticas del servidor',
          '`/help` [`xn help`] — este menú',
        ].join('\n'),
      ),
    )
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(['**Comando de Administrador**', '`/spawn` [`xn spawn`] — fuerza la aparición de un cofre (opcionalmente elige el tipo)'].join('\n')),
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
}

module.exports = {
  generateSpinFrame,
  spinFrameAttachment,
  buildRewardsFieldValue,
  buildChestEmbed,
  buildParticipateRow,
  buildOpenRow,
  buildEmptyChestEmbed,
  buildWinnerEmbed,
  buildOpeningStepEmbed,
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
};
