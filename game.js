/**
 * ============================================================================
 *  XERION v1.9.0 — game.js
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
const ai = require('./ai.js');
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

// ============================================================================
// CHAT CON IA — solo en memoria, nada de esto se persiste (no hace falta:
// es solo para saber si un reply "continúa" una charla con la IA, y para
// evitar spam/costos con un cooldown corto por usuario).
// ============================================================================

const AI_MESSAGE_ID_CAP = 300;
const aiMessageIds = new Map(); // messageId -> true, FIFO acotado
function trackAiMessageId(id) {
  aiMessageIds.set(id, true);
  if (aiMessageIds.size > AI_MESSAGE_ID_CAP) {
    aiMessageIds.delete(aiMessageIds.keys().next().value);
  }
}

const AI_CHAT_COOLDOWN_MS = 8000;
const aiChatCooldowns = new Map(); // userId -> timestamp del último uso
function isOnAiChatCooldown(userId) {
  const last = aiChatCooldowns.get(userId);
  return Boolean(last) && Date.now() - last < AI_CHAT_COOLDOWN_MS;
}
function markAiChatCooldown(userId) {
  aiChatCooldowns.set(userId, Date.now());
}

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
    openDeadlineAt: state.openDeadlineAt || null,
    excludedWinnerIds: [...(state.excludedWinnerIds || [])],
  };
}

function persistChestState(state) {
  if (state.isForced) return Promise.resolve(); // cofres forzados por el owner: solo en memoria, no se persisten
  return db.saveActiveChest(state.channelId, chestSnapshot(state)).catch((err) => {
    console.error('[Xerion] No se pudo guardar el snapshot del cofre:', err.message);
  });
}

async function clearPersistedChest(state) {
  if (state.isForced) return; // nunca se guardaron, nada que borrar
  await db.clearActiveChest(state.channelId).catch((err) => {
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

/**
 * Spawns forzados por el owner: ignoran a propósito la regla de "ya hay un
 * cofre activo en el canal" — cada uno vive en su propio slot interno, así
 * que no chocan entre sí ni con el cofre normal del canal si hay uno. Para
 * evitar sobrecargar al bot (o a Discord), se limitan a un máximo de
 * OWNER_FORCE_MAX_ACTIVE simultáneos y a un spawn cada OWNER_FORCE_COOLDOWN_MS.
 * Nunca se persisten en base de datos — son cofres de prueba, no parte del
 * progreso real de nadie, así que si el bot se reinicia simplemente se pierden
 * (el cofre normal del canal, si lo hay, no se ve afectado en absoluto).
 */
const ownerForceState = { activeCount: 0, lastSpawnAt: 0 };

function ownerForceStatus() {
  const msLeft = Math.max(0, ownerForceState.lastSpawnAt + CONFIG.OWNER_FORCE_COOLDOWN_MS - Date.now());
  return { activeCount: ownerForceState.activeCount, cooldownMsLeft: msLeft };
}

async function tryForceSpawnChest(channel, forcedTypeKey = null) {
  const { activeCount, cooldownMsLeft } = ownerForceStatus();
  if (activeCount >= CONFIG.OWNER_FORCE_MAX_ACTIVE) {
    return { spawned: false, reason: 'max' };
  }
  if (cooldownMsLeft > 0) {
    return { spawned: false, reason: 'cooldown', cooldownMsLeft };
  }

  const mapKey = `force:${channel.id}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  ownerForceState.lastSpawnAt = Date.now();
  ownerForceState.activeCount += 1;
  activeChests.set(mapKey, { status: 'pending' });

  try {
    await spawnChest(channel, forcedTypeKey, mapKey, true);
    return { spawned: true, mapKey };
  } catch (err) {
    activeChests.delete(mapKey);
    ownerForceState.activeCount = Math.max(0, ownerForceState.activeCount - 1);
    throw err;
  }
}

/** Se llama SIEMPRE que un cofre forzado termina su ciclo (se abre, se pierde, etc.), para liberar su cupo. */
function releaseForceSlot(state) {
  if (state.isForced && !state.forceSlotReleased) {
    state.forceSlotReleased = true;
    ownerForceState.activeCount = Math.max(0, ownerForceState.activeCount - 1);
  }
}

async function spawnChest(channel, forcedTypeKey, mapKey = channel.id, isForced = false) {
  const chestType = pickChestType(forcedTypeKey);
  const previousState = await db.recordChestSpawn(channel.id); // el contador de mensajes es del canal real, no del slot

  const endsAt = Date.now() + CONFIG.JOIN_WINDOW_MS;
  const message = await channel.send({
    components: [visuals.buildChestEmbed({ chestType, participantCount: 0, endsAt, serverStats: previousState, mapKey })],
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: SAFE_MENTIONS,
  });

  const state = activeChests.get(mapKey);
  Object.assign(state, {
    channelId: channel.id,
    mapKey,
    isForced,
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

  console.log(`[Xerion] ${chestType.name} generado en #${channel.id} (mensaje ${message.id}${isForced ? ', forzado por el owner' : ''}).`);

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
  if (state.status !== 'waiting') return;
  db.getState(state.channelId)
    .then((channelStats) =>
      message.edit({
        components: [
          visuals.buildChestEmbed({
            chestType: state.chestType,
            participantCount: state.participants.size,
            endsAt: state.endsAt,
            serverStats: channelStats,
            mapKey: state.mapKey,
          }),
        ],
        flags: MessageFlags.IsComponentsV2,
        allowedMentions: SAFE_MENTIONS,
      }),
    )
    .catch(() => {});
}

async function handleParticipate(interaction) {
  const mapKey = interaction.customId.split('::')[1] || interaction.channelId;
  const state = activeChests.get(mapKey);

  if (!state || state.status !== 'waiting') {
    return interaction.reply({ content: 'This chest is no longer active.', flags: MessageFlags.Ephemeral });
  }
  if (interaction.member?.roles?.cache?.has(CONFIG.ROLE_IDS.BLACKLIST)) {
    return interaction.reply({ content: '🚫 No puedes participar en los cofres.', flags: MessageFlags.Ephemeral });
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
      const currentState = await db.getState(channel.id).catch(() => null);
    if (currentState) {
      const finalPanel = visuals.buildChestEmbed({
        chestType: state.chestType,
        participantCount: state.participants.size,
        endsAt: state.endsAt,
        serverStats: currentState,
        disabled: true,
        mapKey: state.mapKey,
      });
      await message.edit({ components: [finalPanel], flags: MessageFlags.IsComponentsV2, allowedMentions: SAFE_MENTIONS }).catch(() => {});
    }
  }

  const participantIds = [...state.participants];

  if (participantIds.length === 0) {
    await channel
      .send({ components: [visuals.buildEmptyChestEmbed(state.chestType)], flags: MessageFlags.IsComponentsV2, allowedMentions: SAFE_MENTIONS })
      .catch(() => {});
    activeChests.delete(state.mapKey);
    releaseForceSlot(state);
    await clearPersistedChest(state);
    return;
  }

  if (participantIds.length === 1) {
    const winnerId = participantIds[0];
    await db.incrementChestsWon(winnerId).catch((err) => console.error('[Xerion] Error registrando victoria en solitario:', err));
    await announceWinnerAndArmReroll(channel, state, winnerId, { solo: true });
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
    const picked = [];
    const pool = [...candidates];
    for (let i = 0; i < cappedBatch; i++) {
      const idx = randomInt(pool.length);
      const pickedId = pool[idx];
      pool.splice(idx, 1);
      picked.push(pickedId);
    }

    // Pluma Fénix: de los elegidos para caer, cualquiera con una pluma
    // disponible revive automáticamente y sigue en juego — la pluma se
    // consume igual, haya funcionado o no.
    let revivedThisRound = new Set();
    if (picked.length > 0) {
      try {
        const reviveMap = await db.getReviveCounts(picked);
        for (const id of picked) if ((reviveMap.get(id) || 0) > 0) revivedThisRound.add(id);
      } catch (err) {
        console.error('[Xerion] Error consultando plumas fénix:', err);
      }
    }
    const eliminated = picked.filter((id) => !revivedThisRound.has(id));

    remaining = remaining.filter((id) => !eliminated.includes(id));
    state.remainingIds = [...remaining];
    await persistChestState(state);

    if (round === 1 && shieldedThisRound.size > 0) {
      db.consumeShields([...shieldedThisRound]).catch((err) => console.error('[Xerion] Error consumiendo escudos:', err));
    }
    if (revivedThisRound.size > 0) {
      db.consumeRevives([...revivedThisRound]).catch((err) => console.error('[Xerion] Error consumiendo plumas fénix:', err));
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

    if (revivedThisRound.size > 0) {
      const revivedIds = [...revivedThisRound];
      const names = revivedIds.map((id) => `<@${id}>`);
      await channel
        .send({ content: `🪶🔥 ${formatSpanishList(names)} volvió de entre los caídos gracias a su Pluma Fénix.`, allowedMentions: pingOnly(revivedIds) })
        .catch(() => {});
    }

    await sleep(randomBetween(CONFIG.ELIMINATION_DELAY_MIN_MS, CONFIG.ELIMINATION_DELAY_MAX_MS));
  }

  const winnerId = remaining[0];
  await db.incrementChestsWon(winnerId).catch((err) => console.error('[Xerion] Error registrando victoria:', err));
  await announceWinnerAndArmReroll(channel, state, winnerId, { solo: false });
}

/**
 * Publica el anuncio de ganador, guarda el mensaje real (para que /claim
 * pueda editarlo) y arma el temporizador de 5 minutos: si nadie reclama a
 * tiempo, se re-sortea automáticamente entre el resto de participantes.
 */
async function announceWinnerAndArmReroll(channel, state, winnerId, { solo = false } = {}) {
  clearRerollTimer(state);

  state.status = 'awaiting_open';
  state.winnerId = winnerId;
  state.remainingIds = [winnerId];
  state.openDeadlineAt = Date.now() + CONFIG.UNCLAIMED_CHEST_TIMEOUT_MS;

  const winnerMessage = await channel
    .send({
      components: [visuals.buildWinnerEmbed(winnerId, { solo, chestType: state.chestType, openDeadlineAt: state.openDeadlineAt, mapKey: state.mapKey })],
      flags: MessageFlags.IsComponentsV2,
      allowedMentions: pingOnly([winnerId]),
    })
    .catch(() => null);
  if (winnerMessage) state.messageId = winnerMessage.id;

  await persistChestState(state);
  armRerollTimer(channel, state);
}

function armRerollTimer(channel, state) {
  clearRerollTimer(state);
  const msLeft = Math.max(0, Number(state.openDeadlineAt || Date.now()) - Date.now());
  state.rerollTimer = setTimeout(() => {
    rerollWinner(channel, state).catch((err) => console.error('[Xerion] Error re-sorteando ganador:', err));
  }, msLeft);
}

function clearRerollTimer(state) {
  if (state?.rerollTimer) {
    clearTimeout(state.rerollTimer);
    state.rerollTimer = null;
  }
}

/**
 * Se dispara si nadie reclamó el cofre en 5 minutos. Re-sortea entre el
 * resto de participantes originales (nunca entre gente que no jugó) usando
 * una ruleta con avatares y nombres reales. Si ya no queda nadie más, el
 * cofre se pierde y el canal queda libre para que aparezca uno nuevo.
 */
async function rerollWinner(channel, state) {
  const current = activeChests.get(state.mapKey);
  if (!current || current !== state || state.status !== 'awaiting_open') return; // ya se reclamó o ya no existe

  const failedWinnerId = state.winnerId;
  state.excludedWinnerIds = [...(state.excludedWinnerIds || []), failedWinnerId];
  const pool = [...state.participants].filter((id) => !state.excludedWinnerIds.includes(id));

  await channel
    .send({
      content: `⌛ <@${failedWinnerId}> no reclamó su ${state.chestType.name} a tiempo — se re-sortea el ganador.`,
      allowedMentions: SAFE_MENTIONS,
    })
    .catch(() => {});

  if (pool.length === 0) {
    await channel
      .send({
        components: [visuals.buildOpeningStepEmbed('💨 Nadie reclamó el cofre a tiempo. Se pierde.', state.chestType.color)],
        flags: MessageFlags.IsComponentsV2,
        allowedMentions: SAFE_MENTIONS,
      })
      .catch(() => {});
    activeChests.delete(state.mapKey);
    releaseForceSlot(state);
    await clearPersistedChest(state);
    return;
  }

  const newWinnerId = await runPlayerRouletteAnimation(channel, pool, state.chestType);
  await db.incrementChestsWon(newWinnerId).catch((err) => console.error('[Xerion] Error registrando victoria (re-sorteo):', err));
  await announceWinnerAndArmReroll(channel, state, newWinnerId, { solo: pool.length === 1 });
}

/**
 * Ruleta visual que gira entre avatares/nombres reales para elegir al nuevo
 * ganador. Sigue la misma filosofía que el motor de recompensas: si el
 * canvas falla en cualquier punto, se degrada a texto plano sin romper el
 * flujo ni dejar el cofre trabado.
 */
async function runPlayerRouletteAnimation(channel, candidateIds, chestType) {
  const winnerId = candidateIds[randomInt(candidateIds.length)];
  let spinSucceeded = false;
  let seqMessage = null;

  try {
    const users = (
      await Promise.all(candidateIds.map((id) => channel.client.users.fetch(id).catch(() => null)))
    ).filter(Boolean);
    const winnerUser = users.find((u) => u.id === winnerId) || null;

    if (users.length > 0) {
      seqMessage = await channel
        .send({
          components: [visuals.buildOpeningStepEmbed('🎲 Girando la ruleta de sobrevivientes...', chestType.color)],
          flags: MessageFlags.IsComponentsV2,
          allowedMentions: SAFE_MENTIONS,
        })
        .catch(() => null);

      if (seqMessage) {
        const avatarMap = await visuals.preloadPlayerAvatars(users);
        const spinDelays = [90, 100, 115, 130, 150, 175, 205, 240, 280, 330];
        for (let i = 0; i < spinDelays.length; i++) {
          const isLast = i === spinDelays.length - 1;
          const attachment = visuals.playerSpinFrameAttachment(users, avatarMap, chestType.color, isLast ? winnerUser : null);
          await seqMessage.edit({
            components: [visuals.buildPlayerSpinContainer(chestType)],
            flags: MessageFlags.IsComponentsV2,
            files: [attachment],
            attachments: [],
          });
          await sleep(spinDelays[i]);
        }
        spinSucceeded = true;
      }
    }
  } catch (err) {
    console.error('[Xerion] La ruleta de jugadores falló a mitad de la animación, se degrada a texto:', err);
  }

  if (!spinSucceeded) {
    const fallbackPayload = {
      components: [visuals.buildOpeningStepEmbed(`🎉 <@${winnerId}> es el nuevo ganador.`, chestType.color)],
      flags: MessageFlags.IsComponentsV2,
      files: [],
      attachments: [],
    };
    if (seqMessage) await seqMessage.edit(fallbackPayload).catch(() => {});
    else await channel.send({ ...fallbackPayload, allowedMentions: pingOnly([winnerId]) }).catch(() => {});
  }

  return winnerId;
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
    .send({ components: [visuals.buildOpeningStepEmbed(visuals.OPENING_STEPS[0], chestType.color)], flags: MessageFlags.IsComponentsV2, allowedMentions: SAFE_MENTIONS })
    .catch((err) => {
      console.error('[Xerion] No se pudo enviar el mensaje de apertura:', err);
      return null;
    });

  if (seqMessage) {
    await sleep(350);
    await seqMessage.edit({ components: [visuals.buildOpeningStepEmbed(visuals.OPENING_STEPS[1], chestType.color)], flags: MessageFlags.IsComponentsV2 }).catch(() => {});
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
      const iconMap = await visuals.preloadRewardIcons(chestType.rewardTable).catch((err) => {
        console.error('[Xerion] No se pudieron precargar los iconos del canvas, se sigue sin ellos:', err);
        return null;
      });
      // Más frames que antes = giro más fluido, sin alargar la espera total.
      const spinDelays = [70, 80, 90, 105, 120, 140, 165, 195, 230, 275, 330];
      for (let i = 0; i < spinDelays.length; i++) {
        const isLast = i === spinDelays.length - 1;
        const attachment = visuals.spinFrameAttachment(chestType.rewardTable, chestType.color, isLast ? reward : null, 'spin.png', iconMap);
        await seqMessage.edit({
          components: [visuals.buildSpinContainer(chestType)],
          flags: MessageFlags.IsComponentsV2,
          files: [attachment],
          attachments: [],
        });
        await sleep(spinDelays[i]);
      }
      spinSucceeded = true;
    } catch (err) {
      console.error('[Xerion] El motor de canvas falló a mitad de la animación, se degrada a texto:', err);
    }
  }

  if (!spinSucceeded) {
    const fallbackPayload = {
      components: [visuals.buildOpeningStepEmbed('🎰 Resolviendo la tirada...', chestType.color)],
      flags: MessageFlags.IsComponentsV2,
      files: [],
      attachments: [],
    };
    if (seqMessage) await seqMessage.edit(fallbackPayload).catch(() => {});
    else await channel.send({ components: [visuals.buildOpeningStepEmbed('🎰 Resolviendo la tirada...', chestType.color)], flags: MessageFlags.IsComponentsV2, allowedMentions: SAFE_MENTIONS }).catch(() => {});
    await sleep(300);
  }

  try {
    const winnerMember = await channel.guild.members.fetch(winnerId).catch(() => null);
    const heldRoleKeys = getHeldRoleKeys(winnerMember);
    await db.settleChestReward(state?.messageId || `legacy:${winnerId}`, winnerId, reward, channel.id, heldRoleKeys);
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
      components: [visuals.buildResultEmbed(reward, winnerId, roleGranted, chestType, luckBoosted)],
      flags: MessageFlags.IsComponentsV2,
      allowedMentions: pingOnly([winnerId]),
    })
    .catch((err) => console.error('[Xerion] Error enviando el embed de resultado:', err));
}

/** Ejecuta la apertura de un cofre ya ganado — usada por el botón Open. */
async function finalizeChestOpen(channel, state) {
  clearRerollTimer(state);
  state.status = 'opening';
  state.openingClaimed = true;
  await persistChestState(state);
  await openChestSequence(channel, state.winnerId, state.chestType, state);
  activeChests.delete(state.mapKey);
  releaseForceSlot(state);
  await clearPersistedChest(state);
}

async function handleOpenChest(interaction) {
  const [, customWinnerId, mapKey] = interaction.customId.split('::');
  const state = activeChests.get(mapKey || interaction.channelId);

  if (!state || state.status !== 'awaiting_open' || state.winnerId !== customWinnerId) {
    return interaction.reply({ content: 'This chest is no longer available to open.', flags: MessageFlags.Ephemeral });
  }
  if (interaction.user.id !== state.winnerId) {
    return interaction.reply({ content: "This isn't your chest to open.", flags: MessageFlags.Ephemeral });
  }

  await interaction.deferUpdate();
  await interaction.message.edit({
    components: [visuals.buildOpeningStepEmbed('🔒 Abriendo...', state.chestType.color)],
    flags: MessageFlags.IsComponentsV2,
  }).catch(() => {});

  await finalizeChestOpen(interaction.channel, state);
}

// ============================================================================
// TIENDA / NOTIFICACIONES — manejadores de botón
// ============================================================================

async function handleShopBuy(interaction, itemKey) {
  const ownerId = interaction.customId.split('::')[1];
  if (ownerId && interaction.user.id !== ownerId) {
    return interaction.reply({ content: 'Esta es la tienda de otra persona — usá `/shop` para abrir la tuya.', flags: MessageFlags.Ephemeral });
  }

  const item = SHOP_ITEMS[itemKey];
  const buyFn = itemKey === 'SHIELD' ? db.buyShield : itemKey === 'CHARM' ? db.buyCharm : db.buyRevive;

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

  await interaction.update({ components: [visuals.buildShopContainer(result, ownerId)], flags: MessageFlags.IsComponentsV2, allowedMentions: SAFE_MENTIONS });
  await interaction.followUp({ content: `✅ Compraste ${item.emoji} **${item.name}**.`, flags: MessageFlags.Ephemeral }).catch(() => {});
}

async function handleNotifToggle(interaction) {
  const ownerId = interaction.customId.split('::')[1];
  if (ownerId && interaction.user.id !== ownerId) {
    return interaction.reply({ content: 'Este panel de notificaciones es de otra persona — usá `/notification` para el tuyo.', flags: MessageFlags.Ephemeral });
  }
  try {
    const current = await db.getNotificationEnabled(interaction.user.id);
    const next = await db.setNotificationEnabled(interaction.user.id, !current);
    await interaction.update({ components: [visuals.buildNotificationContainer(next, ownerId)], flags: MessageFlags.IsComponentsV2, allowedMentions: SAFE_MENTIONS });
  } catch (err) {
    console.error('[Xerion] Error actualizando la preferencia de notificación:', err);
    await interaction.reply({ content: 'Something went wrong — try again in a moment.', flags: MessageFlags.Ephemeral }).catch(() => {});
  }
}

async function handleStreakToggle(interaction) {
  const ownerId = interaction.customId.split('::')[1];
  if (ownerId && interaction.user.id !== ownerId) {
    return interaction.reply({ content: 'Esta racha es de otra persona — usá `/streak` para la tuya.', flags: MessageFlags.Ephemeral });
  }
  try {
    const stats = await db.getUserStats(interaction.user.id, identityFor(interaction.user));
    const nextVisible = stats.streak_visible === false;
    await db.setStreakVisible(interaction.user.id, nextVisible);

    if (nextVisible) {
      if ((stats.current_streak || 0) > 0) await updateStreakNickname(interaction.member, stats.current_streak).catch(() => {});
    } else {
      await clearStreakNickname(interaction.member).catch(() => {});
    }

    const updated = await db.getUserStats(interaction.user.id, identityFor(interaction.user));
    await interaction.update({ components: [visuals.buildStreakContainer(updated, ownerId)], flags: MessageFlags.IsComponentsV2, allowedMentions: SAFE_MENTIONS });
  } catch (err) {
    console.error('[Xerion] Error actualizando visibilidad de racha:', err);
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
  new SlashCommandBuilder().setName('chest').setDescription('See the live chest status and channel chance.'),
  new SlashCommandBuilder().setName('daily').setDescription('Claim 25 Feathers once every 24 hours.'),
  new SlashCommandBuilder().setName('claim').setDescription('Collect passive Feathers earned by the roles you own.'),
  new SlashCommandBuilder().setName('history').setDescription('View your latest chest rewards.'),
  new SlashCommandBuilder().setName('achievements').setDescription('View your Xerion achievements.'),
  new SlashCommandBuilder().setName('rank').setDescription('View your rank and next milestone.'),
  new SlashCommandBuilder().setName('rewards').setDescription('See a compact reward summary.'),
  new SlashCommandBuilder().setName('streak').setDescription('View your Xerion activity.'),
  new SlashCommandBuilder().setName('ping').setDescription('Check Xerion latency.'),
  new SlashCommandBuilder().setName('about').setDescription('About Xerion and its current version.'),
  new SlashCommandBuilder().setName('rules').setDescription('Read the quick game rules.'),
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
 * Reconstruye todos los cofres activos desde Postgres. Los snapshots son
 * aditivos y solo se borran cuando termina cada partida.
 */
async function restoreActiveChest(client) {
  const rows = await db.getActiveChests().catch((err) => {
    console.error('[Xerion] No se pudo leer el snapshot del cofre:', err.message);
    return [];
  });
  for (const row of rows) {
    const snapshot = row.snapshot;
    if (!snapshot?.channelId || !snapshot?.messageId || !snapshot?.chestTypeKey) continue;

    const chestType = CHEST_TYPES[snapshot.chestTypeKey];
    const channel = await client.channels.fetch(snapshot.channelId).catch(() => null);
    if (!chestType || !channel) continue;

    const state = {
      ...snapshot,
      channelId: snapshot.channelId,
      mapKey: snapshot.channelId,
      isForced: false,
      messageId: snapshot.messageId,
      chestType,
      participants: new Set(snapshot.participants || []),
      remainingIds: [...(snapshot.remainingIds || snapshot.participants || [])],
      updateScheduled: false,
      timeoutHandle: null,
    };
    activeChests.set(state.mapKey, state);

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
      openChestSequence(channel, state.winnerId, chestType, state)
        .then(async () => {
          activeChests.delete(state.mapKey);
          await db.clearActiveChest(state.channelId);
        })
        .catch((err) => console.error('[Xerion] Error reanudando apertura:', err));
    } else if (state.status === 'awaiting_open' && state.winnerId) {
      if (state.openDeadlineAt && Date.now() >= Number(state.openDeadlineAt)) {
        // El plazo ya venció mientras el bot estaba caído — re-sortear ahora mismo.
        rerollWinner(channel, state).catch((err) => console.error('[Xerion] Error re-sorteando tras reinicio:', err));
      } else if (state.openDeadlineAt) {
        armRerollTimer(channel, state);
      }
    }
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
  let result;
  try {
    result = await tryForceSpawnChest(channel, tipo);
  } catch (err) {
    console.error('[Xerion] Error forzando la aparición del cofre:', err);
    return interaction.editReply('Something went wrong spawning the chest — check the logs.');
  }
  if (!result.spawned) {
    if (result.reason === 'max') {
      return interaction.editReply(`Ya hay ${CONFIG.OWNER_FORCE_MAX_ACTIVE} cofres forzados activos (el máximo). Espera a que se resuelva alguno.`);
    }
    const secs = Math.ceil(result.cooldownMsLeft / 1000);
    return interaction.editReply(`Espera ${secs}s más — solo se puede forzar un cofre cada ${CONFIG.OWNER_FORCE_COOLDOWN_MS / 1000}s.`);
  }
  return interaction.editReply(`✅ Chest forzado en <#${CONFIG.CHEST_CHANNEL_ID}> (${ownerForceStatus().activeCount}/${CONFIG.OWNER_FORCE_MAX_ACTIVE} activos).`);
}

async function cmdProfile(interaction) {
  const target = interaction.options.getUser('user') || interaction.user;
  await interaction.deferReply();
  try {
    const stats = await db.getUserStats(target.id, { username: target.username, displayName: target.displayName });
    const targetMember = target.id === interaction.user.id ? interaction.member : await interaction.guild.members.fetch(target.id).catch(() => null);
    await interaction.editReply({ components: [visuals.buildProfileContainer(stats, target, getHeldRoleKeys(targetMember))], flags: MessageFlags.IsComponentsV2, allowedMentions: SAFE_MENTIONS });
  } catch (err) {
    console.error('[Xerion] Error en /profile:', err);
    await interaction.editReply('Could not load that profile right now — try again in a moment.');
  }
}

async function cmdInventory(interaction) {
  await interaction.deferReply();
  try {
    const stats = await db.getUserStats(interaction.user.id, { username: interaction.user.username, displayName: interaction.user.displayName });
    await interaction.editReply({ components: [visuals.buildQuickInventoryContainer(stats, interaction.user)], flags: MessageFlags.IsComponentsV2, allowedMentions: SAFE_MENTIONS });
  } catch (err) {
    console.error('[Xerion] Error en /inventory:', err);
    await interaction.editReply('Could not load your inventory right now — try again in a moment.');
  }
}

async function cmdLeaderboard(interaction) {
  await interaction.deferReply();
  try {
    const rows = await hydrateLeaderboardRows(interaction.guild, await db.getLeaderboard(100));
    const totalPages = Math.max(1, Math.ceil(rows.length / 10));
    await interaction.editReply({
      components: [visuals.buildLeaderboardContainer(rows.slice(0, 10), 0, totalPages, interaction.user.id)],
      flags: MessageFlags.IsComponentsV2,
      allowedMentions: SAFE_MENTIONS,
    });
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
    await interaction.editReply({ components: [visuals.buildShopContainer(counts, interaction.user.id)], flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral, allowedMentions: SAFE_MENTIONS });
  } catch (err) {
    console.error('[Xerion] Error en /shop:', err);
    await interaction.editReply('Could not load the shop right now — try again in a moment.');
  }
}

async function cmdNotification(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const enabled = await db.getNotificationEnabled(interaction.user.id);
    await interaction.editReply({ components: [visuals.buildNotificationContainer(enabled, interaction.user.id)], flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral, allowedMentions: SAFE_MENTIONS });
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

function identityFor(user) {
  return { username: user.username, displayName: user.displayName || user.globalName || user.username };
}

/**
 * Lista de roles de cofre (ARISE/KING/GOAT/AURA_INFINITE/STAR_X) que el
 * usuario tiene AHORA MISMO en Discord. Esta es la ÚNICA fuente de verdad
 * para beneficios de rol, ingreso pasivo y logros de rol — nunca los
 * contadores de la base de datos, que son solo historial. Si no hay
 * `member` (ej. no se pudo resolver), devuelve vacío por seguridad — mejor
 * negar un beneficio por error que otorgarlo sin verificar.
 */
function getHeldRoleKeys(member) {
  if (!member?.roles?.cache) return [];
  const keys = [];
  if (member.roles.cache.has(CONFIG.ROLE_IDS.ARISE)) keys.push('ARISE');
  if (member.roles.cache.has(CONFIG.ROLE_IDS.KING)) keys.push('KING');
  if (member.roles.cache.has(CONFIG.ROLE_IDS.GOAT)) keys.push('GOAT');
  if (member.roles.cache.has(CONFIG.ROLE_IDS.AURA_INFINITE)) keys.push('AURA_INFINITE');
  if (member.roles.cache.has(CONFIG.ROLE_IDS.STAR_X)) keys.push('STAR_X');
  return keys;
}

const STREAK_SUFFIX_RE = /\s*\(🔥\d+\)\s*$/;

/** Actualiza el apodo del usuario para mostrar su racha, ej. "nombre (🔥3)". Falla en silencio (permisos/jerarquía). */
async function updateStreakNickname(member, streak) {
  if (!member) return;
  try {
    const base = (member.displayName || '').replace(STREAK_SUFFIX_RE, '');
    const nextNick = `${base} (🔥${streak})`.slice(0, 32);
    if (member.displayName !== nextNick) await member.setNickname(nextNick);
  } catch (err) {
    console.error('[Xerion] No se pudo actualizar el apodo con la racha:', err.message);
  }
}

/** Quita el sufijo de racha del apodo del usuario, si lo tiene. Falla en silencio. */
async function clearStreakNickname(member) {
  if (!member) return;
  try {
    const base = (member.displayName || '').replace(STREAK_SUFFIX_RE, '');
    if (base !== member.displayName) await member.setNickname(base);
  } catch (err) {
    console.error('[Xerion] No se pudo limpiar el apodo de la racha:', err.message);
  }
}

/**
 * Resuelve nombres para el top y, de paso, lo mantiene sin bugs: verifica en
 * un solo llamado a la API quiénes siguen en el servidor. A quien ya no está
 * se le excluye del top y se le reinician sus datos, para que si vuelve a
 * entrar arranque limpio y no queden filas fantasma.
 */
async function hydrateLeaderboardRows(guild, rows) {
  if (!guild || rows.length === 0) return rows;

  let memberMap = new Map();
  try {
    const fetched = await guild.members.fetch({ user: rows.map((row) => row.user_id) });
    memberMap = new Map(fetched.map((member) => [member.id, member]));
  } catch (err) {
    console.error('[Xerion] No se pudo verificar quién sigue en el servidor para el top:', err.message);
    // Si la API falla, mejor mostrar el top tal cual que arriesgarnos a vaciarlo por error.
    return rows.map((row) => ({ ...row, resolved_name: row.display_name || 'Usuario no disponible' }));
  }

  const result = [];
  for (const row of rows) {
    const member = memberMap.get(row.user_id);
    if (!member) {
      db.resetUserData(row.user_id).catch((err) =>
        console.error('[Xerion] Error reiniciando datos de alguien que ya no está en el servidor:', err.message),
      );
      continue;
    }
    result.push({
      ...row,
      resolved_name: member.displayName || member.user?.globalName || member.user?.username,
    });
  }
  return result;
}

async function sendV2(interaction, container, ephemeral = false) {
  const flags = MessageFlags.IsComponentsV2 | (ephemeral ? MessageFlags.Ephemeral : 0);
  const payload = { components: [container], flags, allowedMentions: SAFE_MENTIONS };
  if (interaction.deferred || interaction.replied) return interaction.editReply(payload);
  return interaction.reply(payload);
}

async function cmdChest(interaction) {
  const channelId = CONFIG.CHEST_CHANNEL_ID;
  const state = await db.getServerStats(channelId);
  return sendV2(interaction, visuals.buildChestStatusContainer(channelId, state, activeChests.get(channelId)));
}

async function cmdDaily(interaction) {
  const result = await db.claimDaily(interaction.user.id, identityFor(interaction.user), getHeldRoleKeys(interaction.member));
  if (result.claimed && result.streak_visible !== false) {
    updateStreakNickname(interaction.member, result.current_streak).catch(() => {});
  }
  return sendV2(interaction, visuals.buildDailyContainer(result), true);
}

async function cmdClaim(interaction) {
  const result = await db.collectRoleIncome(interaction.user.id, getHeldRoleKeys(interaction.member));
  return sendV2(interaction, visuals.buildRoleIncomeContainer(result), false);
}

async function cmdHistory(interaction) {
  const rows = await db.getRecentAwards(interaction.user.id, 10);
  return sendV2(interaction, visuals.buildHistoryContainer(rows));
}

async function cmdAchievements(interaction) {
  const stats = await db.getUserStats(interaction.user.id, identityFor(interaction.user));
  return sendV2(interaction, visuals.buildAchievementsContainer(stats, getHeldRoleKeys(interaction.member)));
}

async function cmdRank(interaction) {
  const stats = await db.getUserStats(interaction.user.id, identityFor(interaction.user));
  return sendV2(interaction, visuals.buildRankContainer(stats));
}

async function cmdRewards(interaction) {
  return sendV2(interaction, visuals.buildRewardsContainer());
}

async function cmdStreak(interaction) {
  const stats = await db.getUserStats(interaction.user.id, identityFor(interaction.user));
  return sendV2(interaction, visuals.buildStreakContainer(stats, interaction.user.id));
}

async function cmdPing(interaction) {
  return sendV2(interaction, visuals.buildPingContainer(Math.max(0, Math.round(interaction.client.ws.ping))));
}

async function cmdAbout(interaction) {
  return sendV2(interaction, visuals.buildAboutContainer());
}

async function cmdRules(interaction) {
  return sendV2(interaction, visuals.buildRulesContainer());
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
    case 'chest': return cmdChest(interaction);
    case 'daily': return cmdDaily(interaction);
    case 'claim': return cmdClaim(interaction);
    case 'history': return cmdHistory(interaction);
    case 'achievements': return cmdAchievements(interaction);
    case 'rank': return cmdRank(interaction);
    case 'rewards': return cmdRewards(interaction);
    case 'streak': return cmdStreak(interaction);
    case 'ping': return cmdPing(interaction);
    case 'about': return cmdAbout(interaction);
    case 'rules': return cmdRules(interaction);
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
  let result;
  try {
    result = await tryForceSpawnChest(channel, tipo || null);
  } catch (err) {
    console.error('[Xerion] Error forzando la aparición del cofre (prefix):', err);
    return noPingReply(message, { content: 'Something went wrong spawning the chest — check the logs.' });
  }
  if (!result.spawned) {
    if (result.reason === 'max') {
      return noPingReply(message, { content: `Ya hay ${CONFIG.OWNER_FORCE_MAX_ACTIVE} cofres forzados activos (el máximo). Espera a que se resuelva alguno.` });
    }
    const secs = Math.ceil(result.cooldownMsLeft / 1000);
    return noPingReply(message, { content: `Espera ${secs}s más — solo se puede forzar un cofre cada ${CONFIG.OWNER_FORCE_COOLDOWN_MS / 1000}s.` });
  }
  return noPingReply(message, { content: `✅ Chest forzado en <#${CONFIG.CHEST_CHANNEL_ID}> (${ownerForceStatus().activeCount}/${CONFIG.OWNER_FORCE_MAX_ACTIVE} activos).` });
}

async function prefixProfile(message) {
  const target = message.mentions.users.first() || message.author;
  const stats = await db.getUserStats(target.id);
  const targetMember = target.id === message.author.id ? message.member : await message.guild.members.fetch(target.id).catch(() => null);
  return noPingReply(message, { components: [visuals.buildProfileContainer(stats, target, getHeldRoleKeys(targetMember))], flags: MessageFlags.IsComponentsV2 });
}

async function prefixInventory(message) {
  const stats = await db.getUserStats(message.author.id);
  return noPingReply(message, { components: [visuals.buildQuickInventoryContainer(stats, message.author)], flags: MessageFlags.IsComponentsV2 });
}

async function prefixLeaderboard(message) {
  const rows = await hydrateLeaderboardRows(message.guild, await db.getLeaderboard(100));
  const totalPages = Math.max(1, Math.ceil(rows.length / 10));
  return noPingReply(message, {
    components: [visuals.buildLeaderboardContainer(rows.slice(0, 10), 0, totalPages, message.author.id)],
    flags: MessageFlags.IsComponentsV2,
  });
}

async function prefixRates(message) {
  return noPingReply(message, { components: [visuals.buildRatesContainer()], flags: MessageFlags.IsComponentsV2 });
}

async function prefixShop(message) {
  const counts = await db.getShopCounts(message.author.id);
  return noPingReply(message, { components: [visuals.buildShopContainer(counts, message.author.id)], flags: MessageFlags.IsComponentsV2 });
}

async function prefixNotification(message) {
  const enabled = await db.getNotificationEnabled(message.author.id);
  const payload = { components: [visuals.buildNotificationContainer(enabled, message.author.id)], flags: MessageFlags.IsComponentsV2, allowedMentions: SAFE_MENTIONS };
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

async function prefixChest(message) {
  const state = await db.getServerStats(CONFIG.CHEST_CHANNEL_ID);
  return noPingReply(message, {
    components: [visuals.buildChestStatusContainer(CONFIG.CHEST_CHANNEL_ID, state, activeChests.get(CONFIG.CHEST_CHANNEL_ID))],
    flags: MessageFlags.IsComponentsV2,
  });
}

async function prefixDaily(message) {
  const result = await db.claimDaily(message.author.id, identityFor(message.author), getHeldRoleKeys(message.member));
  if (result.claimed && result.streak_visible !== false) {
    updateStreakNickname(message.member, result.current_streak).catch(() => {});
  }
  return noPingReply(message, { components: [visuals.buildDailyContainer(result)], flags: MessageFlags.IsComponentsV2 });
}

async function prefixClaim(message) {
  const result = await db.collectRoleIncome(message.author.id, getHeldRoleKeys(message.member));
  return noPingReply(message, { components: [visuals.buildRoleIncomeContainer(result)], flags: MessageFlags.IsComponentsV2 });
}

async function prefixHistory(message) {
  const rows = await db.getRecentAwards(message.author.id, 10);
  return noPingReply(message, { components: [visuals.buildHistoryContainer(rows)], flags: MessageFlags.IsComponentsV2 });
}

async function prefixAchievements(message) {
  const stats = await db.getUserStats(message.author.id, identityFor(message.author));
  return noPingReply(message, { components: [visuals.buildAchievementsContainer(stats, getHeldRoleKeys(message.member))], flags: MessageFlags.IsComponentsV2 });
}

async function prefixRank(message) {
  const stats = await db.getUserStats(message.author.id, identityFor(message.author));
  return noPingReply(message, { components: [visuals.buildRankContainer(stats)], flags: MessageFlags.IsComponentsV2 });
}

async function prefixRewards(message) {
  return noPingReply(message, { components: [visuals.buildRewardsContainer()], flags: MessageFlags.IsComponentsV2 });
}

async function prefixStreak(message) {
  const stats = await db.getUserStats(message.author.id, identityFor(message.author));
  return noPingReply(message, { components: [visuals.buildStreakContainer(stats, message.author.id)], flags: MessageFlags.IsComponentsV2 });
}

async function prefixPing(message) {
  return noPingReply(message, { components: [visuals.buildPingContainer(Math.max(0, Math.round(message.client.ws.ping)))], flags: MessageFlags.IsComponentsV2 });
}

async function prefixAbout(message) {
  return noPingReply(message, { components: [visuals.buildAboutContainer()], flags: MessageFlags.IsComponentsV2 });
}

async function prefixRules(message) {
  return noPingReply(message, { components: [visuals.buildRulesContainer()], flags: MessageFlags.IsComponentsV2 });
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
      case 'chest': case 'cofre': return await prefixChest(message);
      case 'daily': return await prefixDaily(message);
      case 'claim': return await prefixClaim(message);
      case 'history': case 'historial': return await prefixHistory(message);
      case 'achievements': case 'logros': return await prefixAchievements(message);
      case 'rank': case 'rango': return await prefixRank(message);
      case 'rewards': case 'recompensas': return await prefixRewards(message);
      case 'streak': case 'racha': return await prefixStreak(message);
      case 'ping': return await prefixPing(message);
      case 'about': case 'info': return await prefixAbout(message);
      case 'rules': case 'reglas': return await prefixRules(message);
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

  if (message.channelId === CONFIG.CHEST_CHANNEL_ID) {
    try {
      await db.ensureUser(message.author.id, identityFor(message.author));
      await db.incrementMessageCounter(message.channelId);
      const sinceChest = await db.incrementMessagesSinceChest(message.channelId);
      const chance = computeSpawnChance(sinceChest);
      if (Math.random() < chance) {
        await trySpawnChest(message.channel);
      }
    } catch (err) {
      console.error('[Xerion] Error en el contador de mensajes / intento de aparición:', err);
    }
  }

  const lowerContent = message.content.toLowerCase();
  if (lowerContent === CONFIG.PREFIX || lowerContent.startsWith(`${CONFIG.PREFIX} `)) {
    return handlePrefixCommand(message);
  }

  if (shouldTriggerAiChat(message)) {
    return handleAiChat(message).catch((err) => console.error('[Xerion] Error en el chat de IA:', err));
  }
}

/**
 * La IA de chat SOLO se activa en dos casos: (1) mencionan/pingean al bot
 * directamente, o (2) responden a un mensaje que la propia IA generó antes
 * (para poder seguir la charla sin tener que mencionarlo cada vez). Responder
 * a mensajes normales del bot (cofres, ganadores, etc.) nunca la activa.
 */
function shouldTriggerAiChat(message) {
  if (message.mentions.has(message.client.user.id)) return true;
  const refId = message.reference?.messageId;
  return Boolean(refId && aiMessageIds.has(refId));
}

async function handleAiChat(message) {
  if (!ai.isAiAvailable()) return; // sin GROQ_API_KEY configurada — silencio total, no rompe nada

  if (isOnAiChatCooldown(message.author.id)) return;
  markAiChatCooldown(message.author.id);

  const cleanedContent = message.content.replace(/<@!?\d+>/g, '').trim();
  if (!cleanedContent) return; // solo era un ping vacío, sin nada que responder

  await message.channel.sendTyping().catch(() => {});

  const reply = await ai.generateChatReply({
    userMessage: cleanedContent,
    authorName: message.member?.displayName || message.author.username,
  });
  if (!reply) return; // la IA falló o tardó demasiado — mejor silencio que un mensaje roto

  const sent = await noPingReply(message, { content: reply }).catch((err) => {
    console.error('[Xerion] Error enviando la respuesta de la IA:', err);
    return null;
  });
  if (sent) trackAiMessageId(sent.id);
}

async function handleInteraction(interaction) {
  try {
    if (interaction.isChatInputCommand()) {
      return await handleSlashCommand(interaction);
    }
    if (interaction.isButton()) {
      const id = interaction.customId;
      if (id.startsWith('xerion_participate')) return await handleParticipate(interaction);
      if (id.startsWith('xerion_open::')) return await handleOpenChest(interaction);
      if (id.startsWith('xerion_buy_shield::')) return await handleShopBuy(interaction, 'SHIELD');
      if (id.startsWith('xerion_buy_charm::')) return await handleShopBuy(interaction, 'CHARM');
      if (id.startsWith('xerion_buy_revive::')) return await handleShopBuy(interaction, 'REVIVE');
      if (id.startsWith('xerion_notif_toggle::')) return await handleNotifToggle(interaction);
      if (id.startsWith('xerion_streak_toggle::')) return await handleStreakToggle(interaction);
      if (id.startsWith('xerion_leaderboard_prev::') || id.startsWith('xerion_leaderboard_next::')) {
        const [, pageStr, ownerId] = id.split('::');
        if (ownerId && interaction.user.id !== ownerId) {
          return interaction.reply({ content: 'Solo quien pidió el leaderboard puede pasar de página — usá `/leaderboard` para el tuyo.', flags: MessageFlags.Ephemeral });
        }
        const currentPage = Number(pageStr) || 0;
        const nextPage = id.startsWith('xerion_leaderboard_prev::') ? currentPage - 1 : currentPage + 1;
        const rows = await hydrateLeaderboardRows(interaction.guild, await db.getLeaderboard(100));
        const totalPages = Math.max(1, Math.ceil(rows.length / 10));
        const safePage = Math.max(0, Math.min(nextPage, totalPages - 1));
        return interaction.update({
          components: [visuals.buildLeaderboardContainer(rows.slice(safePage * 10, safePage * 10 + 10), safePage, totalPages, ownerId)],
          flags: MessageFlags.IsComponentsV2,
          allowedMentions: SAFE_MENTIONS,
        });
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
}

module.exports = {
  handleMessage,
  handleInteraction,
  clearAndRegisterSlashCommands,
  restoreActiveChest,
};
