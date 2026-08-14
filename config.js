/**
 * ============================================================================
 *  XERION v1.7.5 — config.js
 * ----------------------------------------------------------------------------
 *  Todo lo ajustable a tu servidor, las tablas de recompensas de los 3 tipos
 *  de cofre, la tienda de objetos y las utilidades puras (sin dependencias de
 *  discord.js ni de la base de datos) viven en este archivo. Los otros 4
 *  archivos (database.js, visuals.js, game.js, index.js) lo importan.
 * ============================================================================
 */

'use strict';

const CONFIG = {
  BOT_NAME: 'Xerion',
  VERSION: '1.7.5',
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
    GOAT: '1537232162246496346',
    ARISE: '1531512361104572507',
  },

  // ----------------------------------------------------------------------
  // Probabilidad DINÁMICA por canal. Empieza en 0% y sube 1 punto porcentual
  // por cada 100 mensajes sin cofre, hasta 100%. Los contadores viven en
  // Postgres por canal y se resetean únicamente cuando aparece un cofre.
  // ----------------------------------------------------------------------
  BASE_SPAWN_CHANCE: 0,
  PROBABILITY_STEP_MESSAGES: 100,
  PROBABILITY_STEP_INCREASE: 0.01,
  MAX_SPAWN_CHANCE: 1,

  JOIN_WINDOW_MS: 5 * 60 * 1000, // 5 minutos para pulsar "Participate"

  // Ritmo del minijuego de eliminación
  // Pausa deliberada de 3 segundos entre cada ronda de eliminación — le da
  // tiempo a la gente de leer quién cayó antes de que llegue la siguiente.
  INTRO_DELAY_MS: 250,
  ELIMINATION_DELAY_MIN_MS: 3000,
  ELIMINATION_DELAY_MAX_MS: 3000,
  BATCH_THRESHOLD: 10,
  BATCH_FRACTION: 0.25,

  COLORS: {
    BRAND: 0xe8442c,
    FEATHERS: 0xff9f43,
    AURA_INFINITE: 0x8b5cf6,
    KING: 0xe8b613,
    GOAT: 0xcd7f32,
    ARISE: 0x9d0208,
    NOTHING: 0x57534e,
    DARK: 0x1a1410,
    CENIZA: 0x9a958c,
    BRASA: 0xff6b35,
    ABISMO: 0x3b0764,
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

// bird + ZWJ + fire = 🐦‍🔥 Phoenix (emoji real de Unicode 15, no un combo inventado
// — así nunca sale "bugueado" ni como dos emojis sueltos).
const FEATHER_EMOJI = '🐦\u200d🔥';

// ============================================================================
// TIPOS DE COFRE — 3 niveles, cada uno con su propia tabla de recompensas.
// El sistema es deliberadamente muy difícil incluso en el nivel más alto:
// "Nothing" sigue siendo, por mucho, el resultado más probable.
// ============================================================================

function buildRewardTable(t) {
  return [
    {
      key: 'ARISE', label: 'ARISE', emoji: '💀', chance: t.arise, color: CONFIG.COLORS.ARISE,
      kind: 'role', roleId: CONFIG.ROLE_IDS.ARISE, mention: `<@&${CONFIG.ROLE_IDS.ARISE}>`,
    },
    {
      key: 'KING', label: 'KING', emoji: '👑', chance: t.king, color: CONFIG.COLORS.KING,
      kind: 'role', roleId: CONFIG.ROLE_IDS.KING, mention: `<@&${CONFIG.ROLE_IDS.KING}>`,
    },
    {
      key: 'GOAT', label: 'GOAT', emoji: '🐐', chance: t.goat, color: CONFIG.COLORS.GOAT,
      kind: 'role', roleId: CONFIG.ROLE_IDS.GOAT, mention: `<@&${CONFIG.ROLE_IDS.GOAT}>`,
    },
    {
      key: 'AURA_INFINITE', label: 'AURA INFINITE', emoji: '🌌', chance: t.aura, color: CONFIG.COLORS.AURA_INFINITE,
      kind: 'role', roleId: CONFIG.ROLE_IDS.AURA_INFINITE, mention: `<@&${CONFIG.ROLE_IDS.AURA_INFINITE}>`,
    },
    {
      key: 'FEATHERS', label: 'Feathers', emoji: FEATHER_EMOJI, chance: t.feathers, color: CONFIG.COLORS.FEATHERS,
      kind: 'currency', amountMin: t.featherMin, amountMax: t.featherMax,
    },
    {
      key: 'NOTHING', label: 'Nothing', emoji: '💨', chance: t.nothing, color: CONFIG.COLORS.NOTHING, kind: 'none',
    },
  ];
}

const CHEST_TYPES = {
  CENIZA: {
    key: 'CENIZA',
    name: 'Cofre de Ceniza',
    tierLabel: 'Común',
    emoji: '🩶',
    color: CONFIG.COLORS.CENIZA,
    weight: 70,
    flavor: 'Lo más habitual. La mayoría de las veces no guarda nada — pero "la mayoría" no es "siempre".',
    rewardTable: buildRewardTable({ arise: 0.15, king: 0.35, goat: 0.48, aura: 0.6, feathers: 6, featherMin: 8, featherMax: 15, nothing: 92.42 }),
  },
  BRASA: {
    key: 'BRASA',
    name: 'Cofre de Brasa',
    tierLabel: 'Raro',
    emoji: '🔥',
    color: CONFIG.COLORS.BRASA,
    weight: 25,
    flavor: 'Arde distinto. Las probabilidades de premio se cuadruplican frente a un cofre común.',
    rewardTable: buildRewardTable({ arise: 0.4, king: 0.9, goat: 1.2, aura: 1.6, feathers: 12, featherMin: 15, featherMax: 30, nothing: 83.9 }),
  },
  ABISMO: {
    key: 'ABISMO',
    name: 'Cofre del Abismo',
    tierLabel: 'Legendario',
    emoji: '🌑',
    color: CONFIG.COLORS.ABISMO,
    weight: 5,
    flavor: 'Casi nunca aparece. Sigue sin ser fácil — pero es lo más cerca que vas a estar de un rol legendario.',
    rewardTable: buildRewardTable({ arise: 1.2, king: 2.5, goat: 3.3, aura: 4.3, feathers: 25, featherMin: 30, featherMax: 60, nothing: 63.7 }),
  },
};

const CHEST_TYPE_LIST = Object.values(CHEST_TYPES);

/** Elige un tipo de cofre al azar según su peso, o fuerza uno si se pasa forcedKey. */
function pickChestType(forcedKey = null) {
  if (forcedKey) {
    const forced = CHEST_TYPES[forcedKey.toUpperCase()];
    if (forced) return forced;
  }
  const totalWeight = CHEST_TYPE_LIST.reduce((sum, t) => sum + t.weight, 0);
  let roll = Math.random() * totalWeight;
  for (const type of CHEST_TYPE_LIST) {
    roll -= type.weight;
    if (roll <= 0) return type;
  }
  return CHEST_TYPE_LIST[0];
}

// ============================================================================
// TIENDA — lo único en lo que se pueden gastar las Feathers. Les da un uso
// real: sobrevivir una ronda o mejorar tu tirada, no solo un número en el perfil.
// ============================================================================

const SHOP_ITEMS = {
  SHIELD: {
    key: 'SHIELD',
    name: 'Escudo de Xerion',
    emoji: '🛡️',
    cost: 140,
    description: 'Objeto raro: te protege automáticamente si te toca caer en la **primera ronda** de tu próxima batalla. Se consume al usarse.',
  },
  CHARM: {
    key: 'CHARM',
    name: 'Amuleto de Suerte',
    emoji: '🍀',
    cost: 220,
    description: 'Objeto legendario: la próxima vez que abras un cofre, tus probabilidades de conseguir un **rol** suben un 50%. Se consume al usarse.',
  },
  REVIVE: {
    key: 'REVIVE',
    name: 'Pluma Fénix',
    emoji: '🪶',
    cost: 400,
    description: 'Objeto mítico: si te eliminan en una batalla, revives una única vez y sigues en juego hasta la siguiente ronda. Se consume al usarse, funcione o no.',
  },
};

// ============================================================================
// PROBABILIDAD DINÁMICA — funciones puras, fáciles de testear.
// ============================================================================

function computeSpawnChance(messagesSinceChest) {
  const steps = Math.floor(messagesSinceChest / CONFIG.PROBABILITY_STEP_MESSAGES);
  const chance = CONFIG.BASE_SPAWN_CHANCE + steps * CONFIG.PROBABILITY_STEP_INCREASE;
  return Math.min(chance, CONFIG.MAX_SPAWN_CHANCE);
}

function messagesUntilNextIncrease(messagesSinceChest) {
  const step = CONFIG.PROBABILITY_STEP_MESSAGES;
  const remainder = messagesSinceChest % step;
  return remainder === 0 ? step : step - remainder;
}

// ============================================================================
// RECOMPENSAS
// ============================================================================

function rollReward(table) {
  const roll = Math.random() * 100;
  let cumulative = 0;
  for (const reward of table) {
    cumulative += reward.chance;
    if (roll < cumulative) return reward;
  }
  return table[table.length - 1]; // red de seguridad ante redondeos de punto flotante
}

/** Sube un 50% las probabilidades de rol, restando esa diferencia de "Nothing" (la suma sigue siendo 100). */
function applyLuckBoost(table) {
  const boosted = table.map((r) => ({ ...r }));
  let delta = 0;
  for (const r of boosted) {
    if (r.kind === 'role') {
      const increase = r.chance * 0.5;
      r.chance += increase;
      delta += increase;
    }
  }
  const nothing = boosted.find((r) => r.key === 'NOTHING');
  if (nothing) nothing.chance = Math.max(0, nothing.chance - delta);
  return boosted;
}

function randomBetween(min, max) {
  return Math.floor(min + Math.random() * (max - min));
}

function rollFeatherAmount(reward) {
  return randomBetween(reward.amountMin, reward.amountMax + 1);
}

function formatFeatherRange(reward) {
  return `${reward.amountMin}–${reward.amountMax}`;
}

// ============================================================================
// UTILIDADES GENERALES (puras)
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

function formatSpanishList(names) {
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(', ')} y ${names[names.length - 1]}`;
}

function formatNumber(n) {
  return new Intl.NumberFormat('en-US').format(n);
}

function toUnixSeconds(date) {
  return Math.floor(new Date(date).getTime() / 1000);
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

// Por defecto, ningún mensaje del bot pinga a nadie. Solo se activa
// explícitamente para la eliminación y el ganador del cofre (ver game.js).
const SAFE_MENTIONS = { parse: [] };
function pingOnly(userIds) {
  return { parse: [], users: [...new Set(userIds)] };
}

// ============================================================================
// TIPS — pequeños consejos que aparecen a veces (nunca siempre) al fondo de
// algunos paneles, para que la gente descubra comandos y objetos sin que
// se sienta como un manual pegado encima del diseño.
// ============================================================================

const TIPS = [
  'Activa `/notification` para recibir un DM apenas aparezca un cofre — así nunca llegas tarde.',
  'Si ganaste un cofre y no lo abriste a tiempo, usa `/claim` para reclamarlo aunque el mensaje ya haya quedado arriba en el chat.',
  'Tu racha de `/daily` se puede mostrar en tu apodo — revisa `/streak` para activarla o desactivarla.',
  'Un Escudo de `/shop` te protege automáticamente en la primera ronda de tu próxima batalla.',
  'La Pluma Fénix es cara, pero te revive una vez si te eliminan — puede ser tu única oportunidad de seguir en juego.',
  'Con `/rates` puedes ver exactamente qué tan difícil es cada tipo de cofre antes de arriesgarte.',
  'El Cofre del Abismo es rarísimo, pero cuadruplica tus probabilidades de rol frente al Cofre de Ceniza.',
  'No te saltes tu `/daily`: dejar pasar más de un día reinicia tu racha desde cero.',
  'Un Amuleto de Suerte sube un 50% tus probabilidades de conseguir un rol en tu próxima apertura.',
];

const TIP_SHOW_CHANCE = 0.2; // ~1 de cada 5 veces, para que se sienta ocasional y no repetitivo

function pickRandomTip() {
  return TIPS[randomInt(TIPS.length)];
}

/** Devuelve una línea de tip formateada al azar, o cadena vacía la mayoría de las veces. */
function maybeTipLine() {
  return Math.random() < TIP_SHOW_CHANCE ? `💡 **Tip:** ${pickRandomTip()}` : '';
}

console.log(`[Xerion] Configuración cargada — v${CONFIG.VERSION}`);

module.exports = {
  CONFIG,
  FEATHER_EMOJI,
  CHEST_TYPES,
  CHEST_TYPE_LIST,
  pickChestType,
  SHOP_ITEMS,
  computeSpawnChance,
  messagesUntilNextIncrease,
  rollReward,
  applyLuckBoost,
  rollFeatherAmount,
  formatFeatherRange,
  sleep,
  randomInt,
  shuffle,
  randomBetween,
  formatSpanishList,
  formatNumber,
  toUnixSeconds,
  isOnCooldown,
  SAFE_MENTIONS,
  pingOnly,
  TIPS,
  pickRandomTip,
  maybeTipLine,
};
