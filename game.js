/**
 * ============================================================================
 *  XERION v1.5.0 — game.js
 * ----------------------------------------------------------------------------
 *  El motor del juego: aparición de cofres (con probabilidad dinámica y 3
 *  tipos), la batalla de eliminación (con el Escudo de la tienda), la
 *  apertura (con el Amuleto de Suerte), las notificaciones por DM, y TODOS
 *  los comandos — cada uno funciona en slash Y en prefix (`xn ...`).
 *
 *  Regla de oro: nada de lo de aquí debe poder tumbar el proceso. Todo lo
 *  que toca Discord o la base de datos va envuelto en try/catch; un error en
 *  un cofre no debe afectar a los demás ni reiniciar el bot.
 * ============================================================================
 */

'use strict';

const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  REST,
  Routes,
  MessageFlags,
} = require('discord.js');

const {
  CONFIG,
  SHOP_ITEMS,
  CHEST_TYPES,
  pickChestType,
  rollReward,
  applyLuckBoost,
  rollFeatherAmount,
  computeSpawnChance,
  sleep,
  randomInt,
  shuffle,
  randomBetween,
  formatSpanishList,
  isOnCooldown,
  SAFE_MENTIONS,
  pingOnly,
} = require('./config.js');

const db = require('./database.js');
const visuals = require('./visuals.js');

// ============================================================================
// ESTADO DE PARTIDA (en memoria) — un cofre activo como máximo por canal.
// Los datos permanentes (stats, probabilidad, notificaciones) viven en
// Postgres; esto es solo el estado efímero de la partida en curso. Si el
// proceso se reinicia a mitad de una partida, esa partida en concreto se
// pierde (es inevitable con estado en memoria) — pero nada de lo permanente
// se ve afectado, y el bot vuelve a operar normalmente en el siguiente
// mensaje/comando sin necesitar ningún reset manual.
// ============================================================================

/** @type {Map<string, object>} channelId -> ChestState */
const activeChests = new Map();

function chestSnapshot(state) {
  return {
    channelId: state.channelId,
    messageId: state.messageId,
    chestTypeKey: state.chestType.key,
    participants: [...(state.participants || [])],
    remainingIds: [...(state.remainingIds || [])],
    status: state.status,
    endsAt: state.endsAt,
    winnerId: state.winnerId || null,
    openingClaimed: Boolean(state.openingClaimed),
    rewardKey: state.reward?.key || null,
    rewardAmount: state.reward?.amount ?? null,
    luckBoosted: Boolean(state.luckBoosted),
    round: Number(state.round || 0),
  };
}

function persistChestState(state) {
  return db.saveActiveChest(chestSnapshot(state)).catch((err) => {
    console.error('[Xerion] No se pudo guardar el snapshot del cofre:', err.message);
  });
}

async function clearPersistedChest() {
  await db.clearActiveChest().catch((err) => {
    console.error('[Xerion] No se pudo limpiar el snapshot final del cofre:', err.message);
  });
}

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

/** Construye la línea de eliminación con mentions reales (esto es lo que hace que pingue). */
function formatEliminationLine(eliminatedIds) {
  const pool = eliminatedIds.length === 1 ? ELIMINATION_PHRASES_SINGLE : ELIMINATION_PHRASES_BATCH;
  const phrase = pickPhrase(pool);
  const mentionsText = eliminatedIds.map((id) => `<@${id}>`).join(', ');
  return phrase.replace('{name}', `**${mentionsText}**`);
}

function decideBatchSize(remainingCount) {
  if (remainingCount <= CONFIG.BATCH_THRESHOLD) return 1;
  return Math.max(2, Math.floor(remainingCount * CONFIG.BATCH_FRACTION));
}

// ============================================================================
// APARICIÓN DEL COFRE
// ============================================================================

/**
 * Punto de entrada único para generar un cofre, ya sea automático o forzado
 * con /spawn. Reserva el slot de forma SÍNCRONA antes de cualquier await,
 * para cerrar la ventana de carrera entre una aparición automática y un
 * /spawn casi simultáneos.
 */
async function trySpawnChest(channel, forcedTypeKey = null) {
  if (activeChests.has(channel.id)) return false;
  activeChests.set(channel.id, { status: 'pending' });
  try {
    await spawnChest(channel, forcedTypeKey);
    return true;
  } catch (err) {
    activeChests.delete(channel.id);
    throw err;
  }
}

async function spawnChest(channel, forcedTypeKey) {
  const chestType = pickChestType(forcedTypeKey);
  const previousState = await db.recordChestSpawn(); // resetea el contador y guarda el estado ANTERIOR

  const endsAt = Date.now() + CONFIG.JOIN_WINDOW_MS;
  const message = await channel.send({
    embeds: [visuals.buildChestEmbed({ chestType, participantCount: 0, endsAt, serverStats: previousState })],
    components: [visuals.buildParticipateRow()],
    allowedMentions: SAFE_MENTIONS,
  });

  const state = activeChests.get(channel.id);
  Object.assign(state, {
    channelId: channel.id,
    messageId: message.id,
    chestType,
    participants: new Set(),
    status: 'waiting',
    endsAt,
    winnerId: null,
    updateScheduled: false,
  });
  await persistChestState(state);

  state.timeoutHandle = setTimeout(() => {
    resolveJoinPhase(channel, state).catch((err) => console.error('[Xerion] Error resolviendo la fase de unión del cofre:', err));
  }, CONFIG.JOIN_WINDOW_MS);

  console.log(`[Xerion] ${chestType.name} generado en #${channel.id} (mensaje ${message.id}).`);

  notifyChestSpawn(channel.client, chestType, message).catch((err) =>
    console.error('[Xerion] Error enviando notificaciones de cofre:', err),
  );
}

/** Avisa por DM a todos los usuarios que activaron /notification. Nunca deja que un DM fallido rompa nada. */
async function notifyChestSpawn(client, chestType, chestMessage) {
  let userIds;
  try {
    userIds = await db.getEnabledNotificationUserIds();
  } catch (err) {
    console.error('[Xerion] Error leyendo la lista de notificaciones:', err);
    return;
  }
  if (userIds.length === 0) return;

  const container = visuals.buildChestAlertContainer(chestType, chestMessage.url);
  const payload = { components: [container], flags: MessageFlags.IsComponentsV2, allowedMentions: SAFE_MENTIONS };

  const results = await Promise.allSettled(
    userIds.map(async (userId) => {
      const user = await client.users.fetch(userId);
      await user.send(payload);
    }),
  );
  const failed = results.filter((r) => r.status === 'rejected').length;
  if (failed > 0) {
    console.log(`[Xerion] ${failed}/${userIds.length} notificaciones de cofre no se pudieron entregar (DMs cerrados, probablemente).`);
  }
}

function scheduleParticipantCountUpdate(state, message) {
  if (state.updateScheduled) return;
  state.updateScheduled = true;
  setTimeout(async () => {
    state.updateScheduled = false;
    if (state.status !== 'waiting') return;
    const previousState = await db.getState().catch(() => null);
    if (!previousState) return;
    const embed = visuals.buildChestEmbed({
      chestType: state.chestType,
      participantCount: state.participants.size,
      endsAt: state.endsAt,
      serverStats: previousState,
    });
    await message.edit({ embeds: [embed], allowedMentions: SAFE_MENTIONS }).catch(() => {});
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
  await persistChestState(state);
  await interaction.reply({ content: '✅ You are in. Wait for the timer to run out.', flags: MessageFlags.Ephemeral });

  db.incrementChestsParticipated(interaction.user.id).catch((err) =>
    console.error('[Xerion] Error registrando participación:', err),
  );
  scheduleParticipantCountUpdate(state, interaction.message);
}

async function resolveJoinPhase(channel, state) {
  state.status = 'battling';
  state.remainingIds = [...state.participants];
  await persistChestState(state);

  const message = await channel.messages.fetch(state.messageId).catch(() => null);
  if (message) {
    const currentState = await db.getState().catch(() => null);
    if (currentState) {
      const finalEmbed = visuals.buildChestEmbed({
        chestType: state.chestType,
        participantCount: state.participants.size,
        endsAt: state.endsAt,
        serverStats: currentState,
      });
      await message.edit({ embeds: [finalEmbed], components: [visuals.buildParticipateRow(true)], allowedMentions: SAFE_MENTIONS }).catch(() => {});
    }
  }

  const participantIds = [...state.participants];

  if (participantIds.length === 0) {
    await channel.send({ embeds: [visuals.buildEmptyChestEmbed(state.chestType)], allowedMentions: SAFE_MENTIONS }).catch(() => {});
    activeChests.delete(channel.id);
    await clearPersistedChest();
    return;
  }

  if (participantIds.length === 1) {
    const winnerId = participantIds[0];
    await db.incrementChestsWon(winnerId).catch((err) => console.error('[Xerion] Error registrando victoria en solitario:', err));
    state.status = 'awaiting_open';
    state.winnerId = winnerId;
    state.remainingIds = [winnerId];
    await persistChestState(state);
    await channel
      .send({
        content: `<@${winnerId}>`,
        embeds: [visuals.buildWinnerEmbed(winnerId, { solo: true, chestType: state.chestType })],
        components: [visuals.buildOpenRow(winnerId)],
        allowedMentions: pingOnly([winnerId]),
      })
      .catch(() => {});
    return;
  }

  await runBattleRoyale(channel, state, participantIds);
}

async function runBattleRoyale(channel, state, participantIds, resumed = false) {
  if (!resumed) {
    await channel.send({ content: '**El juego ha comenzado. Buena suerte — la van a necesitar...**', allowedMentions: SAFE_MENTIONS }).catch(() => {});
    await sleep(CONFIG.INTRO_DELAY_MS);
  }

  let remaining = resumed && state.remainingIds?.length ? [...state.remainingIds] : shuffle(participantIds);
  state.remainingIds = [...remaining];
  await persistChestState(state);
  let round = Number(state.round || 0);

  while (remaining.length > 1) {
    round++;
    state.round = round;
    const batchSize = decideBatchSize(remaining.length);

    // Ronda 1: quien tenga un Escudo de Xerion es inmune esa ronda — y el
    // escudo se consume, tenga o no tenga que salvarlo de verdad.
    let shieldedThisRound = new Set();
    if (round === 1) {
      try {
        const shieldMap = await db.getShieldCounts(remaining);
        for (const id of remaining) if ((shieldMap.get(id) || 0) > 0) shieldedThisRound.add(id);
      } catch (err) {
        console.error('[Xerion] Error consultando escudos:', err);
      }
    }

    let candidates = remaining.filter((id) => !shieldedThisRound.has(id));
    if (candidates.length === 0) candidates = [...remaining]; // si todos tienen escudo, el juego no puede estancarse

    const cappedBatch = Math.min(batchSize, remaining.length - 1, candidates.length);
    const eliminated = [];
    const pool = [...candidates];
    for (let i = 0; i < cappedBatch; i++) {
      const idx = randomInt(pool.length);
      const pickedId = pool[idx];
      pool.splice(idx, 1);
      eliminated.push(pickedId);
    }
    remaining = remaining.filter((id) => !eliminated.includes(id));
    state.remainingIds = [...remaining];
    await persistChestState(state);

    if (round === 1 && shieldedThisRound.size > 0) {
      db.consumeShields([...shieldedThisRound]).catch((err) => console.error('[Xerion] Error consumiendo escudos:', err));
    }

    if (eliminated.length > 0) {
      const line = formatEliminationLine(eliminated);
      await channel.send({ content: line, allowedMentions: pingOnly(eliminated) }).catch((err) =>
        console.error('[Xerion] Error enviando eliminación:', err),
      );
    } else if (round === 1 && shieldedThisRound.size > 0) {
      await channel
        .send({ content: `🛡️ **Todos los Escudos de Xerion protegieron a sus dueños en esta ronda — nadie cae... por ahora.**`, allowedMentions: SAFE_MENTIONS })
        .catch(() => {});
    }

    await sleep(randomBetween(CONFIG.ELIMINATION_DELAY_MIN_MS, CONFIG.ELIMINATION_DELAY_MAX_MS));
  }

  const winnerId = remaining[0];
  await db.incrementChestsWon(winnerId).catch((err) => console.error('[Xerion] Error registrando victoria:', err));
  state.status = 'awaiting_open';
  state.winnerId = winnerId;
  state.remainingIds = [winnerId];
  await persistChestState(state);
  await channel
    .send({
      content: `<@${winnerId}>`,
      embeds: [visuals.buildWinnerEmbed(winnerId, { chestType: state.chestType })],
      components: [visuals.buildOpenRow(winnerId)],
      allowedMentions: pingOnly([winnerId]),
    })
    .catch(() => {});
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

async function openChestSequence(channel, winnerId, chestType, state = null) {
  const seqMessage = await channel
    .send({ embeds: [visuals.buildOpeningStepEmbed(visuals.OPENING_STEPS[0], chestType.color)], allowedMentions: SAFE_MENTIONS })
    .catch((err) => {
      console.error('[Xerion] No se pudo enviar el mensaje de apertura:', err);
      return null;
    });

  if (seqMessage) {
    await sleep(350);
    await seqMessage.edit({ embeds: [visuals.buildOpeningStepEmbed(visuals.OPENING_STEPS[1], chestType.color)] }).catch(() => {});
    await sleep(350);
  }

  // Amuleto de Suerte: si el ganador tiene uno, se consume y mejora la tabla para ESTA tirada.
  let luckBoosted = Boolean(state?.luckBoosted);
  let reward = state?.rewardKey ? chestType.rewardTable.find((item) => item.key === state.rewardKey) : null;
  if (reward) {
    reward = { ...reward };
    if (reward.kind === 'currency') reward.amount = state.rewardAmount;
  } else {
    let table = chestType.rewardTable;
    try {
      luckBoosted = await db.consumeLuckCharmIfAvailable(winnerId);
      if (luckBoosted) table = applyLuckBoost(table);
    } catch (err) {
      console.error('[Xerion] Error consultando/consumiendo el amuleto de suerte:', err);
    }

    reward = rollReward(table);
    if (reward.kind === 'currency') reward = { ...reward, amount: rollFeatherAmount(reward) };
    if (state) {
      state.reward = reward;
      state.luckBoosted = luckBoosted;
      await persistChestState(state);
    }
  }

  let spinSucceeded = false;
  if (seqMessage) {
    try {
      const spinDelays = [120, 140, 170, 210, 260, 320, 420];
      for (let i = 0; i < spinDelays.length; i++) {
        const isLast = i === spinDelays.length - 1;
        const attachment = visuals.spinFrameAttachment(chestType.rewardTable, chestType.color, isLast ? reward : null);
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
    else await channel.send({ content: '🎰 Rolling...', allowedMentions: SAFE_MENTIONS }).catch(() => {});
    await sleep(300);
  }

  try {
    await db.settleChestReward(state?.messageId || `legacy:${winnerId}`, winnerId, reward);
  } catch (err) {
    // Mantener el snapshot en `opening` permite reintentar en la próxima
    // conexión sin perder la recompensa ni sumarla dos veces.
    console.error('[Xerion] Error guardando la recompensa en la base de datos:', err);
    throw err;
  }

  let roleGranted = false;
  if (reward.kind === 'role') {
    roleGranted = await grantRewardRole(channel.guild, winnerId, reward.roleId);
  }

  await channel
    .send({
      content: `<@${winnerId}>`,
      embeds: [visuals.buildResultEmbed(reward, winnerId, roleGranted, chestType, luckBoosted)],
      allowedMentions: pingOnly([winnerId]),
    })
    .catch((err) => console.error('[Xerion] Error enviando el embed de resultado:', err));
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

  state.status = 'opening';
  state.openingClaimed = true;
  await persistChestState(state);
  await interaction.deferUpdate();
  await interaction.message.edit({ components: [visuals.buildOpenRow(state.winnerId, true)] }).catch(() => {});

  const chestType = state.chestType;
  await openChestSequence(interaction.channel, state.winnerId, chestType, state);
  activeChests.delete(interaction.channelId);
  await clearPersistedChest();
}

// ============================================================================
// TIENDA / NOTIFICACIONES — manejadores de botón
// ============================================================================

async function handleShopBuy(interaction, itemKey) {
  const item = SHOP_ITEMS[itemKey];
  const buyFn = itemKey === 'SHIELD' ? db.buyShield : db.buyCharm;

  let result;
  try {
    result = await buyFn(interaction.user.id);
  } catch (err) {
    console.error('[Xerion] Error procesando compra en la tienda:', err);
    return interaction.reply({ content: 'Something went wrong with that purchase — try again in a moment.', flags: MessageFlags.Ephemeral });
  }

  if (!result) {
    return interaction.reply({
      content: `No te alcanzan las Feathers para comprar ${item.emoji} **${item.name}** (cuesta \`${item.cost}\`).`,
      flags: MessageFlags.Ephemeral,
    });
  }

  await interaction.update({ components: [visuals.buildShopContainer(result)], flags: MessageFlags.IsComponentsV2, allowedMentions: SAFE_MENTIONS });
  await interaction.followUp({ content: `✅ Compraste ${item.emoji} **${item.name}**.`, flags: MessageFlags.Ephemeral }).catch(() => {});
}

async function handleNotifToggle(interaction) {
  try {
    const current = await db.getNotificationEnabled(interaction.user.id);
    const next = await db.setNotificationEnabled(interaction.user.id, !current);
    await interaction.update({ components: [visuals.buildNotificationContainer(next)], flags: MessageFlags.IsComponentsV2, allowedMentions: SAFE_MENTIONS });
  } catch (err) {
    console.error('[Xerion] Error actualizando la preferencia de notificación:', err);
    await interaction.reply({ content: 'Something went wrong — try again in a moment.', flags: MessageFlags.Ephemeral }).catch(() => {});
  }
}

// ============================================================================
// SLASH COMMANDS — definición y registro (con limpieza de comandos viejos)
// ============================================================================

const CHEST_TYPE_CHOICES = Object.values(CHEST_TYPES).map((t) => ({ name: t.name, value: t.key }));

const slashCommandDefinitions = [
  new SlashCommandBuilder()
    .setName('spawn')
    .setDescription('Force a chest to appear (owner only).')
    .addStringOption((opt) => opt.setName('tipo').setDescription('Tipo de cofre a forzar (opcional)').setRequired(false).addChoices(...CHEST_TYPE_CHOICES))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('profile')
    .setDescription('View your Xerion stats.')
    .addUserOption((opt) => opt.setName('user').setDescription('Whose profile to view').setRequired(false)),

  new SlashCommandBuilder().setName('inventory').setDescription('Quick balance and item check.'),
  new SlashCommandBuilder().setName('leaderboard').setDescription('Top Feather holders on the server.'),
  new SlashCommandBuilder().setName('rates').setDescription('See the chest reward odds for all 3 chest tiers.'),
  new SlashCommandBuilder().setName('shop').setDescription('Spend your Feathers on Shields and Luck Charms.'),
  new SlashCommandBuilder().setName('notification').setDescription('Toggle DM alerts for when a chest appears.'),
  new SlashCommandBuilder().setName('stats').setDescription('Server-wide Xerion stats.'),
  new SlashCommandBuilder().setName('help').setDescription('List all Xerion commands.'),
].map((cmd) => cmd.toJSON());

/**
 * Limpia TODOS los slash commands (global y del guild configurado) antes de
 * re-registrar los actuales — así no quedan comandos clonados de un
 * proyecto o versión anterior colgando en ningún scope.
 */
async function clearAndRegisterSlashCommands(client = null) {
  const rest = new REST().setToken(CONFIG.TOKEN);
  try {
    await rest.put(Routes.applicationCommands(CONFIG.CLIENT_ID), { body: [] });
    const guildIds = new Set(client?.guilds?.cache?.keys() || []);
    if (CONFIG.GUILD_ID) guildIds.add(CONFIG.GUILD_ID);
    for (const guildId of guildIds) {
      await rest.put(Routes.applicationGuildCommands(CONFIG.CLIENT_ID, guildId), { body: [] });
    }

    const route = CONFIG.GUILD_ID
      ? Routes.applicationGuildCommands(CONFIG.CLIENT_ID, CONFIG.GUILD_ID)
      : Routes.applicationCommands(CONFIG.CLIENT_ID);
    await rest.put(route, { body: slashCommandDefinitions });

    console.log(
      `[Xerion] Slash commands limpiados y re-registrados ${
        CONFIG.GUILD_ID ? `en el servidor ${CONFIG.GUILD_ID} (al instante)` : 'globalmente (puede tardar hasta 1h en propagarse)'
      }.`,
    );
  } catch (err) {
    console.error('[Xerion] Error limpiando/registrando slash commands:', err);
  }
}

/**
 * Reconstruye el único cofre activo desde Postgres. El snapshot es aditivo y
 * se borra solo cuando la partida termina, nunca al arrancar.
 */
async function restoreActiveChest(client) {
  const snapshot = await db.getActiveChest().catch((err) => {
    console.error('[Xerion] No se pudo leer el snapshot del cofre:', err.message);
    return null;
  });
  if (!snapshot?.channelId || !snapshot?.messageId || !snapshot?.chestTypeKey) return;

  const chestType = CHEST_TYPES[snapshot.chestTypeKey];
  const channel = await client.channels.fetch(snapshot.channelId).catch(() => null);
  if (!chestType || !channel) return;

  const state = {
    ...snapshot,
    channelId: snapshot.channelId,
    messageId: snapshot.messageId,
    chestType,
    participants: new Set(snapshot.participants || []),
    remainingIds: [...(snapshot.remainingIds || snapshot.participants || [])],
    updateScheduled: false,
    timeoutHandle: null,
  };
  activeChests.set(state.channelId, state);

  if (state.status === 'waiting') {
    const remainingMs = Math.max(0, Number(state.endsAt || Date.now()) - Date.now());
    state.timeoutHandle = setTimeout(
      () => resolveJoinPhase(channel, state).catch((err) => console.error('[Xerion] Error recuperando cofre:', err)),
      remainingMs,
    );
  } else if (state.status === 'battling' && state.remainingIds.length > 1) {
    runBattleRoyale(channel, state, state.remainingIds, true).catch((err) =>
      console.error('[Xerion] Error reanudando batalla:', err),
    );
  } else if (state.status === 'opening' && state.winnerId) {
    // La liquidación usa la clave del mensaje como idempotency key: si ya se
    // guardó antes de la caída, no vuelve a sumar plumas ni estadísticas.
    openChestSequence(channel, state.winnerId, chestType, state)
      .then(async () => {
        activeChests.delete(state.channelId);
        await clearPersistedChest();
      })
      .catch((err) => console.error('[Xerion] Error reanudando apertura:', err));
  }
}

// ---- handlers ----

async function cmdSpawn(interaction) {
  if (interaction.user.id !== CONFIG.OWNER_ID) {
    return interaction.reply({ content: 'This command is owner-only.', flags: MessageFlags.Ephemeral });
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const channel = await interaction.client.channels.fetch(CONFIG.CHEST_CHANNEL_ID).catch(() => null);
  if (!channel) return interaction.editReply('No pude encontrar el canal configurado para los cofres.');

  const tipo = interaction.options.getString('tipo');
  let spawned;
  try {
    spawned = await trySpawnChest(channel, tipo);
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
    const stats = await db.getUserStats(target.id);
    await interaction.editReply({ components: [visuals.buildProfileContainer(stats, target)], flags: MessageFlags.IsComponentsV2, allowedMentions: SAFE_MENTIONS });
  } catch (err) {
    console.error('[Xerion] Error en /profile:', err);
    await interaction.editReply('Could not load that profile right now — try again in a moment.');
  }
}

async function cmdInventory(interaction) {
  await interaction.deferReply();
  try {
    const stats = await db.getUserStats(interaction.user.id);
    await interaction.editReply({ components: [visuals.buildQuickInventoryContainer(stats, interaction.user)], flags: MessageFlags.IsComponentsV2, allowedMentions: SAFE_MENTIONS });
  } catch (err) {
    console.error('[Xerion] Error en /inventory:', err);
    await interaction.editReply('Could not load your inventory right now — try again in a moment.');
  }
}

async function cmdLeaderboard(interaction) {
  await interaction.deferReply();
  try {
    const rows = await db.getLeaderboard(10);
    await interaction.editReply({ components: [visuals.buildLeaderboardContainer(rows)], flags: MessageFlags.IsComponentsV2, allowedMentions: SAFE_MENTIONS });
  } catch (err) {
    console.error('[Xerion] Error en /leaderboard:', err);
    await interaction.editReply('Could not load the leaderboard right now — try again in a moment.');
  }
}

async function cmdRates(interaction) {
  await interaction.reply({ components: [visuals.buildRatesContainer()], flags: MessageFlags.IsComponentsV2, allowedMentions: SAFE_MENTIONS });
}

async function cmdShop(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const counts = await db.getShopCounts(interaction.user.id);
    await interaction.editReply({ components: [visuals.buildShopContainer(counts)], flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral, allowedMentions: SAFE_MENTIONS });
  } catch (err) {
    console.error('[Xerion] Error en /shop:', err);
    await interaction.editReply('Could not load the shop right now — try again in a moment.');
  }
}

async function cmdNotification(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const enabled = await db.getNotificationEnabled(interaction.user.id);
    await interaction.editReply({ components: [visuals.buildNotificationContainer(enabled)], flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral, allowedMentions: SAFE_MENTIONS });
  } catch (err) {
    console.error('[Xerion] Error en /notification:', err);
    await interaction.editReply('Could not load your notification settings right now — try again in a moment.');
  }
}

async function cmdStats(interaction) {
  await interaction.deferReply();
  try {
    const serverStats = await db.getServerStats();
    await interaction.editReply({ components: [visuals.buildStatsContainer(serverStats)], flags: MessageFlags.IsComponentsV2, allowedMentions: SAFE_MENTIONS });
  } catch (err) {
    console.error('[Xerion] Error en /stats:', err);
    await interaction.editReply('Could not load server stats right now — try again in a moment.');
  }
}

async function cmdHelp(interaction) {
  await interaction.reply({ components: [visuals.buildHelpContainer()], flags: MessageFlags.IsComponentsV2, allowedMentions: SAFE_MENTIONS });
}

async function handleSlashCommand(interaction) {
  switch (interaction.commandName) {
    case 'spawn': return cmdSpawn(interaction);
    case 'profile': return cmdProfile(interaction);
    case 'inventory': return cmdInventory(interaction);
    case 'leaderboard': return cmdLeaderboard(interaction);
    case 'rates': return cmdRates(interaction);
    case 'shop': return cmdShop(interaction);
    case 'notification': return cmdNotification(interaction);
    case 'stats': return cmdStats(interaction);
    case 'help': return cmdHelp(interaction);
    default: return interaction.reply({ content: 'Unknown command.', flags: MessageFlags.Ephemeral });
  }
}

// ============================================================================
// COMANDOS CON PREFIJO ("xn ...") — mismas acciones, sin ping al responder.
// ============================================================================

function noPingReply(message, payload) {
  return message.reply({ ...payload, allowedMentions: { ...(payload.allowedMentions || SAFE_MENTIONS), repliedUser: false } });
}

async function prefixSpawn(message, args) {
  if (message.author.id !== CONFIG.OWNER_ID) {
    return noPingReply(message, { content: 'This command is owner-only.' });
  }
  const channel = await message.client.channels.fetch(CONFIG.CHEST_CHANNEL_ID).catch(() => null);
  if (!channel) return noPingReply(message, { content: 'No pude encontrar el canal configurado para los cofres.' });

  const tipo = (args[0] || '').toUpperCase();
  let spawned;
  try {
    spawned = await trySpawnChest(channel, tipo || null);
  } catch (err) {
    console.error('[Xerion] Error forzando la aparición del cofre (prefix):', err);
    return noPingReply(message, { content: 'Something went wrong spawning the chest — check the logs.' });
  }
  if (!spawned) return noPingReply(message, { content: 'There is already an active chest in that channel.' });
  return noPingReply(message, { content: `✅ Chest spawned in <#${CONFIG.CHEST_CHANNEL_ID}>.` });
}

async function prefixProfile(message) {
  const target = message.mentions.users.first() || message.author;
  const stats = await db.getUserStats(target.id);
  return noPingReply(message, { components: [visuals.buildProfileContainer(stats, target)], flags: MessageFlags.IsComponentsV2 });
}

async function prefixInventory(message) {
  const stats = await db.getUserStats(message.author.id);
  return noPingReply(message, { components: [visuals.buildQuickInventoryContainer(stats, message.author)], flags: MessageFlags.IsComponentsV2 });
}

async function prefixLeaderboard(message) {
  const rows = await db.getLeaderboard(10);
  return noPingReply(message, { components: [visuals.buildLeaderboardContainer(rows)], flags: MessageFlags.IsComponentsV2 });
}

async function prefixRates(message) {
  return noPingReply(message, { components: [visuals.buildRatesContainer()], flags: MessageFlags.IsComponentsV2 });
}

async function prefixShop(message) {
  const counts = await db.getShopCounts(message.author.id);
  return noPingReply(message, { components: [visuals.buildShopContainer(counts)], flags: MessageFlags.IsComponentsV2 });
}

async function prefixNotification(message) {
  const enabled = await db.getNotificationEnabled(message.author.id);
  const payload = { components: [visuals.buildNotificationContainer(enabled)], flags: MessageFlags.IsComponentsV2, allowedMentions: SAFE_MENTIONS };
  try {
    await message.author.send(payload);
    return noPingReply(message, { content: '📬 Te envié tu panel de notificaciones por DM.' });
  } catch {
    // DMs cerrados — se manda igual en el canal para no dejar al usuario sin opción.
    return noPingReply(message, payload);
  }
}

async function prefixStats(message) {
  const serverStats = await db.getServerStats();
  return noPingReply(message, { components: [visuals.buildStatsContainer(serverStats)], flags: MessageFlags.IsComponentsV2 });
}

async function prefixHelp(message) {
  return noPingReply(message, { components: [visuals.buildHelpContainer()], flags: MessageFlags.IsComponentsV2 });
}

async function handlePrefixCommand(message) {
  const withoutPrefix = message.content.slice(CONFIG.PREFIX.length).trim();
  const parts = withoutPrefix.split(/\s+/).filter(Boolean);
  const subcommand = (parts[0] || '').toLowerCase();
  const args = parts.slice(1);

  if (isOnCooldown(`prefix:${message.author.id}`, 2000)) return;

  try {
    switch (subcommand) {
      case 'spawn': return await prefixSpawn(message, args);
      case 'profile': case 'perfil': return await prefixProfile(message);
      case 'inv': case 'inventory': return await prefixInventory(message);
      case 'top': case 'leaderboard': return await prefixLeaderboard(message);
      case 'rates': case 'odds': return await prefixRates(message);
      case 'shop': case 'tienda': return await prefixShop(message);
      case 'notification': case 'notif': return await prefixNotification(message);
      case 'stats': return await prefixStats(message);
      case 'help': case '': return await prefixHelp(message);
      default:
        return await noPingReply(message, { content: `Unknown command. Try \`${CONFIG.PREFIX} help\` to see everything I can do.` });
    }
  } catch (err) {
    console.error('[Xerion] Error manejando comando con prefijo:', err);
    await noPingReply(message, { content: 'Something went wrong — try again in a moment.' }).catch(() => {});
  }
}

// ============================================================================
// PUNTOS DE ENTRADA PARA index.js
// ============================================================================

async function handleMessage(message) {
  if (message.author.bot || !message.guild) return;

  const lowerContent = message.content.toLowerCase();
  if (lowerContent === CONFIG.PREFIX || lowerContent.startsWith(`${CONFIG.PREFIX} `)) {
    return handlePrefixCommand(message);
  }

  if (message.channelId === CONFIG.CHEST_CHANNEL_ID) {
    try {
      await db.incrementMessageCounter(); // estadística histórica, no afecta la probabilidad
      const sinceChest = await db.incrementMessagesSinceChest();
      const chance = computeSpawnChance(sinceChest);
      if (Math.random() < chance) {
        await trySpawnChest(message.channel);
      }
    } catch (err) {
      console.error('[Xerion] Error en el contador de mensajes / intento de aparición:', err);
    }
  }
}

async function handleInteraction(interaction) {
  try {
    if (interaction.isChatInputCommand()) {
      return await handleSlashCommand(interaction);
    }
    if (interaction.isButton()) {
      const id = interaction.customId;
      if (id === 'xerion_participate') return await handleParticipate(interaction);
      if (id.startsWith('xerion_open_')) return await handleOpenChest(interaction);
      if (id === 'xerion_buy_shield') return await handleShopBuy(interaction, 'SHIELD');
      if (id === 'xerion_buy_charm') return await handleShopBuy(interaction, 'CHARM');
      if (id === 'xerion_notif_toggle') return await handleNotifToggle(interaction);
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
}

module.exports = {
  handleMessage,
  handleInteraction,
  clearAndRegisterSlashCommands,
  restoreActiveChest,
};
