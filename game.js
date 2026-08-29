/**
 * ============================================================================
 *  XERION v2.0.4 ULTRA — game.js
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
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');

const {
  CONFIG,
  FEATHER_EMOJI,
  SHOP_ITEMS,
  CHEST_TYPES,
  CHEST_TYPE_LIST,
  ROLE_PASSIVE_INCOME,
  pickChestType,
  rollReward,
  applyLuckBoost,
  applyVoidWard,
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
  PORTAL_TYPES,
  PORTAL_TYPE_LIST,
  pickPortalType,
  computePortalPayouts,
  PORTAL_CHECK_INTERVAL_MS,
  PORTAL_SPAWN_CHANCE,
  PORTAL_JOIN_WINDOW_MS,
  EVENT_TYPES,
  EVENT_TYPE_LIST,
  pickEventType,
  applyPartialVoidReduction,
} = require('./config.js');

const db = require('./database.js');
const ai = require('./ai.js');
const visuals = require('./visuals.js');
const adminPanel = require('./admin-panel.js');

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

// Portales: un solo portal activo por canal a la vez (a diferencia de los
// cofres forzados, acá no hace falta soportar varios en paralelo). Se
// persisten SIEMPRE (incluso los forzados por el owner) porque, a
// diferencia de un cofre, la gente ya puso plumas reales en juego — perder
// ese estado en un reinicio dejaría esas plumas descontadas sin portal al
// que volver.
const activePortals = new Map();

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
    wardUsed: Boolean(state.wardUsed),
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
  const activeEvent = getCurrentEvent();
  const eventType = activeEvent ? EVENT_TYPES[activeEvent.key] : null;
  const weightMultipliers = eventType?.kind === 'chest_weight_shift' ? eventType.value : null;
  const stepMessages = getEffectiveStepMessages();

  const chestType = pickChestType(forcedTypeKey, weightMultipliers);
  const previousState = await db.recordChestSpawn(channel.id); // el contador de mensajes es del canal real, no del slot

  const endsAt = Date.now() + CONFIG.JOIN_WINDOW_MS;
  const message = await channel.send({
    components: [visuals.buildChestEmbed({ chestType, participantCount: 0, endsAt, serverStats: previousState, mapKey, activeEvent, stepMessages })],
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
    .then((channelStats) => {
      const activeEvent = getCurrentEvent();
      const stepMessages = getEffectiveStepMessages();
      return message.edit({
        components: [
          visuals.buildChestEmbed({
            chestType: state.chestType,
            participantCount: state.participants.size,
            endsAt: state.endsAt,
            serverStats: channelStats,
            mapKey: state.mapKey,
            activeEvent,
            stepMessages,
          }),
        ],
        flags: MessageFlags.IsComponentsV2,
        allowedMentions: SAFE_MENTIONS,
      });
    })
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
  let wardUsed = Boolean(state?.wardUsed);
  let reward = state?.rewardKey ? chestType.rewardTable.find((item) => item.key === state.rewardKey) : null;
  if (reward) {
    reward = { ...reward };
    if (reward.kind === 'currency') reward.amount = state.rewardAmount;
  } else {
    let table = chestType.rewardTable;
    const activeEvent = getCurrentEvent();
    const eventType = activeEvent ? EVENT_TYPES[activeEvent.key] : null;
    // Los modificadores del evento (si hay uno activo) se aplican a TODOS —
    // antes de mirar si además tiene un Amuleto propio, para que ambos se
    // sumen en vez de pisarse.
    if (eventType?.kind === 'luck_multiplier') table = applyLuckBoost(table, eventType.value);
    if (eventType?.kind === 'nothing_multiplier') table = applyPartialVoidReduction(table, eventType.value);
    try {
      luckBoosted = await db.consumeLuckCharmIfAvailable(winnerId);
      if (luckBoosted) table = applyLuckBoost(table);
    } catch (err) {
      console.error('[Xerion] Error consultando/consumiendo el amuleto de suerte:', err);
    }
    try {
      wardUsed = await db.consumeVoidWardIfAvailable(winnerId);
      if (wardUsed) table = applyVoidWard(table);
    } catch (err) {
      console.error('[Xerion] Error consultando/consumiendo el amuleto contra el vacío:', err);
    }

    reward = rollReward(table);
    if (reward.kind === 'currency') {
      let amount = rollFeatherAmount(reward);
      if (eventType?.kind === 'feather_multiplier') amount = Math.round(amount * eventType.value);
      reward = { ...reward, amount };
    }
    if (state) {
      state.reward = reward;
      state.luckBoosted = luckBoosted;
      state.wardUsed = wardUsed;
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
      components: [visuals.buildResultEmbed(reward, winnerId, roleGranted, chestType, luckBoosted, wardUsed)],
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
// EVENTOS GLOBALES — un evento a la vez, para todo el servidor. Se activa
// desde /panel-owner con una ruleta ponderada (mismo mecanismo que un rol
// de cofre — ver pickEventType en config.js). Se cachea en memoria para no
// pegarle a la base de datos en cada roll, pero SIEMPRE se persiste primero
// en xerion_state, así que un reinicio a mitad de un evento lo recupera
// exacto (o lo limpia en silencio si venció mientras el bot estaba caído) —
// ver restoreEvent(), llamado una vez al boot desde index.js.
// ============================================================================

let cachedEvent = null; // { key, endsAt } | null
let eventExpiryTimer = null;

/** Evento activo ahora mismo, o null. Nunca lanza. */
function getCurrentEvent() {
  if (!cachedEvent) return null;
  if (new Date(cachedEvent.endsAt).getTime() <= Date.now()) return null; // vencido pero el timer todavía no corrió — se trata como inactivo igual
  return cachedEvent;
}

function clearEventTimer() {
  if (eventExpiryTimer) {
    clearTimeout(eventExpiryTimer);
    eventExpiryTimer = null;
  }
}

/** Avisa en el canal de cofres que el evento terminó. Nunca rompe nada si el canal ya no es accesible. */
async function announceEventEnd(client, eventKey) {
  const type = EVENT_TYPES[eventKey];
  if (!type) return;
  try {
    const channel = await client.channels.fetch(CONFIG.CHEST_CHANNEL_ID);
    await channel.send({ components: [visuals.buildEventEndedContainer(type)], flags: MessageFlags.IsComponentsV2, allowedMentions: SAFE_MENTIONS });
  } catch (err) {
    console.error('[Xerion] No se pudo anunciar el fin del evento (no afecta nada más):', err.message);
  }
}

async function deactivateEvent(client, { announce = true } = {}) {
  const wasActive = cachedEvent;
  clearEventTimer();
  cachedEvent = null;
  await db.clearActiveEvent().catch((err) => console.error('[Xerion] Error limpiando el evento activo:', err.message));
  if (wasActive && announce && client) {
    announceEventEnd(client, wasActive.key).catch(() => {});
  }
}

function scheduleEventExpiry(client, endsAt) {
  clearEventTimer();
  const msLeft = Math.max(0, new Date(endsAt).getTime() - Date.now());
  eventExpiryTimer = setTimeout(() => {
    deactivateEvent(client, { announce: true }).catch((err) => console.error('[Xerion] Error desactivando el evento vencido:', err));
  }, msLeft);
}

/**
 * Activa un evento (ponderado al azar, o forzado si se pasa forcedKey) y lo
 * anuncia con la ruleta Canvas en el canal de cofres. Si sale "Portal
 * Dorado", además intenta abrir de inmediato un Portal Rango-S (si no hay
 * uno activo ya) — para ese evento en particular, el impacto es instantáneo
 * en vez de depender de que el chequeo horario coincida con la ventana.
 */
async function activateEvent(channel, forcedKey = null) {
  const type = pickEventType(forcedKey);
  const endsAt = new Date(Date.now() + type.durationMs);

  await db.setActiveEvent(type.key, endsAt);
  cachedEvent = { key: type.key, endsAt };
  scheduleEventExpiry(channel.client, endsAt);

  try {
    const iconMap = await visuals.preloadEventIcons().catch(() => null);
    const wheelMessage = await channel.send({
      components: [visuals.buildEventWheelContainer()],
      flags: MessageFlags.IsComponentsV2,
      files: [visuals.eventWheelFrameAttachment(null, iconMap)],
      allowedMentions: SAFE_MENTIONS,
    });
    const spinDelays = [90, 100, 115, 130, 150, 175, 205, 240, 280, 330];
    for (const delay of spinDelays) {
      await sleep(delay);
      await wheelMessage
        .edit({ components: [visuals.buildEventWheelContainer()], flags: MessageFlags.IsComponentsV2, files: [visuals.eventWheelFrameAttachment(null, iconMap)], attachments: [] })
        .catch(() => {});
    }
    await sleep(200);
    await wheelMessage
      .edit({ components: [visuals.buildEventWheelContainer()], flags: MessageFlags.IsComponentsV2, files: [visuals.eventWheelFrameAttachment(type.key, iconMap)], attachments: [] })
      .catch(() => {});
    await sleep(900);
    await wheelMessage
      .edit({ components: [visuals.buildEventResultContainer(type, endsAt.getTime())], flags: MessageFlags.IsComponentsV2, files: [], attachments: [] })
      .catch(() => {});
  } catch (err) {
    console.error('[Xerion] El canvas de la ruleta de eventos falló, se degrada a solo el anuncio:', err);
    await channel.send({ components: [visuals.buildEventResultContainer(type, endsAt.getTime())], flags: MessageFlags.IsComponentsV2, allowedMentions: SAFE_MENTIONS }).catch(() => {});
  }

  if (type.kind === 'force_portal_rank' && !activePortals.has(channel.id)) {
    spawnPortal(channel, type.value, true).catch((err) => console.error('[Xerion] Error abriendo el Portal Dorado:', err));
  }

  return type;
}

/** Llamado una vez al boot (desde index.js) para recuperar un evento que ya estaba activo antes del reinicio. */
async function restoreEvent(client) {
  try {
    const saved = await db.getActiveEvent();
    if (!saved) return;
    if (new Date(saved.endsAt).getTime() <= Date.now()) {
      await db.clearActiveEvent(); // venció mientras el bot estaba caído — se limpia en silencio, sin anuncio de cierre
      return;
    }
    cachedEvent = saved;
    scheduleEventExpiry(client, saved.endsAt);
    console.log(`[Xerion] Evento "${saved.key}" restaurado — sigue activo hasta ${new Date(saved.endsAt).toISOString()}.`);
  } catch (err) {
    console.error('[Xerion] Error restaurando el evento activo:', err);
  }
}

/** Wrapper fino sobre spawnPortal para /panel-owner: devuelve boolean en vez de lanzar, y nunca persiste nada distinto de lo que ya hace spawnPortal. */
async function forcePortalSpawn(channel, forcedTypeKey = null) {
  return spawnPortal(channel, forcedTypeKey, true);
}

/** Arma el objeto de estado en vivo que necesita el panel del owner para re-renderizarse tras cada acción. */
async function getOwnerPanelStatus() {
  const { activeCount, cooldownMsLeft } = ownerForceStatus();
  const portalState = activePortals.get(CONFIG.PORTAL_CHANNEL_ID);
  return {
    chestCooldownActive: cooldownMsLeft > 0,
    activeChestCount: activeCount,
    portalActive: Boolean(portalState),
    portalTypeLabel: portalState?.portalType?.name || '',
    activeEvent: getCurrentEvent(),
  };
}

/** Mensajes-por-+1% efectivos ahora mismo — reducidos si "Cofres Abundantes" está activo, si no el valor normal de siempre. */
function getEffectiveStepMessages() {
  const activeEvent = getCurrentEvent();
  const eventType = activeEvent ? EVENT_TYPES[activeEvent.key] : null;
  return eventType?.kind === 'spawn_step_multiplier' ? Math.max(1, Math.round(CONFIG.PROBABILITY_STEP_MESSAGES * eventType.value)) : CONFIG.PROBABILITY_STEP_MESSAGES;
}

/** El objeto que game.js le pasa a admin-panel.js en cada interacción — así admin-panel.js nunca necesita importar game.js (evita una dependencia circular). */
function buildAdminGameApi() {
  return {
    tryForceSpawnChest,
    forcePortalSpawn,
    getCurrentEvent,
    activateEvent,
    deactivateEvent,
    getOwnerPanelStatus,
  };
}

// ============================================================================
// PORTALES — apuesta estilo "gate" (Solo Leveling). Un portal por canal a
// la vez. Sigue el mismo espíritu defensivo que los cofres: cualquier paso
// que falle se loguea y se degrada sin romper el resto del bot.
// ============================================================================

function portalSnapshot(state) {
  return {
    channelId: state.channelId,
    messageId: state.messageId,
    portalTypeKey: state.portalType.key,
    status: state.status,
    endsAt: state.endsAt,
    participants: Object.fromEntries(state.participants),
    isForced: Boolean(state.isForced),
  };
}

function persistPortalState(state) {
  return db.savePortal(state.channelId, portalSnapshot(state)).catch((err) => {
    console.error('[Xerion] No se pudo guardar el snapshot del portal:', err.message);
  });
}

async function clearPersistedPortal(channelId) {
  await db.clearPortal(channelId).catch((err) => {
    console.error('[Xerion] No se pudo limpiar el snapshot del portal:', err.message);
  });
}

/** Chequeo periódico: cada 1h, 50% de probabilidad de abrir un portal (si no hay uno activo ya). */
async function checkPortalSpawn(channel) {
  try {
    const lastCheck = await db.getLastPortalCheckAt();
    const msSinceCheck = lastCheck ? Date.now() - new Date(lastCheck).getTime() : Infinity;
    if (msSinceCheck < PORTAL_CHECK_INTERVAL_MS) return;

    await db.setLastPortalCheckAt(new Date());
    if (activePortals.has(channel.id)) return; // ya hay uno abierto

    const activeEvent = getCurrentEvent();
    const eventType = activeEvent ? EVENT_TYPES[activeEvent.key] : null;
    const chanceMultiplier = eventType?.kind === 'portal_chance_multiplier' ? eventType.value : 1;
    const effectiveChance = Math.min(1, PORTAL_SPAWN_CHANCE * chanceMultiplier);
    if (Math.random() >= effectiveChance) return; // no tocó esta vez

    await spawnPortal(channel, null, false);
  } catch (err) {
    console.error('[Xerion] Error en el chequeo de spawn de portal:', err);
  }
}

async function spawnPortal(channel, forcedTypeKey = null, isForced = false) {
  if (activePortals.has(channel.id)) return false;

  const portalType = pickPortalType(forcedTypeKey);
  const endsAt = Date.now() + PORTAL_JOIN_WINDOW_MS;

  const state = {
    channelId: channel.id,
    portalType,
    status: 'waiting',
    endsAt,
    participants: new Map(), // userId -> stake
    isForced,
    messageId: null,
  };
  activePortals.set(channel.id, state);

  try {
    const message = await channel.send({
      components: [visuals.buildPortalEmbed({ portalType, participants: [], pot: 0, endsAt, activeEvent: getCurrentEvent() })],
      flags: MessageFlags.IsComponentsV2,
      allowedMentions: SAFE_MENTIONS,
    });
    state.messageId = message.id;
    await persistPortalState(state);
  } catch (err) {
    console.error('[Xerion] Error anunciando el portal:', err);
    activePortals.delete(channel.id);
    return false;
  }

  setTimeout(() => {
    resolvePortalPhase(channel, state).catch((err) => console.error('[Xerion] Error resolviendo el portal:', err));
  }, PORTAL_JOIN_WINDOW_MS);

  console.log(`[Xerion] ${portalType.name} abierto en #${channel.id}${isForced ? ' (forzado por el owner)' : ''}.`);
  return true;
}

function schedulePortalCountUpdate(state, message) {
  if (state.status !== 'waiting') return;
  const participants = [...state.participants.entries()].map(([userId, stake]) => ({ userId, stake }));
  const pot = participants.reduce((sum, p) => sum + p.stake, 0);
  message
    .edit({
      components: [visuals.buildPortalEmbed({ portalType: state.portalType, participants, pot, endsAt: state.endsAt, activeEvent: getCurrentEvent() })],
      flags: MessageFlags.IsComponentsV2,
      allowedMentions: SAFE_MENTIONS,
    })
    .catch(() => {});
}

async function resolvePortalPhase(channel, state) {
  if (state.status !== 'waiting') return; // ya se resolvió (ej. por un restore)
  state.status = 'resolving';
  await persistPortalState(state);

  const participants = [...state.participants.entries()].map(([userId, stake]) => ({ userId, stake }));

  if (participants.length === 0) {
    await channel
      .send({
        components: [visuals.buildOpeningStepEmbed(`${state.portalType.emoji} El portal se cerró solo — nadie se animó a entrar.`, state.portalType.color)],
        flags: MessageFlags.IsComponentsV2,
        allowedMentions: SAFE_MENTIONS,
      })
      .catch(() => {});
    activePortals.delete(channel.id);
    await clearPersistedPortal(channel.id);
    return;
  }

  if (participants.length === 1) {
    const solo = participants[0];
    try {
      await db.refundPortalEntry(solo.userId, solo.stake);
    } catch (err) {
      console.error('[Xerion] Error devolviendo apuesta en portal en solitario:', err);
    }
    await channel
      .send({
        content: `${state.portalType.emoji} <@${solo.userId}> fue el único en entrar al ${state.portalType.name} — se le devuelve su apuesta, nadie contra quien competir.`,
        allowedMentions: pingOnly([solo.userId]),
      })
      .catch(() => {});
    activePortals.delete(channel.id);
    await clearPersistedPortal(channel.id);
    return;
  }

  await runPortalBattleAnimation(channel, state, participants);
  activePortals.delete(channel.id);
  await clearPersistedPortal(channel.id);
}

/**
 * Anima la "pelea contra el Boss" (ruleta de participantes, mismo motor que
 * el re-sorteo de cofres) y al final aplica el reparto real ya calculado
 * matemáticamente por computePortalPayouts — la animación es narrativa, el
 * resultado siempre sale de esa función, nunca al revés.
 */
async function runPortalBattleAnimation(channel, state, participants) {
  const payout = computePortalPayouts(state.portalType, participants);

  let spinSucceeded = false;
  let seqMessage = null;
  try {
    const users = (
      await Promise.all(participants.map((p) => channel.client.users.fetch(p.userId).catch(() => null)))
    ).filter(Boolean);
    const winnerUser = users.find((u) => u.id === payout.winnerId) || null;

    if (users.length > 0) {
      seqMessage = await channel
        .send({
          components: [visuals.buildPortalBattleContainer(state.portalType)],
          flags: MessageFlags.IsComponentsV2,
          allowedMentions: SAFE_MENTIONS,
        })
        .catch(() => null);

      if (seqMessage) {
        const avatarMap = await visuals.preloadPlayerAvatars(users);
        const spinDelays = [90, 100, 115, 130, 150, 175, 205, 240, 280, 330];
        for (let i = 0; i < spinDelays.length; i++) {
          const isLast = i === spinDelays.length - 1;
          const attachment = visuals.portalSpinFrameAttachment(users, avatarMap, state.portalType, isLast ? winnerUser : null);
          await seqMessage.edit({
            components: [visuals.buildPortalBattleContainer(state.portalType)],
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
    console.error('[Xerion] La animación del portal falló a mitad de camino, se degrada a texto:', err);
  }

  try {
    await db.payoutPortalResults([{ userId: payout.winnerId, amount: payout.winnerAmount }, ...payout.othersPayouts]);
  } catch (err) {
    console.error('[Xerion] Error aplicando el reparto del portal:', err);
  }

  const resultPayload = {
    components: [visuals.buildPortalResultEmbed(payout, state.portalType)],
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: pingOnly([payout.winnerId]),
  };
  if (spinSucceeded && seqMessage) await seqMessage.edit(resultPayload).catch(() => {});
  else await channel.send(resultPayload).catch(() => {});
}

async function handlePortalStakeButton(interaction) {
  const state = activePortals.get(interaction.channelId);
  if (!state || state.status !== 'waiting') {
    return interaction.reply({ content: 'Este portal ya no está recibiendo apuestas.', flags: MessageFlags.Ephemeral });
  }
  if (interaction.member?.roles?.cache?.has(CONFIG.ROLE_IDS.BLACKLIST)) {
    return interaction.reply({ content: '🚫 No puedes participar en los portales.', flags: MessageFlags.Ephemeral });
  }

  const modal = new ModalBuilder().setCustomId(`xerion_portal_stake_modal::${interaction.channelId}`).setTitle(`${state.portalType.name} — Apostar`);
  const input = new TextInputBuilder()
    .setCustomId('stake_amount')
    .setLabel(`Feathers a apostar (mínimo ${state.portalType.minStake})`)
    .setStyle(TextInputStyle.Short)
    .setPlaceholder(String(state.portalType.minStake))
    .setRequired(true);
  modal.addComponents(new ActionRowBuilder().addComponents(input));
  await interaction.showModal(modal);
}

async function handlePortalStakeSubmit(interaction) {
  const channelId = interaction.customId.split('::')[1];
  const state = activePortals.get(channelId);
  if (!state || state.status !== 'waiting') {
    return interaction.reply({ content: 'Este portal ya no está recibiendo apuestas.', flags: MessageFlags.Ephemeral });
  }

  const raw = interaction.fields.getTextInputValue('stake_amount').replace(/[.,\s]/g, '');
  const amount = Number.parseInt(raw, 10);
  if (!Number.isFinite(amount) || amount <= 0) {
    return interaction.reply({ content: 'Poné un número válido de Feathers.', flags: MessageFlags.Ephemeral });
  }
  if (amount < state.portalType.minStake) {
    return interaction.reply({ content: `La apuesta mínima para ${state.portalType.name} es ${state.portalType.minStake} ${FEATHER_EMOJI}.`, flags: MessageFlags.Ephemeral });
  }
  if (state.participants.has(interaction.user.id)) {
    return interaction.reply({ content: 'Ya estás dentro de este portal — solo se puede apostar una vez por portal.', flags: MessageFlags.Ephemeral });
  }

  const remaining = await db.stakePortalEntry(interaction.user.id, amount).catch((err) => {
    console.error('[Xerion] Error descontando apuesta de portal:', err);
    return undefined;
  });
  if (remaining === undefined) {
    return interaction.reply({ content: 'Something went wrong — try again in a moment.', flags: MessageFlags.Ephemeral });
  }
  if (remaining === null) {
    return interaction.reply({ content: `No te alcanzan las Feathers para apostar \`${amount}\`.`, flags: MessageFlags.Ephemeral });
  }

  state.participants.set(interaction.user.id, amount);
  await persistPortalState(state);
  await interaction.reply({ content: `✅ Entraste al ${state.portalType.name} apostando \`${amount}\` ${FEATHER_EMOJI}. Suerte.`, flags: MessageFlags.Ephemeral });

  if (state.messageId) {
    const channel = await interaction.client.channels.fetch(state.channelId).catch(() => null);
    const message = channel ? await channel.messages.fetch(state.messageId).catch(() => null) : null;
    if (channel && message) schedulePortalCountUpdate(state, message);
  }
}

/** Restaura portales activos tras un reinicio — mismo espíritu que restoreActiveChest. */
async function restorePortals(client) {
  const rows = await db.getActivePortals().catch((err) => {
    console.error('[Xerion] Error leyendo portales activos:', err);
    return [];
  });

  for (const row of rows) {
    const snapshot = row.snapshot;
    const portalType = PORTAL_TYPES[snapshot.portalTypeKey];
    if (!snapshot?.channelId || !portalType) continue;

    const channel = await client.channels.fetch(snapshot.channelId).catch(() => null);
    if (!channel) {
      await clearPersistedPortal(snapshot.channelId);
      continue;
    }

    const state = {
      channelId: snapshot.channelId,
      portalType,
      status: snapshot.status,
      endsAt: snapshot.endsAt,
      participants: new Map(Object.entries(snapshot.participants || {})),
      isForced: Boolean(snapshot.isForced),
      messageId: snapshot.messageId,
    };
    activePortals.set(state.channelId, state);

    const msLeft = Math.max(0, Number(state.endsAt || Date.now()) - Date.now());
    setTimeout(() => {
      resolvePortalPhase(channel, state).catch((err) => console.error('[Xerion] Error resolviendo portal tras reinicio:', err));
    }, msLeft);
  }
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
  const activeEvent = getCurrentEvent();
  const eventType = activeEvent ? EVENT_TYPES[activeEvent.key] : null;
  const cost = eventType?.kind === 'shop_discount' ? Math.max(1, Math.round(item.cost * eventType.value)) : item.cost;
  const BUY_FUNCTIONS = { SHIELD: db.buyShield, CHARM: db.buyCharm, REVIVE: db.buyRevive, WARD: db.buyVoidWard, TIME_SKIP: db.buyTimeSkip };
  const buyFn = BUY_FUNCTIONS[itemKey];

  let result;
  try {
    result = await buyFn(interaction.user.id, cost);
  } catch (err) {
    console.error('[Xerion] Error procesando compra en la tienda:', err);
    return interaction.reply({ content: 'Something went wrong with that purchase — try again in a moment.', flags: MessageFlags.Ephemeral });
  }

  if (!result) {
    return interaction.reply({
      content: `No te alcanzan las Feathers para comprar ${item.emoji} **${item.name}** (cuesta \`${cost}\`).`,
      flags: MessageFlags.Ephemeral,
    });
  }

  await interaction.update({ components: [visuals.buildShopContainer(result, ownerId, activeEvent)], flags: MessageFlags.IsComponentsV2, allowedMentions: SAFE_MENTIONS });
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

const slashCommandDefinitions = [
  new SlashCommandBuilder()
    .setName('profile')
    .setDescription('View your Xerion stats.')
    .addUserOption((opt) => opt.setName('user').setDescription('Whose profile to view').setRequired(false)),

  new SlashCommandBuilder().setName('cooldowns').setDescription('See when your /daily and role incomes are ready to claim.'),

  new SlashCommandBuilder().setName('inventory').setDescription('Quick balance and item check.'),
  new SlashCommandBuilder().setName('leaderboard').setDescription('Top Feather holders on the server.'),
  new SlashCommandBuilder().setName('rates').setDescription('See the chest reward odds for all 3 chest tiers.'),
  new SlashCommandBuilder().setName('portals').setDescription('See the odds and payout split for all 3 portal ranks.'),
  new SlashCommandBuilder().setName('event').setDescription('See the active global event, if any.'),
  new SlashCommandBuilder().setName('shop').setDescription('Spend your Feathers on Shields and Luck Charms.'),
  new SlashCommandBuilder().setName('notification').setDescription('Toggle DM alerts for when a chest appears.'),
  new SlashCommandBuilder().setName('stats').setDescription('Server-wide Xerion stats.'),
  new SlashCommandBuilder().setName('help').setDescription('List all Xerion commands.'),
  new SlashCommandBuilder().setName('chest').setDescription('See the live chest status and channel chance.'),
  new SlashCommandBuilder().setName('daily').setDescription('Claim 25 Feathers once every 24 hours.'),
  new SlashCommandBuilder().setName('claim').setDescription('Collect passive Feathers earned by the roles you own.'),
  new SlashCommandBuilder().setName('history').setDescription('View your latest chest rewards.'),
  new SlashCommandBuilder().setName('achievements').setDescription('View your Xerion achievements.'),
  new SlashCommandBuilder().setName('streak').setDescription('View your Xerion activity.'),
  new SlashCommandBuilder().setName('ping').setDescription('Check Xerion latency.'),
  new SlashCommandBuilder().setName('about').setDescription('About Xerion and its current version.'),
  new SlashCommandBuilder().setName('rules').setDescription('Read the quick game rules.'),
  adminPanel.commandDefinition,
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

async function cmdCooldowns(interaction) {
  const stats = await db.getUserStats(interaction.user.id, identityFor(interaction.user));
  const heldRoleKeys = getHeldRoleKeys(interaction.member);
  const now = Date.now();

  const lastDaily = stats.last_daily_claim_at ? new Date(stats.last_daily_claim_at).getTime() : null;
  const dailyReadyAt = lastDaily === null ? now : lastDaily + 24 * 60 * 60 * 1000;
  const dailyInfo = { ready: dailyReadyAt <= now, readyAt: new Date(dailyReadyAt) };

  const roleIncomeList = heldRoleKeys
    .filter((key) => ROLE_PASSIVE_INCOME[key])
    .map((key) => {
      const cols = db.ROLE_INCOME_COLUMNS[key];
      const roleType = CHEST_TYPE_LIST.flatMap((t) => t.rewardTable).find((r) => r.key === key);
      const lastAt = cols && stats[cols.at] ? new Date(stats[cols.at]).getTime() : null;
      const readyAt = lastAt === null ? now : lastAt + ROLE_PASSIVE_INCOME[key].intervalMs;
      return { key, name: roleType?.label || key, emoji: roleType?.emoji || '🏅', ready: readyAt <= now, readyAt: new Date(readyAt) };
    });

  return sendV2(interaction, visuals.buildCooldownsContainer(dailyInfo, roleIncomeList));
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
    await interaction.editReply({ components: [visuals.buildShopContainer(counts, interaction.user.id, getCurrentEvent())], flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral, allowedMentions: SAFE_MENTIONS });
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
    await interaction.editReply({ components: [visuals.buildStatsContainer(serverStats, getEffectiveStepMessages())], flags: MessageFlags.IsComponentsV2, allowedMentions: SAFE_MENTIONS });
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
  return sendV2(interaction, visuals.buildChestStatusContainer(channelId, state, activeChests.get(channelId), getEffectiveStepMessages()));
}

async function cmdDaily(interaction) {
  const activeEvent = getCurrentEvent();
  const type = activeEvent ? EVENT_TYPES[activeEvent.key] : null;
  const multiplier = type?.kind === 'daily_multiplier' || type?.kind === 'feather_multiplier' ? type.value : 1;
  const result = await db.claimDaily(interaction.user.id, identityFor(interaction.user), getHeldRoleKeys(interaction.member), multiplier);
  if (result.claimed && result.streak_visible !== false) {
    updateStreakNickname(interaction.member, result.current_streak).catch(() => {});
  }
  return sendV2(interaction, visuals.buildDailyContainer(result), true);
}

async function cmdClaim(interaction) {
  const activeEvent = getCurrentEvent();
  const type = activeEvent ? EVENT_TYPES[activeEvent.key] : null;
  const multiplier = type?.kind === 'role_income_multiplier' || type?.kind === 'feather_multiplier' ? type.value : 1;
  const result = await db.collectRoleIncome(interaction.user.id, getHeldRoleKeys(interaction.member), multiplier);
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

async function cmdPortals(interaction) {
  return sendV2(interaction, visuals.buildPortalRatesContainer());
}

async function cmdEvent(interaction) {
  return sendV2(interaction, visuals.buildEventStatusContainer(getCurrentEvent()));
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
    case 'profile': return cmdProfile(interaction);
    case 'cooldowns': return cmdCooldowns(interaction);
    case 'inventory': return cmdInventory(interaction);
    case 'leaderboard': return cmdLeaderboard(interaction);
    case 'rates': return cmdRates(interaction);
    case 'portals': return cmdPortals(interaction);
    case 'event': return cmdEvent(interaction);
    case 'shop': return cmdShop(interaction);
    case 'notification': return cmdNotification(interaction);
    case 'stats': return cmdStats(interaction);
    case 'help': return cmdHelp(interaction);
    case 'chest': return cmdChest(interaction);
    case 'daily': return cmdDaily(interaction);
    case 'claim': return cmdClaim(interaction);
    case 'history': return cmdHistory(interaction);
    case 'achievements': return cmdAchievements(interaction);
    case 'streak': return cmdStreak(interaction);
    case 'ping': return cmdPing(interaction);
    case 'about': return cmdAbout(interaction);
    case 'rules': return cmdRules(interaction);
    case 'panel-owner': return adminPanel.cmdPanelOwner(interaction, buildAdminGameApi());
    default: return interaction.reply({ content: 'Unknown command.', flags: MessageFlags.Ephemeral });
  }
}

// ============================================================================
// COMANDOS CON PREFIJO ("xn ...") — mismas acciones, sin ping al responder.
// ============================================================================

function noPingReply(message, payload) {
  return message.reply({ ...payload, allowedMentions: { ...(payload.allowedMentions || SAFE_MENTIONS), repliedUser: false } });
}

async function prefixCooldowns(message) {
  const stats = await db.getUserStats(message.author.id, identityFor(message.author));
  const heldRoleKeys = getHeldRoleKeys(message.member);
  const now = Date.now();

  const lastDaily = stats.last_daily_claim_at ? new Date(stats.last_daily_claim_at).getTime() : null;
  const dailyReadyAt = lastDaily === null ? now : lastDaily + 24 * 60 * 60 * 1000;
  const dailyInfo = { ready: dailyReadyAt <= now, readyAt: new Date(dailyReadyAt) };

  const roleIncomeList = heldRoleKeys
    .filter((key) => ROLE_PASSIVE_INCOME[key])
    .map((key) => {
      const cols = db.ROLE_INCOME_COLUMNS[key];
      const roleType = CHEST_TYPE_LIST.flatMap((t) => t.rewardTable).find((r) => r.key === key);
      const lastAt = cols && stats[cols.at] ? new Date(stats[cols.at]).getTime() : null;
      const readyAt = lastAt === null ? now : lastAt + ROLE_PASSIVE_INCOME[key].intervalMs;
      return { key, name: roleType?.label || key, emoji: roleType?.emoji || '🏅', ready: readyAt <= now, readyAt: new Date(readyAt) };
    });

  return noPingReply(message, { components: [visuals.buildCooldownsContainer(dailyInfo, roleIncomeList)], flags: MessageFlags.IsComponentsV2 });
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
  return noPingReply(message, { components: [visuals.buildShopContainer(counts, message.author.id, getCurrentEvent())], flags: MessageFlags.IsComponentsV2 });
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
  return noPingReply(message, { components: [visuals.buildStatsContainer(serverStats, getEffectiveStepMessages())], flags: MessageFlags.IsComponentsV2 });
}

async function prefixHelp(message) {
  return noPingReply(message, { components: [visuals.buildHelpContainer()], flags: MessageFlags.IsComponentsV2 });
}

async function prefixChest(message) {
  const state = await db.getServerStats(CONFIG.CHEST_CHANNEL_ID);
  return noPingReply(message, {
    components: [visuals.buildChestStatusContainer(CONFIG.CHEST_CHANNEL_ID, state, activeChests.get(CONFIG.CHEST_CHANNEL_ID), getEffectiveStepMessages())],
    flags: MessageFlags.IsComponentsV2,
  });
}

async function prefixDaily(message) {
  const activeEvent = getCurrentEvent();
  const type = activeEvent ? EVENT_TYPES[activeEvent.key] : null;
  const multiplier = type?.kind === 'daily_multiplier' || type?.kind === 'feather_multiplier' ? type.value : 1;
  const result = await db.claimDaily(message.author.id, identityFor(message.author), getHeldRoleKeys(message.member), multiplier);
  if (result.claimed && result.streak_visible !== false) {
    updateStreakNickname(message.member, result.current_streak).catch(() => {});
  }
  return noPingReply(message, { components: [visuals.buildDailyContainer(result)], flags: MessageFlags.IsComponentsV2 });
}

async function prefixClaim(message) {
  const activeEvent = getCurrentEvent();
  const type = activeEvent ? EVENT_TYPES[activeEvent.key] : null;
  const multiplier = type?.kind === 'role_income_multiplier' || type?.kind === 'feather_multiplier' ? type.value : 1;
  const result = await db.collectRoleIncome(message.author.id, getHeldRoleKeys(message.member), multiplier);
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

async function prefixPortals(message) {
  return noPingReply(message, { components: [visuals.buildPortalRatesContainer()], flags: MessageFlags.IsComponentsV2 });
}

async function prefixEvent(message) {
  return noPingReply(message, { components: [visuals.buildEventStatusContainer(getCurrentEvent())], flags: MessageFlags.IsComponentsV2 });
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
      case 'profile': case 'perfil': return await prefixProfile(message);
      case 'cooldowns': case 'cooldown': return await prefixCooldowns(message);
      case 'inv': case 'inventory': return await prefixInventory(message);
      case 'top': case 'leaderboard': return await prefixLeaderboard(message);
      case 'rates': case 'odds': return await prefixRates(message);
      case 'portals': case 'portales': return await prefixPortals(message);
      case 'event': case 'evento': return await prefixEvent(message);
      case 'shop': case 'tienda': return await prefixShop(message);
      case 'notification': case 'notif': return await prefixNotification(message);
      case 'stats': return await prefixStats(message);
      case 'chest': case 'cofre': return await prefixChest(message);
      case 'daily': return await prefixDaily(message);
      case 'claim': return await prefixClaim(message);
      case 'history': case 'historial': return await prefixHistory(message);
      case 'achievements': case 'logros': return await prefixAchievements(message);
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
  // ignoreEveryone: un @everyone/@here NO cuenta como que me mencionaron a mí.
  // ignoreRepliedUser: responder a CUALQUIER mensaje del bot (con el "ping"
  // de respuesta activado, que es el comportamiento por defecto de Discord)
  // NO cuenta como mención — si no, cualquier respuesta a un mensaje de
  // eliminación, de cofre, etc. activaría la IA por error.
  if (message.mentions.has(message.client.user.id, { ignoreEveryone: true, ignoreRepliedUser: true })) return true;
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
      if (id.startsWith('xerion_buy_ward::')) return await handleShopBuy(interaction, 'WARD');
      if (id.startsWith('xerion_buy_timeskip::')) return await handleShopBuy(interaction, 'TIME_SKIP');
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
      if (id.startsWith('xerion_portal_stake::')) return await handlePortalStakeButton(interaction);
      if (adminPanel.isRelevant(id)) return await adminPanel.handleComponent(interaction, buildAdminGameApi());
    }
    if (interaction.isStringSelectMenu()) {
      if (adminPanel.isRelevant(interaction.customId)) return await adminPanel.handleComponent(interaction, buildAdminGameApi());
    }
    if (interaction.isModalSubmit()) {
      const id = interaction.customId;
      if (id.startsWith('xerion_portal_stake_modal::')) return await handlePortalStakeSubmit(interaction);
    }
  } catch (err) {
    // 10062 = "Unknown interaction": la interacción ya pasó los 3s que da
    // Discord para responder (típicamente un backlog de clics/comandos
    // viejos entregados de golpe tras una reconexión). No es un bug, no
    // tiene arreglo posible del lado del bot, y responder de nuevo fallaría
    // exactamente igual — así que se loguea aparte, sin alarmar, y no se
    // reintenta nada.
    if (err?.code === 10062) {
      console.log('[Xerion] Interacción vencida (>3s), se ignora — no es un error real.');
      return;
    }
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
  restorePortals,
  restoreEvent,
  checkPortalSpawn,
  spawnPortal,
};
