'use strict';

// ============================================================
//  CONFIGURACIÓN GENERAL — Bot de Economía de Halloween (Xn)
//  v1.0.0 Halloween Release — RPG + RNG + Economy, 50 comandos.
//  Todos los números de esta economía viven aquí. Ajusta con
//  confianza: nada del resto del código depende de valores
//  "mágicos" fuera de este archivo.
// ============================================================

module.exports = {
  BOT_VERSION: '1.0.0',

  // --- Prefijo (se detecta sin importar mayúsculas: Xn, xn, xN, XN) ---
  PREFIX: 'xn',

  // --- Único usuario que puede usar comandos de administración ---
  // (no depende de permisos del servidor, es SOLO este ID)
  OWNER_ID: '1064678074010058752',

  // --- Moneda ---
  CANDY_EMOJI: '🍬',
  CANDY_NAME: 'Candys',

  // --- Colores para los Containers de Components V2 ---
  COLORS: {
    DEFAULT: 0xFF7518, // naranja calabaza
    SUCCESS: 0x57F287, // verde — usar SIEMPRE que el usuario gane algo
    ERROR: 0xED4245,   // rojo — usar SIEMPRE que el usuario pierda algo
    DEBT: 0x9B59B6,
    GOLD: 0xF1C40F,
    DARK: 0x2C2F33,
  },

  // --- Ganancia pasiva por mensaje ---
  MESSAGE_COOLDOWN_MS: 3 * 1000, // bajado de 10s a 3s
  MESSAGE_REWARD: 1,

  // --- Límite duro de la economía: ninguna acción normal da más que esto ---
  MAX_SINGLE_GAIN: 3000,

  // --- Banco ---
  BANK_FEE_MIN: 0.02,
  BANK_FEE_MAX: 0.10,

  // --- Deuda ---
  DEBT_REFUND_MIN: 0,
  DEBT_REFUND_MAX: 0.05,

  // --- Cooldowns de comandos (ms) ---
  COOLDOWNS: {
    work: 30 * 60 * 1000,
    crime: 30 * 60 * 1000,
    beg: 10 * 60 * 1000,
    rob: 10 * 60 * 1000,
    trickortreat: 24 * 60 * 60 * 1000,
    hunt: 15 * 60 * 1000,
    duel: 15 * 60 * 1000,
    dungeon: 60 * 60 * 1000,
    boss: 3 * 60 * 60 * 1000,
    quest: 12 * 60 * 60 * 1000,
    daily: 24 * 60 * 60 * 1000,
    class: 0, // Las clases se eligen una vez y quedan permanentes.
    bounty: 30 * 60 * 1000,
    scavenge: 15 * 60 * 1000,
    candyraid: 30 * 60 * 1000,
    roulette: 10 * 60 * 1000,
    wheel: 10 * 60 * 1000,
    harvest: 15 * 60 * 1000,
    collect: 24 * 60 * 60 * 1000,
  },

  // Enfriamiento corto entre usos y descanso largo al completar el ciclo.
  // El descanso largo se aplica DESPUÉS del último uso del ciclo.
  COOLDOWN_POLICIES: {
    work: { intervalMs: 5 * 60 * 1000, uses: 10, restMs: 30 * 60 * 1000 },
    crime: { intervalMs: 20 * 60 * 1000, uses: 3, restMs: 30 * 60 * 1000 },
    beg: { intervalMs: 2 * 60 * 1000, uses: 10, restMs: 10 * 60 * 1000 },
    rob: { intervalMs: 10 * 60 * 1000, uses: 3, restMs: 10 * 60 * 1000 },
    hunt: { intervalMs: 10 * 60 * 1000, uses: 5, restMs: 15 * 60 * 1000 },
    scavenge: { intervalMs: 5 * 60 * 1000, uses: 5, restMs: 15 * 60 * 1000 },
    candyraid: { intervalMs: 10 * 60 * 1000, uses: 3, restMs: 30 * 60 * 1000 },
    roulette: { intervalMs: 5 * 60 * 1000, uses: 5, restMs: 10 * 60 * 1000 },
    wheel: { intervalMs: 5 * 60 * 1000, uses: 5, restMs: 10 * 60 * 1000 },
    harvest: { intervalMs: 3 * 60 * 1000, uses: 5, restMs: 15 * 60 * 1000 },
  },

  // --- work ---
  WORK_MIN: 100,
  WORK_MAX: 900,

  // --- beg ---
  BEG_MIN: 1,
  BEG_MAX: 150,
  BEG_FAIL_CHANCE: 0.10,

  // --- nuevos comandos de búsqueda de dulces ---
  SCAVENGE_REWARD_MIN: 75,
  SCAVENGE_REWARD_MAX: 300,
  HARVEST_REWARD_MIN: 100,
  HARVEST_REWARD_MAX: 650,
  CANDYRAID_SUCCESS_CHANCE: 0.70,
  CANDYRAID_REWARD_MIN: 250,
  CANDYRAID_REWARD_MAX: 900,
  CANDYRAID_FAIL_DEBT_MIN: 50,
  CANDYRAID_FAIL_DEBT_MAX: 200,

  // --- crime ---
  CRIME_SUCCESS_CHANCE: 0.50,
  CRIME_REWARD_MIN: 200,
  CRIME_REWARD_MAX: 3000,
  CRIME_DEBT_MIN: 300,
  CRIME_DEBT_MAX: 1800,

  // --- trickortreat ---
  TOT_TREAT_CHANCE: 0.70,
  TOT_TREAT_MIN: 200,
  TOT_TREAT_MAX: 1500,
  TOT_TRICK_DEBT_MIN: 100,
  TOT_TRICK_DEBT_MAX: 500,

  // --- rob ---
  ROB_SUCCESS_CHANCE: 0.45,
  ROB_STEAL_PCT_MIN: 0.10,
  ROB_STEAL_PCT_MAX: 0.35,
  ROB_FAIL_DEBT_MIN: 500,
  ROB_FAIL_DEBT_MAX: 2000,
  ROB_PROTECTION_MS: 5 * 60 * 1000, // tras ser robado, 5 min de gracia
  ROB_MIN_TARGET_CASH: 100, // no se puede robar a quien tiene menos que esto en Cash

  // --- bounty (recompensa por cabeza) ---
  BOUNTY_MIN: 100,
  // el bounty NO cuenta contra MAX_SINGLE_GAIN: es dinero que otro jugador
  // ya puso de su bolsillo, no es economía "creada de la nada"

  // --- RPG: cacería (hunt) ---
  HUNT_SUCCESS_CHANCE: 0.60,
  HUNT_REWARD_MIN: 120,
  HUNT_REWARD_MAX: 500,
  MONSTERS: [
    { name: 'un Fantasma Errante', emoji: '👻' },
    { name: 'una Momia Vendada', emoji: '🧟' },
    { name: 'un Murciélago Gigante', emoji: '🦇' },
    { name: 'una Araña Embrujada', emoji: '🕷️' },
    { name: 'un Espantapájaros Poseído', emoji: '🎃' },
    { name: 'un Duende Travieso', emoji: '🧌' },
  ],

  // --- RPG: duelo (duel) ---
  DUEL_TIMEOUT_MS: 60 * 1000,
  DUEL_BASE_CHANCE: 0.5,

  // --- RPG: mazmorra (dungeon) ---
  DUNGEON_SUCCESS_CHANCE: 0.55,
  DUNGEON_REWARD_MIN: 400,
  DUNGEON_REWARD_MAX: 1200,
  DUNGEON_DEBT_MIN: 400,
  DUNGEON_DEBT_MAX: 1200,

  // --- RPG: jefe (boss) ---
  BOSS_SUCCESS_CHANCE: 0.35,
  BOSS_REWARD_MIN: 900,
  BOSS_REWARD_MAX: 3000,
  BOSS_DEBT_MIN: 900,
  BOSS_DEBT_MAX: 2200,
  BOSS_NAME: 'La Calabaza Ancestral',
  BOSS_EMOJI: '🎃',

  // --- RPG: misión diaria (quest) ---
  QUEST_REWARD_MIN: 250,
  QUEST_REWARD_MAX: 600,
  QUEST_BONUS_CHANCE: 0.15,
  QUEST_BONUS_MIN: 50,
  QUEST_BONUS_MAX: 200,

  // --- daily ---
  DAILY_REWARD_MIN: 300,
  DAILY_REWARD_MAX: 700,
  // El último día completo del evento (día anterior al fin exclusivo, en UTC),
  // el daily entrega este monto fijo como agradecimiento por el evento.
  DAILY_EVENT_FINALE_BONUS: 50000,

  // --- RPG: experiencia y nivel ---
  XP_PER_ACTION: {
    work: 4, crime: 6, hunt: 6, dungeon: 15, boss: 30, duel: 8, quest: 10, rob: 5,
    scavenge: 3, candyraid: 8, harvest: 4,
  },

  // --- RPG: clases permanentes (se eligen una vez al llegar al nivel 5) ---
  CLASSES: [
    {
      id: 'bruja', name: 'Bruja', emoji: '🧙‍♀️',
      desc: '+8% de éxito y +5% de recompensa en `crime`; +5% en `quest`.', bonus: { crimeChance: 0.08, crimeReward: 0.05, questReward: 0.05 },
    },
    {
      id: 'vampiro', name: 'Vampiro', emoji: '🧛',
      desc: '+15% de Candys robados en `rob` exitoso.', bonus: { robAmount: 0.15 },
    },
    {
      id: 'hombrelobo', name: 'Hombre Lobo', emoji: '🐺',
      desc: '+15% de recompensa en `hunt` y +5% de éxito cazando.', bonus: { huntReward: 0.15, huntChance: 0.05 },
    },
    {
      id: 'cazador', name: 'Cazador', emoji: '🏹',
      desc: '+8% de éxito al usar `rob` y +5% de recompensa en `work`.', bonus: { robChance: 0.08, workReward: 0.05 },
    },
    {
      id: 'fantasma', name: 'Fantasma', emoji: '👻',
      desc: '-30% de comisión al usar `withdraw` y +5% de recompensa en `beg`.', bonus: { bankFee: 0.30, begReward: 0.05 },
    },
  ],

  // --- RPG: beneficios permanentes por hitos de nivel ---
  LEVEL_BONUSES: [
    { level: 5, label: '+5% de recompensa en work', bonus: { workReward: 0.05 } },
    { level: 10, label: '+5% de recompensa en hunt', bonus: { huntReward: 0.05 } },
    { level: 15, label: '+3% de éxito en crime', bonus: { crimeChance: 0.03 } },
    { level: 20, label: '+5% de recompensa en quest', bonus: { questReward: 0.05 } },
    { level: 25, label: '+5% de recompensa en beg', bonus: { begReward: 0.05 } },
    { level: 30, label: '+5% de recompensa en casino', bonus: { casinoPayout: 0.05 } },
  ],

  // --- RPG: armería (10 armas permanentes; se puede equipar una a la vez) ---
  WEAPONS: [
    {
      id: 'rama', name: 'Rama Afilada', emoji: '🪵', price: 8000,
      desc: '+5% de recompensa en `hunt`.', bonus: { huntReward: 0.05 },
    },
    {
      id: 'daga', name: 'Daga de Plata', emoji: '🗡️', price: 25000,
      desc: '+10% de éxito en `duel`.', bonus: { duelChance: 0.10 },
    },
    {
      id: 'guadana', name: 'Guadaña Maldita', emoji: '⚔️', price: 70000,
      desc: '+15% de recompensa en `hunt`.', bonus: { huntReward: 0.15 },
    },
    {
      id: 'vara', name: 'Vara de la Bruja', emoji: '🪄', price: 140000,
      desc: '+10% de éxito en `duel` y +8% de recompensa en `hunt`.', bonus: { duelChance: 0.10, huntReward: 0.08 },
    },
    {
      id: 'farol', name: 'Farol del Sepulturero', emoji: '🏮', price: 220000,
      desc: '+10% de recompensa en `work` y +5% de recompensa en `quest`.', bonus: { workReward: 0.10, questReward: 0.05 },
    },
    {
      id: 'arco', name: 'Arco de Hueso', emoji: '🏹', price: 360000,
      desc: '+12% de éxito y +8% de recompensa en `hunt`.', bonus: { huntChance: 0.12, huntReward: 0.08 },
    },
    {
      id: 'grimorio', name: 'Grimorio Carmesí', emoji: '📕', price: 520000,
      desc: '+8% de éxito en `crime` y +8% de recompensa en `beg`.', bonus: { crimeChance: 0.08, begReward: 0.08 },
    },
    {
      id: 'escudo', name: 'Escudo de la Cripta', emoji: '🛡️', price: 780000,
      desc: 'Reduce un 10% la deuda de `crime`, `dungeon` y `boss`.', bonus: { debtReduction: 0.10 },
    },
    {
      id: 'reloj', name: 'Reloj de Medianoche', emoji: '⌛', price: 1150000,
      desc: '+5% de éxito en `duel` y reduce 5% los cooldowns de `work` y `hunt`.', bonus: { duelChance: 0.05, cooldownReduction: 0.05 },
    },
    {
      id: 'reliquia', name: 'Reliquia de la Luna', emoji: '🌙', price: 1750000,
      desc: '+10% de recompensa en `quest` y +5% de premio en el casino.', bonus: { questReward: 0.10, casinoPayout: 0.05 },
    },
  ],

  // --- RPG: logros (se calculan en vivo a partir de las estadísticas) ---
  ACHIEVEMENTS: [
    { id: 'primeros_pasos', name: 'Primeros Pasos', emoji: '👣', desc: 'Trabaja por primera vez. Beneficio permanente: +2% en work.', source: 'stats', key: 'totalWorked', threshold: 1, bonus: { workReward: 0.02 } },
    { id: 'ladron_novato', name: 'Ladrón Novato', emoji: '🥷', desc: 'Gana tu primer robo. Beneficio permanente: +2% de éxito en rob.', source: 'stats', key: 'robWins', threshold: 1, bonus: { robChance: 0.02 } },
    { id: 'ladron_maestro', name: 'Ladrón Maestro', emoji: '🎭', desc: 'Gana 25 robos. Beneficio permanente: +3% de Candys robados.', source: 'stats', key: 'robWins', threshold: 25, bonus: { robAmount: 0.03 } },
    { id: 'cazador_sombras', name: 'Cazador de Sombras', emoji: '🏹', desc: 'Gana tu primera cacería. Beneficio permanente: +3% en hunt.', source: 'stats', key: 'huntWins', threshold: 1, bonus: { huntReward: 0.03 } },
    { id: 'explorador', name: 'Explorador Valiente', emoji: '🗺️', desc: 'Completa tu primera mazmorra.', source: 'stats', key: 'dungeonClears', threshold: 1 },
    { id: 'verdugo', name: 'Verdugo de Jefes', emoji: '💀', desc: 'Derrota a La Calabaza Ancestral. Beneficio permanente: +2% de recompensa en quest.', source: 'stats', key: 'bossWins', threshold: 1, bonus: { questReward: 0.02 } },
    { id: 'duelista', name: 'Duelista', emoji: '⚔️', desc: 'Gana tu primer duelo. Beneficio permanente: +2% de éxito en duel.', source: 'stats', key: 'duelWins', threshold: 1, bonus: { duelChance: 0.02 } },
    { id: 'apostador', name: 'Apostador Empedernido', emoji: '🎰', desc: 'Gana 10 veces en el casino. Beneficio permanente: +2% de premio en casino.', source: 'stats', key: 'casinoWins', threshold: 10, bonus: { casinoPayout: 0.02 } },
    { id: 'millonario', name: 'Millonario Embrujado', emoji: '💰', desc: 'Alcanza 1,000,000 de Candys en Total.', source: 'total', threshold: 1000000 },
    { id: 'leyenda', name: 'Leyenda de Halloween', emoji: '🏆', desc: 'Alcanza el nivel 10.', source: 'level', threshold: 10 },
  ],

  // --- Casino (Spooky Gamble) ---
  MAX_BET: 3000,
  GAMBLE_WIN_CHANCE: 0.47,
  SLOTS_SYMBOLS: [
    { symbol: '🎃', weight: 30 },
    { symbol: '👻', weight: 25 },
    { symbol: '🦇', weight: 20 },
    { symbol: '🕷️', weight: 15 },
    { symbol: '💀', weight: 7 },
    { symbol: '🌕', weight: 3 },
  ],
  SLOTS_RARE_SYMBOLS: ['💀', '🌕'],
  SLOTS_TRIPLE_RARE_MULT: 10,
  SLOTS_TRIPLE_MULT: 3,
  SLOTS_DOUBLE_MULT: 1,
  BLACKJACK_TIMEOUT_MS: 90 * 1000,

  // --- Casino: dados ---
  DICE_PAYOUT_MULT: 5, // acertar el número exacto (1-6) paga 5x

  // --- Casino: ruleta embrujada (más colores, cada uno con su multiplicador) ---
  ROULETTE_MIN_BET: 100,
  WHEEL_MIN_BET: 100,
  ROULETTE_COLORS: [
    { id: 'rojo', label: '🔴 Rojo', weight: 35, mult: 2 },
    { id: 'negro', label: '⚫ Negro', weight: 35, mult: 2 },
    { id: 'morado', label: '🟣 Morado', weight: 15, mult: 3 },
    { id: 'verde', label: '🟢 Verde', weight: 8, mult: 5 },
    { id: 'calabaza', label: '🎃 Calabaza', weight: 7, mult: 0 },
  ],

  // --- Casino: rueda de la fortuna ---
  WHEEL_SEGMENTS: [
    { mult: 0, weight: 15 },
    { mult: 0.5, weight: 25 },
    { mult: 1, weight: 25 },
    { mult: 1.5, weight: 18 },
    { mult: 2, weight: 12 },
    { mult: 3, weight: 5 },
  ],

  // --- Pociones — Tienda normal de Halloween (9 pociones) ---
  POTIONS: [
    {
      id: 'luck', name: 'Poción de la Suerte Maldita', emoji: '🍀',
      price: 45000, durationMs: 15 * 60 * 1000, maxStacks: 3, perStack: 0.10,
      description: 'Aumenta un **10%** tu éxito en `rob` y `crime` por carga (máx. 3 cargas).',
    },
    {
      id: 'shadow', name: 'Poción de las Sombras', emoji: '🕵️',
      price: 70000, durationMs: 10 * 60 * 1000, maxStacks: 3, perStack: 1,
      description: 'Te vuelve invisible ante los ladrones: nadie puede robarte mientras esté activa.',
    },
    {
      id: 'vampire', name: 'Elixir del Vampiro', emoji: '🧛',
      price: 60000, durationMs: 15 * 60 * 1000, maxStacks: 2, perStack: 0.20,
      description: 'Robas un **20%** más de Candys en cada `rob` exitoso, por carga (máx. 2).',
    },
    {
      id: 'greed', name: 'Poción de la Codicia', emoji: '🕷️',
      price: 100000, durationMs: 20 * 60 * 1000, maxStacks: 2, perStack: 1,
      description: 'Ganas Candys extra por cada mensaje que escribes, por carga (máx. 2).',
    },
    {
      id: 'ghost', name: 'Susurro Fantasmal', emoji: '👻',
      price: 50000, durationMs: 15 * 60 * 1000, maxStacks: 3, perStack: 0.30,
      description: 'Reduce la comisión del banco al retirar, por carga (máx. 3).',
    },
    {
      id: 'pumpkin', name: 'Calabaza Dorada', emoji: '🎃',
      price: 90000, durationMs: 10 * 60 * 1000, maxStacks: 2, perStack: 0.25,
      description: 'Aumenta un **25%** tus ganancias en juegos de azar, por carga (máx. 2).',
    },
    {
      id: 'bones', name: 'Huesos de la Suerte', emoji: '💀',
      price: 55000, durationMs: 15 * 60 * 1000, maxStacks: 2, perStack: 0.25,
      description: 'Reduce un **25%** la deuda que recibes si algo sale mal, por carga (máx. 2).',
    },
    {
      id: 'web', name: 'Poción de la Telaraña', emoji: '🕸️',
      price: 65000, durationMs: 20 * 60 * 1000, maxStacks: 2, perStack: 0.15,
      description: 'Reduce un **15%** el cooldown de `work`, `crime` y `beg`, por carga (máx. 2).',
    },
    {
      id: 'revive', name: 'Elixir de Resurrección', emoji: '⚰️',
      price: 130000, durationMs: 30 * 60 * 1000, maxStacks: 2, perStack: 1,
      description: 'Anula tu próxima deuda por mala suerte. Se consume 1 carga al activarse.',
    },
  ],

  // --- Tienda del Evento (roles) ---
  EVENT_SHOP: [
    { id: 'spookyseason', name: 'Spooky Season', roleId: '1551555280108658719', price: 10350000, collectReward: 250000 },
    { id: 'og', name: 'OG', roleId: '1489704431518744666', price: 6550000, collectReward: 200000 },
    { id: '3k', name: '3K', roleId: '1489704434958077952', price: 4920000, collectReward: 150000 },
    { id: '9k', name: '9K', roleId: '1489704438489677994', price: 2810000, collectReward: 100000 },
    { id: 'arise', name: 'ARISE', roleId: '1531512361104572507', price: 1915000, collectReward: 75000 },
    { id: 'king', name: 'KING', roleId: '1531508465174970518', price: 850000, collectReward: 50000 },
    { id: 'goat', name: 'GOAT', roleId: '1537232162246496346', price: 540000, collectReward: 30000 },
    { id: 'aurainfinite', name: 'AURA INFINITE', roleId: '1494579589752684614', price: 310000, collectReward: 15000 },
    { id: 'starx', name: 'STAR X', roleId: '1489704408538415184', price: 150000, collectReward: 5000 },
  ],
  EVENT_COLLECT_REWARD_CAP: 300000,
  // Horas en UTC a propósito: así el evento empieza/termina igual sin importar
  // en qué zona horaria esté el servidor donde corra el bot (ej. Render = UTC).
  EVENT_START: new Date('2026-10-03T00:00:00Z'),
  // Fin exclusivo para incluir el día 9 de noviembre completo (UTC).
  EVENT_END: new Date('2026-11-10T00:00:00Z'),
  EVENT_INVITE_URL: 'https://discord.gg/n8f9yMkbj?event=1551612930183790673',

  // --- Evento mundial aleatorio ---
  WORLD_EVENT_CHANNEL_ID: '1489672925299605555',
  WORLD_EVENT_INTERVAL_MS: 3 * 60 * 60 * 1000,
  WORLD_EVENT_CHANCE: 0.39,
  WORLD_EVENT_DURATION_MS: 60 * 1000,
  WORLD_EVENT_REWARD_MIN: 100,
  WORLD_EVENT_REWARD_MAX: 800,
  WORLD_EVENT_TEMPLATES: [
    { title: '🕷️ ¡Una araña gigante invade el canal!', description: 'Todos los que escriban en los próximos **60 segundos** conseguirán un puñado de Candys antes de que escape.' },
    { title: '🎃 ¡Una calabaza mágica ha aparecido!', description: 'Está repartiendo Candys a quien participe en el chat durante **60 segundos**.' },
    { title: '👻 ¡Un fantasma travieso ronda el canal!', description: 'Escribe algo en los próximos **60 segundos** para que te deje algunos Candys antes de desaparecer.' },
    { title: '🧙 ¡La Bruja de Halloween está de buen humor!', description: 'Repartirá Candys entre todos los que participen en el chat durante los próximos **60 segundos**.' },
  ],
};
