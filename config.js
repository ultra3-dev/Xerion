/**
 * ============================================================================
 *  XERION v2.0.5 ULTRA — config.js
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
  VERSION: '2.0.5 ULTRA',
  PREFIX: 'xn',

  // Secretos / infraestructura — se leen del entorno, nunca se hardcodean.
  TOKEN: process.env.DISCORD_TOKEN,
  CLIENT_ID: process.env.CLIENT_ID,
  GUILD_ID: process.env.GUILD_ID || null, // opcional: registro instantáneo de slash commands
  DATABASE_URL: process.env.DATABASE_URL,
  PORT: process.env.PORT || 3000,

  // Específico de tu servidor
  CHEST_CHANNEL_ID: '1489672925299605555',
  // Opcional: si querés que los portales aparezcan en otro canal, poné
  // PORTAL_CHANNEL_ID en las variables de entorno. Si no, usan el mismo
  // canal que los cofres — así no hace falta configurar nada nuevo.
  PORTAL_CHANNEL_ID: process.env.PORTAL_CHANNEL_ID || '1489672925299605555',
  OWNER_ID: '1064678074010058752',

  ROLE_IDS: {
    AURA_INFINITE: '1494579589752684614',
    KING: '1531508465174970518',
    GOAT: '1537232162246496346',
    ARISE: '1531512361104572507',
    STAR_X: '1489704408538415184',
    // Exclusivos del Cofre OG — mismo trato que los 5 de arriba en todo
    // (income pasivo, bonus de Feathers, /profile, /cooldowns): si se
    // pierde el rol en Discord, se pierde el beneficio, igual que siempre.
    NINE_K: '1489704438489677994',
    THREE_K: '1489704434958077952',
    OG: '1489704431518744666',
    BLACKLIST: '1501082061166084237',
  },

  // ----------------------------------------------------------------------
  // Probabilidad DINÁMICA por canal. Empieza en 0% y sube 1 punto porcentual
  // por cada 100 mensajes sin cofre, hasta 100%. Los contadores viven en
  // Postgres por canal y se resetean únicamente cuando aparece un cofre.
  // ----------------------------------------------------------------------
  BASE_SPAWN_CHANCE: 0,
  PROBABILITY_STEP_MESSAGES: 115,
  PROBABILITY_STEP_INCREASE: 0.01,
  MAX_SPAWN_CHANCE: 1,

  JOIN_WINDOW_MS: 5 * 60 * 1000, // 5 minutos para pulsar "Participate"

  // Ritmo del minijuego de eliminación: al cerrarse el cofre hay una pausa
  // de 10s antes de la primera eliminación (para que la gente alcance a leer
  // quién entró), y luego cada ronda sigue a su propio ritmo de 3s.
  INTRO_DELAY_MS: 10000,
  ELIMINATION_DELAY_MIN_MS: 3000,
  ELIMINATION_DELAY_MAX_MS: 3000,
  BATCH_THRESHOLD: 10,
  BATCH_FRACTION: 0.25,

  // Si el ganador no reclama su cofre en este plazo, se re-sortea entre el
  // resto de participantes (con una ruleta de jugadores) para que el canal
  // nunca se quede trabado esperando a alguien que no vuelve.
  UNCLAIMED_CHEST_TIMEOUT_MS: 5 * 60 * 1000,

  // Spawns forzados por el owner (bypasean "ya hay un cofre activo"): tope
  // de cuántos pueden estar vivos a la vez y cuánto hay que esperar entre
  // uno y el siguiente, para no sobrecargar al bot ni a Discord.
  OWNER_FORCE_MAX_ACTIVE: 5,
  OWNER_FORCE_COOLDOWN_MS: 30 * 1000,

  COLORS: {
    BRAND: 0xe8442c,
    FEATHERS: 0xff9f43,
    AURA_INFINITE: 0x8b5cf6,
    KING: 0xe8b613,
    GOAT: 0xcd7f32,
    ARISE: 0x9d0208,
    STAR_X: 0x5bc0de,
    NINE_K: 0x38bdf8,
    THREE_K: 0xfacc15,
    OG: 0x0a0a0a,
    NOTHING: 0x57534e,
    DARK: 0x1a1410,
    CENIZA: 0x9a958c,
    BRASA: 0xff6b35,
    ABISMO: 0x3b0764,
    OG_CHEST: 0xd946ef,
    PORTAL_E: 0x2dd4bf,
    PORTAL_B: 0x7c3aed,
    PORTAL_S: 0xdc2626,
    RNG_COMUN: 0x9ca3af,
    RNG_POCO_COMUN: 0x4ade80,
    RNG_RARO: 0x38bdf8,
    RNG_EPICO: 0xa855f7,
    RNG_LEGENDARIO: 0xf59e0b,
    RNG_MITICO: 0xef4444,
    RNG_SECRETO: 0xffffff,
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
      key: 'STAR_X', label: 'STAR X', emoji: '⭐', chance: t.starX, color: CONFIG.COLORS.STAR_X,
      kind: 'role', roleId: CONFIG.ROLE_IDS.STAR_X, mention: `<@&${CONFIG.ROLE_IDS.STAR_X}>`,
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

/**
 * Tabla de recompensas exclusiva del Cofre OG — 3 roles totalmente
 * distintos de los otros cofres (9K, 3K, OG), cada uno con su propio
 * income pasivo y bonus de Feathers (ver ROLE_FEATHER_BONUS/ROLE_PASSIVE_INCOME
 * más abajo). A propósito una función separada de buildRewardTable: así
 * CENIZA/BRASA/ABISMO no se tocan para nada.
 */
function buildOgRewardTable(t) {
  return [
    {
      key: 'OG', label: 'OG', emoji: '🕶️', chance: t.og, color: CONFIG.COLORS.OG,
      kind: 'role', roleId: CONFIG.ROLE_IDS.OG, mention: `<@&${CONFIG.ROLE_IDS.OG}>`,
    },
    {
      key: 'THREE_K', label: '3K', emoji: '💎', chance: t.threeK, color: CONFIG.COLORS.THREE_K,
      kind: 'role', roleId: CONFIG.ROLE_IDS.THREE_K, mention: `<@&${CONFIG.ROLE_IDS.THREE_K}>`,
    },
    {
      key: 'NINE_K', label: '9K', emoji: '🔱', chance: t.nineK, color: CONFIG.COLORS.NINE_K,
      kind: 'role', roleId: CONFIG.ROLE_IDS.NINE_K, mention: `<@&${CONFIG.ROLE_IDS.NINE_K}>`,
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
    weight: 69.2,
    flavor: 'Lo más habitual. La mayoría de las veces no guarda nada — pero "la mayoría" no es "siempre".',
    rewardTable: buildRewardTable({ arise: 0.15, king: 0.35, goat: 0.48, aura: 0.6, starX: 1.2, feathers: 6, featherMin: 8, featherMax: 15, nothing: 91.22 }),
  },
  BRASA: {
    key: 'BRASA',
    name: 'Cofre de Brasa',
    tierLabel: 'Raro',
    emoji: '🔥',
    color: CONFIG.COLORS.BRASA,
    weight: 25.5,
    flavor: 'Arde distinto. Las probabilidades de premio se cuadruplican frente a un cofre común.',
    rewardTable: buildRewardTable({ arise: 0.4, king: 0.9, goat: 1.2, aura: 1.6, starX: 3.2, feathers: 12, featherMin: 15, featherMax: 30, nothing: 80.7 }),
  },
  ABISMO: {
    key: 'ABISMO',
    name: 'Cofre del Abismo',
    tierLabel: 'Legendario',
    emoji: '🌑',
    color: CONFIG.COLORS.ABISMO,
    weight: 5,
    flavor: 'Casi nunca aparece. Sigue sin ser fácil — pero es lo más cerca que vas a estar de un rol legendario.',
    rewardTable: buildRewardTable({ arise: 1.2, king: 2.5, goat: 3.3, aura: 4.3, starX: 8.6, feathers: 25, featherMin: 30, featherMax: 60, nothing: 55.1 }),
  },
  OG: {
    key: 'OG',
    name: 'Cofre OG',
    tierLabel: 'Mítico',
    emoji: '🕶️',
    color: CONFIG.COLORS.OG_CHEST,
    weight: 0.3,
    flavor: 'No debería existir. Casi nadie lo ve aparecer en toda la vida del servidor — y ni así es fácil sacar algo de él.',
    rewardTable: buildOgRewardTable({ og: 0.3, threeK: 0.6, nineK: 1.0, feathers: 42, featherMin: 80, featherMax: 150, nothing: 56.1 }),
  },
};

const CHEST_TYPE_LIST = Object.values(CHEST_TYPES);

// ============================================================================
// PORTALES — evento de apuesta estilo "gate" (Solo Leveling). Cada 1h hay
// 50% de probabilidad de que se abra uno (ver PORTAL_CHECK_*). La gente
// apuesta Feathers para entrar: mientras más pone, más probabilidad tiene
// de ganar (es un sorteo ponderado por apuesta, no una pelea por rondas —
// así la probabilidad real siempre es exacta y auditable). El panel narra
// el "Boss del portal" eliminando contendientes, pero matemáticamente es
// un sorteo limpio de un solo paso.
//
// Reparto al cerrar: el ganador se lleva un % del pozo total, el resto se
// reparte entre TODOS los demás participantes (proporcional a lo que
// apostaron), y un % se retira de la economía (sink, para que las Feathers
// tengan riesgo real). Entre más raro el portal, más se lleva el ganador.
// ============================================================================

const PORTAL_TYPES = {
  RANGO_E: {
    key: 'RANGO_E',
    name: 'Portal Rango-E',
    rankLabel: 'Inestable',
    emoji: '🌀',
    color: CONFIG.COLORS.PORTAL_E,
    weight: 65,
    minStake: 20,
    flavor: 'Un portal débil, recién formado. El Boss que guarda no da mucha pelea — buena entrada para arriesgar poco.',
    payout: { winnerPct: 0.55, othersPct: 0.35, burnPct: 0.10 },
  },
  RANGO_B: {
    key: 'RANGO_B',
    name: 'Portal Rango-B',
    rankLabel: 'Cazador',
    emoji: '🌌',
    color: CONFIG.COLORS.PORTAL_B,
    weight: 28,
    minStake: 60,
    flavor: 'Ya se siente la presión del otro lado. El Boss elimina en serio — apostar acá es apostar de verdad.',
    payout: { winnerPct: 0.60, othersPct: 0.30, burnPct: 0.10 },
  },
  RANGO_S: {
    key: 'RANGO_S',
    name: 'Portal Rango-S',
    rankLabel: 'Monarca',
    emoji: '🔴',
    color: CONFIG.COLORS.PORTAL_S,
    weight: 7,
    minStake: 150,
    flavor: 'Casi nunca se abre uno así. Lo que guarda del otro lado es letal — pero quien sale, sale con casi todo.',
    payout: { winnerPct: 0.70, othersPct: 0.20, burnPct: 0.10 },
  },
};

const PORTAL_TYPE_LIST = Object.values(PORTAL_TYPES);

/** Elige un tipo de portal al azar según su peso, o fuerza uno si se pasa forcedKey. */
function pickPortalType(forcedKey = null) {
  if (forcedKey && PORTAL_TYPES[forcedKey]) return PORTAL_TYPES[forcedKey];
  const totalWeight = PORTAL_TYPE_LIST.reduce((sum, t) => sum + t.weight, 0);
  let roll = Math.random() * totalWeight;
  for (const type of PORTAL_TYPE_LIST) {
    roll -= type.weight;
    if (roll <= 0) return type;
  }
  return PORTAL_TYPE_LIST[0];
}

/** Elige al ganador con probabilidad proporcional a lo que apostó cada quien (sorteo ponderado). */
function pickWeightedPortalWinner(participants) {
  const totalStake = participants.reduce((sum, p) => sum + p.stake, 0);
  let roll = Math.random() * totalStake;
  for (const p of participants) {
    roll -= p.stake;
    if (roll <= 0) return p.userId;
  }
  return participants[participants.length - 1].userId;
}

/**
 * Calcula el reparto final de un portal ya cerrado. `participants` es
 * [{ userId, stake }]. Devuelve { winnerId, winnerAmount, othersPayouts,
 * burnedAmount, totalPot } — othersPayouts es [{ userId, amount }],
 * proporcional a la apuesta de cada quien (nunca incluye al ganador).
 */
function computePortalPayouts(portalType, participants) {
  const totalPot = participants.reduce((sum, p) => sum + p.stake, 0);
  const winnerId = pickWeightedPortalWinner(participants);
  const winnerAmount = Math.round(totalPot * portalType.payout.winnerPct);
  const burnedAmount = Math.round(totalPot * portalType.payout.burnPct);
  const othersPoolAmount = totalPot - winnerAmount - burnedAmount;

  const others = participants.filter((p) => p.userId !== winnerId);
  const othersStakeTotal = others.reduce((sum, p) => sum + p.stake, 0);
  const othersPayouts = others
    .map((p) => ({ userId: p.userId, amount: othersStakeTotal > 0 ? Math.round(othersPoolAmount * (p.stake / othersStakeTotal)) : 0 }))
    .filter((p) => p.amount > 0);

  return { winnerId, winnerAmount, othersPayouts, burnedAmount, totalPot };
}

// Cada 1h se tira una moneda: 50% de que se abra un portal (si no hay uno activo ya).
const PORTAL_CHECK_INTERVAL_MS = 60 * 60 * 1000;
const PORTAL_SPAWN_CHANCE = 0.5;
const PORTAL_JOIN_WINDOW_MS = 10 * 60 * 1000; // 10 minutos para apostar y entrar

// ============================================================================
// EVENTOS GLOBALES — buffs temporales de todo el servidor que el owner activa
// desde /panel-owner. Uno solo activo a la vez. Cada uno tiene un `weight`
// (se elige con la misma ruleta ponderada que un rol de cofre — ver
// pickEventType) y un `kind`+`value` que dice EXACTAMENTE qué modifica y
// cuánto; los multiplicadores son moderados (1.5x–2x, nunca más) y con
// tiempo límite (10–20 min) a propósito, para que la economía de roles
// nunca se rompa — un evento es un empujón, no un atajo.
// ============================================================================

const EVENT_TYPES = {
  DOUBLE_LUCK: {
    key: 'DOUBLE_LUCK', name: 'Suerte Ancestral', emoji: '🍀', color: 0x22c55e, weight: 16, durationMs: 15 * 60 * 1000,
    kind: 'luck_multiplier', value: 1.0, // mismo mecanismo que el Amuleto de Suerte (+50%), pero al doble (+100%)
    description: 'Las probabilidades de rol de TODOS los cofres suben +100% (se resta de "Nothing").',
  },
  FEATHER_RAIN: {
    key: 'FEATHER_RAIN', name: 'Lluvia de Plumas', emoji: FEATHER_EMOJI, color: 0xff9f43, weight: 14, durationMs: 15 * 60 * 1000,
    kind: 'feather_multiplier', value: 1.6,
    description: 'Todas las Feathers que se ganen (cofres, /daily, ingreso de rol) suben +60%.',
  },
  WEAK_VOID: {
    key: 'WEAK_VOID', name: 'Vacío Debilitado', emoji: '💨', color: 0x64748b, weight: 12, durationMs: 15 * 60 * 1000,
    kind: 'nothing_multiplier', value: 0.4, // recorta "Nothing" un 40%, repartido en el resto
    description: 'La probabilidad de "Nothing" en los cofres baja un 40% — no la elimina del todo, para eso está el Amuleto contra el Vacío.',
  },
  UNSTABLE_PORTALS: {
    key: 'UNSTABLE_PORTALS', name: 'Portales Inestables', emoji: '🌀', color: CONFIG.COLORS.PORTAL_E, weight: 9, durationMs: 20 * 60 * 1000,
    kind: 'portal_chance_multiplier', value: 2.0,
    description: 'Durante el evento, la probabilidad horaria de que se abra un portal se duplica.',
  },
  ABUNDANT_CHESTS: {
    key: 'ABUNDANT_CHESTS', name: 'Cofres Abundantes', emoji: '🩶', color: CONFIG.COLORS.CENIZA, weight: 12, durationMs: 15 * 60 * 1000,
    kind: 'spawn_step_multiplier', value: 0.5, // la mitad de mensajes necesarios por cada +1%
    description: 'La probabilidad de cofre sube al doble de rápido con cada mensaje del canal.',
  },
  ABYSS_OMEN: {
    key: 'ABYSS_OMEN', name: 'Presagio del Abismo', emoji: '🌑', color: CONFIG.COLORS.ABISMO, weight: 7, durationMs: 15 * 60 * 1000,
    kind: 'chest_weight_shift', value: { BRASA: 2.5, ABISMO: 4 },
    description: 'Los cofres de Brasa y del Abismo tienen muchas más probabilidades de aparecer que de costumbre.',
  },
  BLESSED_STREAK: {
    key: 'BLESSED_STREAK', name: 'Racha Bendecida', emoji: '🔥', color: CONFIG.COLORS.FEATHERS, weight: 10, durationMs: 20 * 60 * 1000,
    kind: 'daily_multiplier', value: 1.6,
    description: 'La recompensa de /daily sube +60% mientras dure.',
  },
  ROYAL_INCOME: {
    key: 'ROYAL_INCOME', name: 'Ingreso Real', emoji: '👑', color: CONFIG.COLORS.KING, weight: 8, durationMs: 20 * 60 * 1000,
    kind: 'role_income_multiplier', value: 1.6,
    description: 'El ingreso pasivo de /claim por tus roles sube +60%.',
  },
  MARKET_SALE: {
    key: 'MARKET_SALE', name: 'Mercado Generoso', emoji: '🛒', color: 0x0ea5e9, weight: 8, durationMs: 15 * 60 * 1000,
    kind: 'shop_discount', value: 0.75, // 25% de descuento
    description: 'Todo en /shop cuesta un 25% menos.',
  },
  GOLDEN_PORTAL: {
    key: 'GOLDEN_PORTAL', name: 'Portal Dorado', emoji: '🔴', color: CONFIG.COLORS.PORTAL_S, weight: 4, durationMs: 10 * 60 * 1000,
    kind: 'force_portal_rank', value: 'RANGO_S',
    description: 'Abre de inmediato un Portal Rango-S — el más raro y el que más reparte — si no hay uno activo ya.',
  },
};

const EVENT_TYPE_LIST = Object.values(EVENT_TYPES);

/** Elige un evento al azar según su peso (misma filosofía que pickPortalType/pickChestType), o fuerza uno si se pasa forcedKey. */
function pickEventType(forcedKey = null) {
  if (forcedKey && EVENT_TYPES[forcedKey]) return EVENT_TYPES[forcedKey];
  const totalWeight = EVENT_TYPE_LIST.reduce((sum, e) => sum + e.weight, 0);
  let roll = Math.random() * totalWeight;
  for (const type of EVENT_TYPE_LIST) {
    roll -= type.weight;
    if (roll <= 0) return type;
  }
  return EVENT_TYPE_LIST[0];
}

/**
 * Elige un tipo de cofre al azar según su peso, o fuerza uno si se pasa
 * forcedKey. `weightMultipliers` es opcional — ej. { BRASA: 2.5, ABISMO: 4 }
 * durante el evento "Presagio del Abismo" — y por defecto no cambia nada
 * (multiplicador implícito de 1), así que ningún llamador existente se ve
 * afectado si no lo pasa.
 */
function pickChestType(forcedKey = null, weightMultipliers = null) {
  if (forcedKey) {
    const forced = CHEST_TYPES[forcedKey.toUpperCase()];
    if (forced) return forced;
  }
  const effectiveWeight = (type) => type.weight * (weightMultipliers?.[type.key] || 1);
  const totalWeight = CHEST_TYPE_LIST.reduce((sum, t) => sum + effectiveWeight(t), 0);
  let roll = Math.random() * totalWeight;
  for (const type of CHEST_TYPE_LIST) {
    roll -= effectiveWeight(type);
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
    cost: 220,
    description: 'Objeto raro: te protege automáticamente si te toca caer en la **primera ronda** de tu próxima batalla. Se consume al usarse.',
  },
  CHARM: {
    key: 'CHARM',
    name: 'Amuleto de Suerte',
    emoji: '🍀',
    cost: 350,
    description: 'Objeto legendario: la próxima vez que abras un cofre, tus probabilidades de conseguir un **rol** suben un 50%. Se consume al usarse.',
  },
  REVIVE: {
    key: 'REVIVE',
    name: 'Pluma Fénix',
    emoji: '🪶',
    cost: 650,
    description: 'Objeto mítico: si te eliminan en una batalla, revives una única vez y sigues en juego hasta la siguiente ronda. Se consume al usarse, funcione o no.',
  },
  WARD: {
    key: 'WARD',
    name: 'Amuleto contra el Vacío',
    emoji: '🔮',
    cost: 750,
    description: 'Objeto mítico: garantiza que tu próximo cofre **no** te dé "Nothing" — vas a sacar algo sí o sí (rol o Feathers). Se consume al usarse.',
  },
  TIME_SKIP: {
    key: 'TIME_SKIP',
    name: 'Acelerador Temporal',
    emoji: '⏩',
    cost: 500,
    description: 'Objeto raro: la próxima vez que uses `/claim`, completa al instante TODO el ingreso pasivo de rol que tengas pendiente, sin esperar el tiempo restante. Se consume al usarse.',
  },
};

// Techo explícito e intencional (no una casualidad): 5 objetos como mucho,
// para que siempre quepan en una sola fila de botones de Discord (máximo 5
// por fila) y la tienda no se vuelva inabarcable. Si en algún momento se
// agrega un sexto objeto por error, esto lo avisa fuerte en el arranque en
// vez de dejar un botón silenciosamente sin espacio.
const SHOP_MAX_ITEMS = 5;
if (Object.keys(SHOP_ITEMS).length > SHOP_MAX_ITEMS) {
  throw new Error(`[Xerion] La tienda tiene ${Object.keys(SHOP_ITEMS).length} objetos — el máximo permitido es ${SHOP_MAX_ITEMS}.`);
}

// ============================================================================
// RNG — minijuego estilo "Roblox RNG": tirar (`/roll`), vender lo que salga
// por Fragmentos (`/sell`) y canjear Fragmentos por Feathers (`/redeem`).
// A propósito solo 3 comandos (el techo que se pidió). Extremadamente
// difícil a propósito: el tramo top ("Secreto") es 1 en 10.000 tiradas.
// Balance: el valor esperado en Fragmentos de una tirada, convertido a
// Feathers, es MENOR al costo de tirar — como cualquier gacha real, es un
// sumidero de Feathers, no una máquina de imprimir. Ver RNG_ROLL_COST y
// RNG_FRAGMENT_TO_FEATHERS más abajo.
// ============================================================================

const RNG_ROLL_COST = 15; // Feathers por tirada
const RNG_FRAGMENT_TO_FEATHERS = 0.5; // cuánto vale 1 Fragmento al canjear

const RNG_ITEMS = {
  COMUN: { key: 'COMUN', name: 'Chatarra Encantada', tier: 'Común', emoji: '⚙️', color: CONFIG.COLORS.RNG_COMUN, weight: 55, fragments: 2 },
  POCO_COMUN: { key: 'POCO_COMUN', name: 'Reliquia Menor', tier: 'Poco Común', emoji: '🔧', color: CONFIG.COLORS.RNG_POCO_COMUN, weight: 26, fragments: 6 },
  RARO: { key: 'RARO', name: 'Reliquia Rara', tier: 'Raro', emoji: '🔷', color: CONFIG.COLORS.RNG_RARO, weight: 12.5, fragments: 18 },
  EPICO: { key: 'EPICO', name: 'Artefacto Épico', tier: 'Épico', emoji: '🟣', color: CONFIG.COLORS.RNG_EPICO, weight: 5, fragments: 60 },
  LEGENDARIO: { key: 'LEGENDARIO', name: 'Artefacto Legendario', tier: 'Legendario', emoji: '🟠', color: CONFIG.COLORS.RNG_LEGENDARIO, weight: 1.3, fragments: 250 },
  MITICO: { key: 'MITICO', name: 'Núcleo Mítico', tier: 'Mítico', emoji: '🔴', color: CONFIG.COLORS.RNG_MITICO, weight: 0.19, fragments: 1200 },
  SECRETO: { key: 'SECRETO', name: 'Fragmento Divino', tier: 'Secreto', emoji: '✨', color: CONFIG.COLORS.RNG_SECRETO, weight: 0.01, fragments: 8000 },
};

const RNG_ITEM_LIST = Object.values(RNG_ITEMS);

/** Elige un objeto de RNG al azar según su peso — misma filosofía que pickChestType/pickPortalType/pickEventType. */
function pickRngItem() {
  const totalWeight = RNG_ITEM_LIST.reduce((sum, item) => sum + item.weight, 0);
  let roll = Math.random() * totalWeight;
  for (const item of RNG_ITEM_LIST) {
    roll -= item.weight;
    if (roll <= 0) return item;
  }
  return RNG_ITEM_LIST[0];
}

// ============================================================================
// PROBABILIDAD DINÁMICA — funciones puras, fáciles de testear.
// ============================================================================

/** `stepMessages` es opcional (default CONFIG.PROBABILITY_STEP_MESSAGES) — el evento "Cofres Abundantes" lo pasa reducido para que suba más rápido. */
function computeSpawnChance(messagesSinceChest, stepMessages = CONFIG.PROBABILITY_STEP_MESSAGES) {
  const steps = Math.floor(messagesSinceChest / stepMessages);
  const chance = CONFIG.BASE_SPAWN_CHANCE + steps * CONFIG.PROBABILITY_STEP_INCREASE;
  return Math.min(chance, CONFIG.MAX_SPAWN_CHANCE);
}

function messagesUntilNextIncrease(messagesSinceChest, stepMessages = CONFIG.PROBABILITY_STEP_MESSAGES) {
  const remainder = messagesSinceChest % stepMessages;
  return remainder === 0 ? stepMessages : stepMessages - remainder;
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

/**
 * Sube las probabilidades de rol un `factor` (0.5 = +50%, default — el
 * Amuleto de Suerte de la tienda sigue pidiendo exactamente esto sin
 * cambiar nada), restando esa diferencia de "Nothing" (la suma sigue siendo
 * 100). El evento "Suerte Ancestral" llama a esto mismo con factor 1.0.
 */
function applyLuckBoost(table, factor = 0.5) {
  const boosted = table.map((r) => ({ ...r }));
  let delta = 0;
  for (const r of boosted) {
    if (r.kind === 'role') {
      const increase = r.chance * factor;
      r.chance += increase;
      delta += increase;
    }
  }
  const nothing = boosted.find((r) => r.key === 'NOTHING');
  if (nothing) nothing.chance = Math.max(0, nothing.chance - delta);
  return boosted;
}

/**
 * Versión "suave" del Amuleto contra el Vacío para el evento "Vacío
 * Debilitado": en vez de eliminar "Nothing" por completo, la recorta un
 * `factor` (0.4 = -40%) y reparte lo liberado proporcionalmente entre todo
 * lo demás — misma mecánica de redistribución que applyVoidWard, pero
 * parcial en vez de total, así que el evento sigue siendo más débil que
 * gastar un objeto de la tienda.
 */
function applyPartialVoidReduction(table, factor) {
  const reduced = table.map((r) => ({ ...r }));
  const nothing = reduced.find((r) => r.key === 'NOTHING');
  if (!nothing || nothing.chance <= 0 || !factor) return reduced;
  const freedChance = nothing.chance * factor;
  nothing.chance -= freedChance;
  const others = reduced.filter((r) => r.key !== 'NOTHING');
  const othersTotal = others.reduce((sum, r) => sum + r.chance, 0);
  if (othersTotal <= 0) return reduced;
  for (const r of others) {
    r.chance += freedChance * (r.chance / othersTotal);
  }
  return reduced;
}

/** Garantiza que la tirada no caiga en "Nothing" — reparte su probabilidad proporcionalmente entre todo lo demás. */
function applyVoidWard(table) {
  const warded = table.map((r) => ({ ...r }));
  const nothing = warded.find((r) => r.key === 'NOTHING');
  if (!nothing || nothing.chance <= 0) return warded;
  const freedChance = nothing.chance;
  nothing.chance = 0;
  const others = warded.filter((r) => r.key !== 'NOTHING');
  const othersTotal = others.reduce((sum, r) => sum + r.chance, 0);
  if (othersTotal <= 0) return warded;
  for (const r of others) {
    r.chance += freedChance * (r.chance / othersTotal);
  }
  return warded;
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

// ============================================================================
// BENEFICIOS DE ROL — entre más raro el rol que tienes, mejor el beneficio.
// Se aplica como un bonus permanente al ganar Feathers (cofre o daily),
// usando SOLO el rol más raro que tengas (no se acumulan varios a la vez).
//
// IMPORTANTE: todo acá se calcula con `heldRoleKeys` — la lista de roles que
// el usuario tiene EN DISCORD en este momento (la arma game.js leyendo
// member.roles.cache, siempre fresco, nunca desde la base de datos). Si le
// quitan un rol, pierde el beneficio al instante — los contadores de la
// base de datos (arise_count, etc.) son solo historial de cuántas veces lo
// ganó, y ya no determinan ningún beneficio por sí solos.
// ============================================================================

const ROLE_FEATHER_BONUS = {
  OG: 0.35,
  THREE_K: 0.28,
  ARISE: 0.25,
  NINE_K: 0.2,
  KING: 0.18,
  GOAT: 0.12,
  AURA_INFINITE: 0.06,
  STAR_X: 0.02,
};

const ROLE_RARITY_ORDER = ['OG', 'THREE_K', 'ARISE', 'NINE_K', 'KING', 'GOAT', 'AURA_INFINITE', 'STAR_X']; // de más raro a más común

/** Recibe la lista de roles que el usuario tiene AHORA (ej. ['KING','STAR_X']) y devuelve su multiplicador de Feathers. */
function featherBonusMultiplier(heldRoleKeys = []) {
  const held = highestRoleKey(heldRoleKeys);
  return held ? 1 + ROLE_FEATHER_BONUS[held] : 1;
}

/** El más raro de los roles que el usuario tiene AHORA (o null si no tiene ninguno de los 5), para mostrar en paneles. */
function highestRoleKey(heldRoleKeys = []) {
  return ROLE_RARITY_ORDER.find((key) => heldRoleKeys.includes(key)) || null;
}

// ============================================================================
// LOGROS — se definen UNA sola vez acá para que el panel de /achievements y
// el bonus de Feathers usen exactamente los mismos criterios (nunca se
// desalinean). Más difíciles que antes, y cada uno desbloqueado suma un
// bonus pequeño y permanente — no cambia mucho por sí solo, pero se nota
// si vas completando varios.
//
// Los logros de "obtén tal rol" también dependen de tenerlo AHORA (mismo
// criterio que los beneficios) — si te lo quitan, ese logro se marca como
// no completado hasta que lo vuelvas a tener.
// ============================================================================

const ACHIEVEMENTS = [
  { key: 'first_jump', name: 'Primer salto', description: 'Participa en tu primer cofre.', check: (s) => (s.chests_participated || 0) >= 1 },
  { key: 'first_win', name: 'Último superviviente', description: 'Gana tu primer cofre.', check: (s) => (s.chests_won || 0) >= 1 },
  { key: 'unstoppable', name: 'Imparable', description: 'Gana 25 cofres.', check: (s) => (s.chests_won || 0) >= 25 },
  { key: 'veteran', name: 'Veterano de Xerion', description: 'Gana 75 cofres.', check: (s) => (s.chests_won || 0) >= 75 },
  { key: 'steel_feathers', name: 'Plumaje de acero', description: 'Consigue 1,000 Feathers en total.', check: (s) => (s.total_feathers_earned || 0) >= 1000 },
  { key: 'feather_fortune', name: 'Fortuna emplumada', description: 'Consigue 10,000 Feathers en total.', check: (s) => (s.total_feathers_earned || 0) >= 10000 },
  { key: 'first_star', name: 'Primera estrella', description: 'Ten el rol STAR X.', check: (s, held = []) => held.includes('STAR_X') },
  { key: 'aura_awakened', name: 'Aura despertada', description: 'Ten el rol AURA INFINITE.', check: (s, held = []) => held.includes('AURA_INFINITE') },
  { key: 'crown', name: 'Corona de Xerion', description: 'Ten el rol KING.', check: (s, held = []) => held.includes('KING') },
  { key: 'supreme_goat', name: 'Cabra suprema', description: 'Ten el rol GOAT.', check: (s, held = []) => held.includes('GOAT') },
  { key: 'the_one_who_returns', name: 'El que regresa', description: 'Ten el rol ARISE.', check: (s, held = []) => held.includes('ARISE') },
  {
    key: 'collector',
    name: 'Coleccionista',
    description: 'Ten los 5 roles de cofre a la vez.',
    check: (s, held = []) => ['ARISE', 'KING', 'GOAT', 'AURA_INFINITE', 'STAR_X'].every((k) => held.includes(k)),
  },
  { key: 'nine_k_holder', name: '9K de verdad', description: 'Ten el rol 9K (exclusivo del Cofre OG).', check: (s, held = []) => held.includes('NINE_K') },
  { key: 'three_k_holder', name: '3K legítimo', description: 'Ten el rol 3K (exclusivo del Cofre OG).', check: (s, held = []) => held.includes('THREE_K') },
  { key: 'og_holder', name: 'Original', description: 'Ten el rol OG (exclusivo del Cofre OG).', check: (s, held = []) => held.includes('OG') },
  {
    key: 'og_collector',
    name: 'La Triple Corona',
    description: 'Ten los 3 roles del Cofre OG (9K, 3K y OG) a la vez.',
    check: (s, held = []) => ['NINE_K', 'THREE_K', 'OG'].every((k) => held.includes(k)),
  },
  { key: 'streak_week', name: 'Constancia de hierro', description: 'Llega a una racha de 7 días en /daily.', check: (s) => (s.best_streak || 0) >= 7 },
  { key: 'streak_month', name: 'Disciplina absoluta', description: 'Llega a una racha de 30 días en /daily.', check: (s) => (s.best_streak || 0) >= 30 },
];

const ACHIEVEMENT_BONUS_PER_UNLOCK = 0.005; // +0.5% Feathers por logro desbloqueado
const ACHIEVEMENT_BONUS_CAP = 0.05; // tope de +5% (10 logros de 18)

function countCompletedAchievements(stats = {}, heldRoleKeys = []) {
  return ACHIEVEMENTS.reduce((n, a) => n + (a.check(stats, heldRoleKeys) ? 1 : 0), 0);
}

/** Extra a SUMAR sobre featherBonusMultiplier (no incluye el 1.0 base). */
function achievementBonusMultiplier(stats = {}, heldRoleKeys = []) {
  return Math.min(countCompletedAchievements(stats, heldRoleKeys) * ACHIEVEMENT_BONUS_PER_UNLOCK, ACHIEVEMENT_BONUS_CAP);
}

/** Multiplicador total de Feathers: bonus de rol (según lo que tengas AHORA) + bonus de logros, ya combinados. */
function totalFeatherMultiplier(heldRoleKeys = [], stats = {}) {
  return featherBonusMultiplier(heldRoleKeys) + achievementBonusMultiplier(stats, heldRoleKeys);
}

// ============================================================================
// INGRESO PASIVO POR ROL — cada rol que tengas AHORA te da Feathers cada
// cierto tiempo (mínimo 3h). Entre más raro el rol, más Feathers da Y más
// tiempo hay que esperar entre cobro y cobro. Se reclama todo junto con
// /claim — y si en algún momento pierdes el rol, deja de generar ingreso
// (aunque conservás lo que ya hayas cobrado, claro).
// ============================================================================

const ROLE_PASSIVE_INCOME = {
  STAR_X: { intervalMs: 3 * 60 * 60 * 1000, amount: 4 },
  AURA_INFINITE: { intervalMs: 10 * 60 * 60 * 1000, amount: 15 },
  GOAT: { intervalMs: 20 * 60 * 60 * 1000, amount: 40 },
  KING: { intervalMs: 48 * 60 * 60 * 1000, amount: 100 },
  NINE_K: { intervalMs: 60 * 60 * 60 * 1000, amount: 130 },
  ARISE: { intervalMs: 72 * 60 * 60 * 1000, amount: 160 },
  THREE_K: { intervalMs: 90 * 60 * 60 * 1000, amount: 220 },
  OG: { intervalMs: 120 * 60 * 60 * 1000, amount: 320 },
};
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
  'Si nadie reclama un cofre en 5 minutos, el bot re-sortea otro ganador automáticamente — no hace falta que hagas nada.',
  'Cada rol que tengas te da Feathers pasivas cada cierto tiempo, solo por tenerlo — revisa `/claim` para cobrarlas.',
  'Tu racha de `/daily` se puede mostrar en tu apodo — revisa `/streak` para activarla o desactivarla.',
  'Un Escudo de `/shop` te protege automáticamente en la primera ronda de tu próxima batalla.',
  'La Pluma Fénix es cara, pero te revive una vez si te eliminan — puede ser tu única oportunidad de seguir en juego.',
  'Con `/rates` puedes ver exactamente qué tan difícil es cada tipo de cofre antes de arriesgarte.',
  'El Cofre del Abismo es rarísimo, pero cuadruplica tus probabilidades de rol frente al Cofre de Ceniza.',
  'No te saltes tu `/daily`: dejar pasar más de un día reinicia tu racha desde cero.',
  'Un Amuleto de Suerte sube un 50% tus probabilidades de conseguir un rol en tu próxima apertura.',
  'Entre más raro el rol que tengas, más Feathers ganas — ARISE da hasta un 25% extra en cada premio.',
  'Con `/portals` puedes ver los 3 rangos de portal y cuánto reparte cada uno antes de apostar tus Feathers.',
  'Usa `/event` para ver si hay un evento global activo ahora mismo — mientras dure, afecta a todo el servidor.',
  'Mientras más Feathers apuestes en un portal, más probabilidad real tienes de ganarlo — es un sorteo ponderado, no suerte pura.',
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
  SHOP_ITEMS,
  SHOP_MAX_ITEMS,
  RNG_ITEMS,
  RNG_ITEM_LIST,
  pickRngItem,
  RNG_ROLL_COST,
  RNG_FRAGMENT_TO_FEATHERS,
  computeSpawnChance,
  messagesUntilNextIncrease,
  rollReward,
  applyLuckBoost,
  applyPartialVoidReduction,
  applyVoidWard,
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
  ROLE_FEATHER_BONUS,
  featherBonusMultiplier,
  highestRoleKey,
  ROLE_PASSIVE_INCOME,
  ACHIEVEMENTS,
  countCompletedAchievements,
  achievementBonusMultiplier,
  totalFeatherMultiplier,
};
