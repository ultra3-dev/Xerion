'use strict';

// ============================================================
//  ECONOMY — Toda la lógica de juego vive aquí, desacoplada de
//  discord.js. Recibe/devuelve datos planos; index.js se encarga
//  de leer argumentos y mandar mensajes.
// ============================================================

const cfg = require('./config');
const db = require('./database');

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

// ---------- Owner (regla única, reutilizable por cualquier comando) ----------
// El dueño del bot (cfg.OWNER_ID) no puede ser víctima de robos ni de comandos equivalentes
// (cualquier acción que quite o bloquee Candys/artículos de otra persona sin su aceptación),
// y queda fuera de todos los rankings globales. Su "∞" es solo visual (ver ui.formatBalance):
// en la base de datos siempre se guardan números finitos y seguros.
function isOwnerId(id) {
  return id !== undefined && id !== null && String(id) === String(cfg.OWNER_ID);
}

function isOwnerUser(user) {
  return isOwnerId(db.getUserId(user));
}

function isTheftProtected(idOrUser) {
  return typeof idOrUser === 'object' && idOrUser !== null ? isOwnerUser(idOrUser) : isOwnerId(idOrUser);
}

function isSafeSum(...values) {
  return Number.isSafeInteger(values.reduce((sum, value) => sum + value, 0));
}

// ---------- XP: rango aleatorio acotado + ajuste por nivel ----------
// XP real de una acción exitosa = entero sorteado en [min, max] × factor(nivel).
//   min/max = base × (1 ∓ XP_SPREAD)  → el promedio al nivel 0 es la base configurada.
//   factor  = min(maxFactor, 1 + perLevel × nivel)  → crece con el nivel y está acotado.
// Solo se llama desde acciones válidas y exitosas (recordActivity); los errores, cooldowns,
// comandos inválidos o clics repetidos nunca llegan hasta aquí.

function xpRange(action) {
  const base = cfg.XP_PER_ACTION[action];
  if (!(base > 0)) return null;
  const spread = cfg.XP_SPREAD;
  const min = Math.max(1, Math.round(base * (1 - spread)));
  const max = Math.max(min, Math.round(base * (1 + spread)));
  return { min, max, base };
}

function xpLevelFactor(level) {
  const { perLevel, maxFactor } = cfg.XP_LEVEL_SCALE;
  const safeLevel = Number.isFinite(level) ? Math.max(0, Math.floor(level)) : 0;
  return Math.min(maxFactor, 1 + perLevel * safeLevel);
}

function xpRangeAtLevel(action, level) {
  const range = xpRange(action);
  if (!range) return null;
  const factor = xpLevelFactor(level);
  const min = Math.max(1, Math.round(range.min * factor));
  const max = Math.max(min, Math.round(range.max * factor));
  return { min, max, factor, base: range.base };
}

function rollXp(user, action, rng = Math.random) {
  const range = xpRangeAtLevel(action, db.getLevel(user.xp));
  if (!range) return 0;
  return range.min + Math.floor(rng() * (range.max - range.min + 1));
}

// ---------- Efectos de pociones (temporales) ----------

function potionDef(id) {
  return cfg.POTIONS.find((p) => p.id === id);
}

function effectBonus(user, id) {
  const stacks = db.getStacks(user, id);
  if (!stacks) return 0;
  const def = potionDef(id);
  return def ? def.perStack * stacks : 0;
}

function hasEffect(user, id) {
  return db.getStacks(user, id) > 0;
}

// ---------- Clase y arma (bonos permanentes y gratis) ----------

function classDef(id) {
  const normalized = String(id || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return cfg.CLASSES.find((c) => {
    const candidateId = String(c.id).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const candidateName = String(c.name).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
    return candidateId === normalized || candidateName === normalized;
  });
}

function weaponDef(id) {
  return cfg.WEAPONS.find((w) => w.id === id);
}

function classBonusValue(user, key) {
  if (!user.class) return 0;
  const c = classDef(user.class);
  return (c && c.bonus && c.bonus[key]) || 0;
}

function weaponBonusValue(user, key) {
  if (!user.equippedWeapon) return 0;
  const w = weaponDef(user.equippedWeapon);
  return (w && w.bonus && w.bonus[key]) || 0;
}

function levelBonusValue(user, key) {
  const level = db.getLevel(user.xp);
  return cfg.LEVEL_BONUSES
    .filter((item) => level >= item.level)
    .reduce((sum, item) => sum + ((item.bonus && item.bonus[key]) || 0), 0);
}

function achievementBonusValue(user, key) {
  const total = db.getTotal(user);
  const level = db.getLevel(user.xp);
  return cfg.ACHIEVEMENTS.reduce((sum, achievement) => {
    let value = 0;
    if (achievement.source === 'stats') value = (user.stats && user.stats[achievement.key]) || 0;
    else if (achievement.source === 'total') value = total;
    else if (achievement.source === 'level') value = level;
    return sum + (value >= achievement.threshold ? ((achievement.bonus && achievement.bonus[key]) || 0) : 0);
  }, 0);
}

// Suma el bono de clase + el de arma equipada para una clave de bono dada
// (ej. "huntReward", "robChance", "duelChance", "bankFee", "crimeChance", "robAmount")
function permanentBonus(user, key) {
  return classBonusValue(user, key) + weaponBonusValue(user, key)
    + levelBonusValue(user, key) + achievementBonusValue(user, key);
}

function consumeUse(user, key) {
  const policy = cfg.COOLDOWN_POLICIES[key];
  if (!policy) {
    if (db.isOnCooldown(user, key)) {
      return { error: 'cooldown', remaining: db.getCooldownRemaining(user, key) };
    }
    db.setCooldown(user, key, cfg.COOLDOWNS[key] || 0);
    return { durationMs: cfg.COOLDOWNS[key] || 0, isRest: false };
  }
  const reduction = Math.min(0.75, Math.max(0, effectBonus(user, 'web') + permanentBonus(user, 'cooldownReduction')));
  return db.consumeCooldownUse(user, key, {
    ...policy,
    intervalMs: Math.round(policy.intervalMs * (1 - reduction)),
    restMs: Math.round(policy.restMs * (1 - reduction)),
  });
}

// Aplica una deuda respetando "bones" (reduce %) y "revive" (anula 1 vez)
function applyDebt(user, baseAmount) {
  if (db.consumeRevive(user)) return { debtAmount: 0, revived: true };
  const reduction = Math.min(0.75, effectBonus(user, 'bones') + permanentBonus(user, 'debtReduction'));
  const reduced = Math.round(baseAmount * (1 - reduction));
  const debtAmount = Math.max(0, reduced);
  user.debt += debtAmount;
  db.markDirty(user);
  return { debtAmount, revived: false };
}

// ---------- Parseo de cantidades ("1000", "1,000", "1k", "2.5m", "all") ----------

function parseAmount(input, maxAvailable) {
  if (input === undefined || input === null || input === '') return null;
  const raw = String(input).trim().toLowerCase();
  if (['all', 'todo', 'max', 'everything'].includes(raw)) {
    return Number.isFinite(maxAvailable) && maxAvailable > 0
      ? Math.min(Number.MAX_SAFE_INTEGER, Math.floor(maxAvailable))
      : null;
  }
  let clean = raw.replace(/,/g, '');
  let mult = 1;
  if (clean.endsWith('k')) { mult = 1e3; clean = clean.slice(0, -1); }
  else if (clean.endsWith('m')) { mult = 1e6; clean = clean.slice(0, -1); }
  else if (clean.endsWith('b')) { mult = 1e9; clean = clean.slice(0, -1); }
  if (!/^\d+(?:\.\d+)?$/.test(clean)) return null;
  const num = Number(clean) * mult;
  if (!Number.isFinite(num) || num <= 0 || num > Number.MAX_SAFE_INTEGER) return null;
  return Math.floor(num);
}

// ---------- Banco ----------

function deposit(user, amount) {
  if (!amount || amount <= 0) return { error: 'invalid' };
  if (amount > user.cash) return { error: 'insufficient' };
  user.cash -= amount;
  user.bank += amount;
  db.markDirty(user);
  return { amount };
}

function withdraw(user, amount) {
  if (!amount || amount <= 0) return { error: 'invalid' };
  if (amount > user.bank) return { error: 'insufficient' };
  let feePct = db.randomFloat(cfg.BANK_FEE_MIN, cfg.BANK_FEE_MAX);
  feePct = Math.max(0, feePct * (1 - effectBonus(user, 'ghost')) * (1 - permanentBonus(user, 'bankFee')));
  const fee = Math.round(amount * feePct);
  const net = amount - fee;
  user.bank -= amount;
  user.cash += net;
  db.markDirty(user);
  return { amount, fee, net, feePct };
}

function transfer(fromUser, toUser, amount) {
  if (!amount || amount <= 0 || !Number.isSafeInteger(amount)) return { error: 'invalid' };
  if (amount > fromUser.cash) return { error: 'insufficient' };
  if (fromUser === toUser) return { error: 'invalid' };
  if (!Number.isSafeInteger(toUser.cash + amount)) return { error: 'balance_limit' };
  fromUser.cash -= amount;
  toUser.cash += amount;
  db.markDirty(fromUser, toUser);
  return { amount };
}

// ---------- Deuda ----------

function payDebt(user, amount) {
  if (user.debt <= 0) return { error: 'nodebt' };
  const target = amount === null || amount === undefined ? user.debt : amount;
  if (!target || target <= 0) return { error: 'invalid' };
  const payAmount = Math.min(target, user.debt, user.cash);
  if (payAmount <= 0) return { error: 'insufficient' };
  user.cash -= payAmount;
  user.debt -= payAmount;
  const refundPct = db.randomFloat(cfg.DEBT_REFUND_MIN, cfg.DEBT_REFUND_MAX);
  const refund = Math.round(payAmount * refundPct);
  user.cash += refund;
  db.markDirty(user);
  return { payAmount, refund, refundPct, remainingDebt: user.debt };
}

// ---------- Recompensa por cabeza (bounty) ----------

function placeBounty(fromUser, targetUser, amount) {
  if (isTheftProtected(targetUser)) return { error: 'target_owner' };
  if (!amount || amount < cfg.BOUNTY_MIN) return { error: 'too_small' };
  if (amount > fromUser.cash) return { error: 'insufficient' };
  if (db.isOnCooldown(fromUser, 'bounty')) return { error: 'cooldown', remaining: db.getCooldownRemaining(fromUser, 'bounty') };
  fromUser.cash -= amount;
  targetUser.bountyOn = (targetUser.bountyOn || 0) + amount;
  db.setCooldown(fromUser, 'bounty', cfg.COOLDOWNS.bounty);
  db.markDirty(fromUser, targetUser);
  return { amount, totalBounty: targetUser.bountyOn };
}

// ---------- Flavor text ----------

const FLAVOR = {
  work: [
    'Repartiste dulces disfrazado de calabaza en la casa embrujada del vecindario',
    'Ayudaste a la Bruja de Halloween a preparar pociones toda la noche',
    'Decoraste el cementerio local con telarañas falsas y luces moradas',
    'Hiciste de guía en la casa embrujada y asustaste a varios visitantes',
    'Tallaste calabazas para todo el vecindario a cambio de unas monedas',
  ],
  scavenge: [
    'Encontraste una bolsa de dulces escondida detrás de una lápida',
    'Seguiste unas huellas de caramelo hasta un cofre olvidado',
    'Un cuervo te cambió una llave oxidada por un puñado de Candys',
  ],
  candyraid: [
    'Te uniste a una cabalgata fantasmal y recogiste dulces por el camino',
    'La pandilla de calabazas te nombró su recolector oficial de caramelos',
    'Rescataste una carreta de dulces antes de que la atrapara la niebla',
  ],
  begGive: [
    'Un fantasma compasivo te dejó caer algunas monedas',
    'Un niño disfrazado compartió parte de su botín contigo',
    'La Bruja tuvo un momento de buen humor y te dio algo',
  ],
  begNone: [
    'Todos cerraron la puerta al verte llegar sin disfraz',
    'Nadie tenía Candys de sobra esta noche',
    'Un gato negro te miró feo y te fuiste con las manos vacías',
  ],
  totTreat: [
    'Tocaste una puerta embrujada y te llenaron el bolso de Candys',
    'Encontraste un caldero lleno de dulces abandonado',
    'La casa más espeluznante de la cuadra te dio el doble de dulces',
  ],
  totTrick: [
    'Un fantasma travieso te robó parte de tus dulces como broma',
    'Pisaste una trampa de arañas falsas y saliste corriendo sin nada',
    'La Bruja decidió cobrarte un "impuesto espeluznante" inesperado',
  ],
  crimeWin: [
    'Le robaste caramelos a la casa embrujada sin que nadie te viera',
    'Vendiste pociones falsas a los turistas de Halloween',
    'Colaste tu propio disfraz al desfile prohibido y ganaste el premio',
  ],
  crimeFail: [
    'Te atraparon saliendo de la casa embrujada con las manos en la masa',
    'La Bruja descubrió tu plan y te maldijo con una deuda',
    'El fantasma guardián te delató ante el resto del vecindario',
  ],
  robWin: [
    'te vaciaste los bolsillos mientras miraba las decoraciones',
    'le quitaste el botín de dulces sin que se diera cuenta',
    'aprovechaste la oscuridad del callejón embrujado',
  ],
  robFail: [
    'te atrapó con las manos en su bolsa de dulces',
    'gritó tan fuerte que toda la calle te vio intentarlo',
    'esquivó tu intento y la Bruja te cobró una multa por el escándalo',
  ],
  dungeonWin: [
    'Avanzaste entre telarañas y ataúdes vacíos hasta encontrar un cofre olvidado',
    'Esquivaste las trampas del pasillo maldito y llegaste hasta el tesoro del fondo',
    'Descifraste el acertijo de la cripta y la puerta del tesoro se abrió sola',
  ],
  dungeonFail: [
    'Un pasillo se derrumbó justo cuando ibas a alcanzar el tesoro',
    'Despertaste a los espíritus de la cripta y tuviste que huir sin nada',
    'Te perdiste en el laberinto y saliste con las manos vacías (y una multa)',
  ],
  quest: [
    'Completaste el encargo de la Bruja: repartir invitaciones para el aquelarre',
    'Ayudaste a un fantasma a encontrar su casa embrujada perdida',
    'Escoltaste un carruaje de calabazas por el bosque encantado',
    'Recolectaste ingredientes raros para el caldero de la Bruja',
  ],
  train: [
    'Practicaste esgrima contra un espantapájaros hasta que perdió la calabaza',
    'Corriste entre lápidas esquivando fantasmas y solo tropezaste dos veces',
    'Meditaste a la luz de la luna y algo antiguo te enseñó un truco nuevo',
    'Un esqueleto veterano te corrigió la guardia a cambio de una sonrisa',
    'Levantaste lápidas de práctica hasta que te temblaron los brazos',
  ],
  interest: [
    'La Bruja revisó tu cuenta con una lupa y sonrió: tus ahorros dieron frutos',
    'El banquero fantasma te entregó el interés con una reverencia',
    'Tus Candys del Banco crecieron en silencio mientras dormías',
  ],
  daily: [
    'La Bruja te dejó tu ración diaria de Candys en la puerta',
    'Encontraste tu bolsa de dulces del día colgada en una rama',
    'El cartero fantasma te trajo tu paga diaria puntual como siempre',
  ],
};

// ---------- Comandos de ganancia ----------

function doWork(user) {
  const used = consumeUse(user, 'work');
  if (used.error) return used;
  let reward = Math.round(db.randomInt(cfg.WORK_MIN, cfg.WORK_MAX) * (1 + permanentBonus(user, 'workReward') + effectBonus(user, 'greed')));
  reward = Math.min(reward, cfg.MAX_SINGLE_GAIN);
  user.cash += reward;
  db.incrementStat(user, 'totalWorked');
  db.markDirty(user);
  return { reward, flavor: pick(FLAVOR.work), activity: recordActivity(user, 'work') };
}

function doBeg(user) {
  const used = consumeUse(user, 'beg');
  if (used.error) return used;
  if (Math.random() < cfg.BEG_FAIL_CHANCE) {
    return { reward: 0, flavor: pick(FLAVOR.begNone) };
  }
  let reward = Math.round(db.randomInt(cfg.BEG_MIN, cfg.BEG_MAX) * (1 + permanentBonus(user, 'begReward')));
  reward = Math.min(reward, cfg.MAX_SINGLE_GAIN);
  user.cash += reward;
  db.markDirty(user);
  return { reward, flavor: pick(FLAVOR.begGive), activity: recordActivity(user, 'beg') };
}

function doScavenge(user) {
  const used = consumeUse(user, 'scavenge');
  if (used.error) return used;
  const reward = Math.min(
    Math.round(db.randomInt(cfg.SCAVENGE_REWARD_MIN, cfg.SCAVENGE_REWARD_MAX) * (1 + permanentBonus(user, 'workReward') + effectBonus(user, 'greed'))),
    cfg.MAX_SINGLE_GAIN,
  );
  user.cash += reward;
  db.incrementStat(user, 'totalScavenged');
  return { reward, flavor: pick(FLAVOR.scavenge), activity: recordActivity(user, 'scavenge') };
}

const HARVEST_FLAVOR = [
  'Encontraste una calabaza hueca llena de caramelos.',
  'Un cuervo te guio hasta un alijo olvidado de dulces.',
  'Recogiste caramelos que dejó atrás una caravana fantasmal.',
  'Ganaste una competencia de tallado y el premio fue una bolsa de Candys.',
  'La bruja te pagó por limpiar su jardín de telarañas de azúcar.',
];

function doHarvest(user) {
  const used = consumeUse(user, 'harvest');
  if (used.error) return used;
  const reward = Math.min(
    Math.round(db.randomInt(cfg.HARVEST_REWARD_MIN, cfg.HARVEST_REWARD_MAX) * (1 + permanentBonus(user, 'workReward'))),
    cfg.MAX_SINGLE_GAIN,
  );
  user.cash += reward;
  db.incrementStat(user, 'totalHarvested');
  db.markDirty(user);
  return { reward, flavor: pick(HARVEST_FLAVOR), activity: recordActivity(user, 'harvest') };
}

function doCandyRaid(user) {
  const used = consumeUse(user, 'candyraid');
  if (used.error) return used;
  const success = Math.random() < cfg.CANDYRAID_SUCCESS_CHANCE;
  if (success) {
    const reward = Math.min(
      Math.round(db.randomInt(cfg.CANDYRAID_REWARD_MIN, cfg.CANDYRAID_REWARD_MAX) * (1 + permanentBonus(user, 'questReward'))),
      cfg.MAX_SINGLE_GAIN,
    );
    user.cash += reward;
    db.incrementStat(user, 'candyRaids');
    db.markDirty(user);
    return { success: true, reward, flavor: pick(FLAVOR.candyraid), activity: recordActivity(user, 'candyraid') };
  }
  const { debtAmount, revived } = applyDebt(user, db.randomInt(cfg.CANDYRAID_FAIL_DEBT_MIN, cfg.CANDYRAID_FAIL_DEBT_MAX));
  return { success: false, debtAmount, revived, flavor: 'Un gato espectral se llevó tu bolsa y te dejó una pequeña multa.' };
}

function doTrickOrTreat(user) {
  if (db.isOnCooldown(user, 'trickortreat')) return { error: 'cooldown', remaining: db.getCooldownRemaining(user, 'trickortreat') };
  db.setCooldown(user, 'trickortreat', cfg.COOLDOWNS.trickortreat);
  if (Math.random() < cfg.TOT_TREAT_CHANCE) {
    let reward = db.randomInt(cfg.TOT_TREAT_MIN, cfg.TOT_TREAT_MAX);
    reward = Math.min(reward, cfg.MAX_SINGLE_GAIN);
    user.cash += reward;
    db.markDirty(user);
    return { treat: true, reward, flavor: pick(FLAVOR.totTreat), activity: recordActivity(user, 'trickortreat') };
  }
  const base = db.randomInt(cfg.TOT_TRICK_DEBT_MIN, cfg.TOT_TRICK_DEBT_MAX);
  const { debtAmount, revived } = applyDebt(user, base);
  return { treat: false, debtAmount, revived, flavor: pick(FLAVOR.totTrick) };
}

function doCrime(user) {
  const used = consumeUse(user, 'crime');
  if (used.error) return used;
  const chance = Math.min(0.90, cfg.CRIME_SUCCESS_CHANCE + effectBonus(user, 'luck') + permanentBonus(user, 'crimeChance'));
  if (Math.random() < chance) {
    let reward = Math.round(db.randomInt(cfg.CRIME_REWARD_MIN, cfg.CRIME_REWARD_MAX) * (1 + permanentBonus(user, 'crimeReward')));
    reward = Math.min(reward, cfg.MAX_SINGLE_GAIN);
    user.cash += reward;
    db.markDirty(user);
    return { success: true, reward, flavor: pick(FLAVOR.crimeWin), activity: recordActivity(user, 'crime') };
  }
  const base = db.randomInt(cfg.CRIME_DEBT_MIN, cfg.CRIME_DEBT_MAX);
  const { debtAmount, revived } = applyDebt(user, base);
  return { success: false, debtAmount, revived, flavor: pick(FLAVOR.crimeFail) };
}

// ---------- Ganancia: intereses del banco ----------

function doInterest(user) {
  if (db.isOnCooldown(user, 'interest')) return { error: 'cooldown', remaining: db.getCooldownRemaining(user, 'interest') };
  if (user.bank < cfg.INTEREST_MIN_BANK) return { error: 'bank_too_low', min: cfg.INTEREST_MIN_BANK, bank: user.bank };
  const reward = Math.min(
    cfg.INTEREST_MAX,
    cfg.MAX_SINGLE_GAIN,
    Math.max(1, Math.floor(user.bank * cfg.INTEREST_RATE)),
  );
  if (!isSafeSum(user.cash, reward)) return { error: 'balance_limit' };
  db.setCooldown(user, 'interest', cfg.COOLDOWNS.interest);
  user.cash += reward;
  db.markDirty(user);
  return {
    reward, bank: user.bank, rate: cfg.INTEREST_RATE, flavor: pick(FLAVOR.interest), activity: recordActivity(user, 'interest'),
  };
}

// ---------- RPG: entrenamiento (solo XP, sin Candys) ----------

function doTrain(user) {
  if (db.isOnCooldown(user, 'train')) return { error: 'cooldown', remaining: db.getCooldownRemaining(user, 'train') };
  db.setCooldown(user, 'train', cfg.COOLDOWNS.train);
  return { flavor: pick(FLAVOR.train), activity: recordActivity(user, 'train') };
}

// ---------- Robo ----------

function attemptRob(robber, target) {
  if (isTheftProtected(target)) return { error: 'target_owner' };
  if (db.isOnCooldown(robber, 'rob')) return { error: 'cooldown', remaining: db.getCooldownRemaining(robber, 'rob') };
  if (target.cash < cfg.ROB_MIN_TARGET_CASH) return { error: 'target_too_poor' };
  if (Date.now() < (target.cooldowns.robProtection || 0)) {
    return { error: 'target_protected', remaining: target.cooldowns.robProtection - Date.now() };
  }
  if (hasEffect(target, 'shadow')) return { error: 'target_shadow' };

  const used = consumeUse(robber, 'rob');
  if (used.error) return used;
  const chance = Math.min(0.90, cfg.ROB_SUCCESS_CHANCE + effectBonus(robber, 'luck') + permanentBonus(robber, 'robChance'));
  const success = Math.random() < chance;

  if (success) {
    const pct = db.randomFloat(cfg.ROB_STEAL_PCT_MIN, cfg.ROB_STEAL_PCT_MAX);
    const bonusPct = pct * (1 + effectBonus(robber, 'vampire') + permanentBonus(robber, 'robAmount'));
    const cappedPct = Math.min(cfg.ROB_STEAL_PCT_MAX, bonusPct);
    const amount = db.clamp(Math.round(target.cash * cappedPct), 1, target.cash);
    target.cash = Math.max(0, target.cash - amount);
    robber.cash += amount;
    let bountyClaimed = 0;
    if (target.bountyOn > 0) {
      bountyClaimed = target.bountyOn;
      target.bountyOn = 0;
      robber.cash += bountyClaimed;
    }
    target.cooldowns.robProtection = Date.now() + cfg.ROB_PROTECTION_MS;
    db.incrementStat(robber, 'robWins');
    db.markDirty(robber, target);
    return { success: true, amount, bountyClaimed, flavor: pick(FLAVOR.robWin), activity: recordActivity(robber, 'rob') };
  }
  const base = db.randomInt(cfg.ROB_FAIL_DEBT_MIN, cfg.ROB_FAIL_DEBT_MAX);
  const { debtAmount, revived } = applyDebt(robber, base);
  return { success: false, debtAmount, revived, flavor: pick(FLAVOR.robFail) };
}

// ---------- RPG: cacería ----------

function doHunt(user) {
  const used = consumeUse(user, 'hunt');
  if (used.error) return used;
  const monster = pick(cfg.MONSTERS);
  const chance = Math.min(0.90, cfg.HUNT_SUCCESS_CHANCE + effectBonus(user, 'luck') + permanentBonus(user, 'huntChance'));
  if (Math.random() < chance) {
    let reward = db.randomInt(cfg.HUNT_REWARD_MIN, cfg.HUNT_REWARD_MAX);
    reward = Math.round(reward * (1 + permanentBonus(user, 'huntReward')));
    reward = Math.min(reward, cfg.MAX_SINGLE_GAIN);
    user.cash += reward;
    db.incrementStat(user, 'huntWins');
    db.markDirty(user);
    return { success: true, reward, monster, activity: recordActivity(user, 'hunt') };
  }
  db.markDirty(user);
  return { success: false, monster };
}

// ---------- RPG: mazmorra ----------

function doDungeon(user) {
  if (db.isOnCooldown(user, 'dungeon')) return { error: 'cooldown', remaining: db.getCooldownRemaining(user, 'dungeon') };
  db.setCooldown(user, 'dungeon', cfg.COOLDOWNS.dungeon);
  const chance = Math.min(0.90, cfg.DUNGEON_SUCCESS_CHANCE + effectBonus(user, 'luck'));
  if (Math.random() < chance) {
    let reward = db.randomInt(cfg.DUNGEON_REWARD_MIN, cfg.DUNGEON_REWARD_MAX);
    reward = Math.min(reward, cfg.MAX_SINGLE_GAIN);
    user.cash += reward;
    db.incrementStat(user, 'dungeonClears');
    db.markDirty(user);
    return { success: true, reward, flavor: pick(FLAVOR.dungeonWin), activity: recordActivity(user, 'dungeon') };
  }
  const base = db.randomInt(cfg.DUNGEON_DEBT_MIN, cfg.DUNGEON_DEBT_MAX);
  const { debtAmount, revived } = applyDebt(user, base);
  return { success: false, debtAmount, revived, flavor: pick(FLAVOR.dungeonFail) };
}

// ---------- RPG: jefe ----------

function doBoss(user) {
  if (db.isOnCooldown(user, 'boss')) return { error: 'cooldown', remaining: db.getCooldownRemaining(user, 'boss') };
  db.setCooldown(user, 'boss', cfg.COOLDOWNS.boss);
  const chance = Math.min(0.90, cfg.BOSS_SUCCESS_CHANCE + effectBonus(user, 'luck'));
  if (Math.random() < chance) {
    let reward = db.randomInt(cfg.BOSS_REWARD_MIN, cfg.BOSS_REWARD_MAX);
    reward = Math.min(reward, cfg.MAX_SINGLE_GAIN);
    user.cash += reward;
    db.incrementStat(user, 'bossWins');
    db.markDirty(user);
    return { success: true, reward, activity: recordActivity(user, 'boss') };
  }
  const base = db.randomInt(cfg.BOSS_DEBT_MIN, cfg.BOSS_DEBT_MAX);
  const { debtAmount, revived } = applyDebt(user, base);
  return { success: false, debtAmount, revived };
}

// ---------- RPG: misiones con objetivos que se completan jugando ----------

function doQuest(user) {
  if (user.activeQuest) return { active: true, quest: user.activeQuest };
  if (db.isOnCooldown(user, 'quest')) return { error: 'cooldown', remaining: db.getCooldownRemaining(user, 'quest') };

  const used = new Set(Array.isArray(user.completedQuestIds) ? user.completedQuestIds : []);
  const completedActions = new Set(Array.isArray(user.completedQuestActions) ? user.completedQuestActions : []);
  // Migrate any earlier per-mission completion records so a task type cannot
  // reappear merely because its target count differs.
  for (const missionId of used) {
    const separator = String(missionId).lastIndexOf('_');
    const action = separator > 0 ? String(missionId).slice(0, separator) : '';
    if (action) completedActions.add(action);
  }
  const available = cfg.QUEST_MISSIONS.filter((mission) => !used.has(mission.id) && !completedActions.has(mission.action));
  if (!available.length) return { error: 'all_completed' };

  const mission = pick(available);
  user.activeQuest = { ...mission, progress: 0, startedAt: Date.now() };
  db.markDirty(user);
  return { started: true, quest: user.activeQuest };
}

function recordActivity(user, action, rng = Math.random) {
  const actionXp = rollXp(user, action, rng);
  if (actionXp > 0) db.addXp(user, actionXp);
  const actionDropChance = {
    work: 0.35, beg: 0.15, crime: 0.35, scavenge: 0.55, harvest: 0.45,
    candyraid: 0.50, trickortreat: 0.30, rob: 0.35, hunt: 0.60,
    dungeon: 0.80, boss: 0.90, duel: 0.50, collect: 1,
    train: 0.30, interest: 0.20,
  };
  const materials = [];
  if (cfg.MATERIALS.length && Math.random() < (actionDropChance[action] || 0)) {
    const material = pick(cfg.MATERIALS);
    const quantity = Math.random() < 0.08 ? 2 : 1;
    db.addMaterial(user, material.id, quantity);
    materials.push({ ...material, quantity });
  }

  let questProgress = null;
  let questXp = 0;
  const quest = user.activeQuest;
  if (quest && quest.action === action) {
    quest.progress = Math.min(quest.target, (quest.progress || 0) + 1);
    if (quest.progress >= quest.target) {
      const base = db.randomInt(cfg.QUEST_REWARD_MIN, cfg.QUEST_REWARD_MAX);
      const gotBonus = Math.random() < cfg.QUEST_BONUS_CHANCE;
      const bonus = gotBonus ? db.randomInt(cfg.QUEST_BONUS_MIN, cfg.QUEST_BONUS_MAX) : 0;
      const total = Math.round((base + bonus) * (1 + permanentBonus(user, 'questReward')));
      const completedQuest = { ...quest };
      user.cash += total;
      questXp = rollXp(user, 'quest', rng);
      if (questXp > 0) db.addXp(user, questXp);
      user.completedQuestIds = Array.isArray(user.completedQuestIds) ? user.completedQuestIds : [];
      user.completedQuestIds.push(quest.id);
      user.completedQuestActions = Array.isArray(user.completedQuestActions) ? user.completedQuestActions : [];
      if (!user.completedQuestActions.includes(quest.action)) user.completedQuestActions.push(quest.action);
      user.activeQuest = null;
      db.setCooldown(user, 'quest', cfg.COOLDOWNS.quest);
      questProgress = { completed: true, quest: completedQuest, reward: total, gotBonus };
    } else {
      questProgress = { completed: false, quest: { ...quest } };
      db.markDirty(user);
    }
  }
  return { materials, questProgress, xp: actionXp + questXp };
}

// La recompensa diaria especial solo se entrega en el último día UTC del evento
// y antes del instante exacto de cierre.
function isEventFinaleDay(now) {
  const end = new Date(cfg.EVENT_END.getTime() - 1);
  return now < cfg.EVENT_END
    && now.getUTCFullYear() === end.getUTCFullYear()
    && now.getUTCMonth() === end.getUTCMonth()
    && now.getUTCDate() === end.getUTCDate();
}

function doDaily(user, now) {
  if (db.isOnCooldown(user, 'daily')) return { error: 'cooldown', remaining: db.getCooldownRemaining(user, 'daily') };
  db.setCooldown(user, 'daily', cfg.COOLDOWNS.daily);
  const finale = isEventFinaleDay(now || new Date());
  const total = finale
    ? cfg.DAILY_EVENT_FINALE_BONUS
    : Math.min(db.randomInt(cfg.DAILY_REWARD_MIN, cfg.DAILY_REWARD_MAX), cfg.MAX_SINGLE_GAIN);
  user.cash += total;
  db.markDirty(user);
  return { total, finale, flavor: pick(FLAVOR.daily), activity: recordActivity(user, 'daily') };
}

// ---------- RPG: duelo (reto/aceptar) ----------

const pendingDuels = new Map(); // targetId -> { challengerId, bet, createdAt }

function createDuelChallenge(challengerId, challengerUser, targetId, bet) {
  if (db.isOnCooldown(challengerUser, 'duel')) {
    return { error: 'cooldown', remaining: db.getCooldownRemaining(challengerUser, 'duel') };
  }
  if (pendingDuels.has(targetId)) return { error: 'already_pending' };
  db.setCooldown(challengerUser, 'duel', cfg.COOLDOWNS.duel);
  pendingDuels.set(targetId, { challengerId, bet, createdAt: Date.now() });
  return { ok: true };
}

function getDuelChallenge(targetId) { return pendingDuels.get(targetId); }
function cancelDuelChallenge(targetId) { pendingDuels.delete(targetId); }

// Toma el reto y lo elimina en un solo paso síncrono: dos clics (o clic + expiración) nunca pueden
// resolver el mismo duelo dos veces, aunque haya awaits después.
function claimDuelChallenge(targetId) {
  const challenge = pendingDuels.get(targetId);
  if (!challenge) return null;
  pendingDuels.delete(targetId);
  return challenge;
}

function resolveDuel(challenger, challengerId, target, targetId, bet) {
  if (!Number.isSafeInteger(bet) || bet <= 0) return { error: 'invalid_bet' };
  if (challenger.cash < bet) return { error: 'challenger_insufficient' };
  if (target.cash < bet) return { error: 'target_insufficient' };
  if (!Number.isSafeInteger(bet * 2) || !Number.isSafeInteger(challenger.cash + bet) || !Number.isSafeInteger(target.cash + bet)) {
    return { error: 'balance_limit' };
  }
  challenger.cash -= bet;
  target.cash -= bet;
  const chance = db.clamp(0.5 + permanentBonus(challenger, 'duelChance') - permanentBonus(target, 'duelChance'), 0.1, 0.9);
  const challengerWins = Math.random() < chance;
  const pot = bet * 2;
  if (challengerWins) {
    challenger.cash += pot;
    db.incrementStat(challenger, 'duelWins');
  } else {
    target.cash += pot;
    db.incrementStat(target, 'duelWins');
  }
  const winnerActivity = challengerWins
    ? recordActivity(challenger, 'duel')
    : recordActivity(target, 'duel');
  db.markDirty(challenger, target);
  cancelDuelChallenge(targetId);
  return { challengerWins, pot, bet, winnerActivity };
}

// ---------- RPG: clase ----------

function setClass(user, classId) {
  const c = classDef(classId);
  if (!c) return { error: 'notfound' };
  if (user.class) {
    return { error: user.class === c.id ? 'same_class' : 'already_chosen' };
  }
  if (db.getLevel(user.xp) < 5) return { error: 'level_required', level: 5 };
  user.class = c.id;
  db.markDirty(user);
  return { classDef: c };
}

// ---------- RPG: armería ----------

function buyWeapon(user, weaponId) {
  const w = weaponDef(weaponId);
  if (!w) return { error: 'notfound' };
  if (db.hasWeapon(user, weaponId)) return { error: 'already_owned' };
  if (user.debt > 0) return { error: 'debt' };
  if (user.cash < w.price) return { error: 'insufficient' };
  user.cash -= w.price;
  db.addWeapon(user, weaponId);
  db.markDirty(user);
  return { weapon: w };
}

function equipWeapon(user, weaponId) {
  const w = weaponDef(weaponId);
  if (!w) return { error: 'notfound' };
  if (!db.hasWeapon(user, weaponId)) return { error: 'not_owned' };
  user.equippedWeapon = weaponId;
  db.markDirty(user);
  return { weapon: w };
}

// ---------- RPG: logros (derivados en vivo de las estadísticas) ----------

function checkAchievements(user) {
  const total = db.getTotal(user);
  const level = db.getLevel(user.xp);
  return cfg.ACHIEVEMENTS.map((a) => {
    let value = 0;
    if (a.source === 'stats') value = (user.stats && user.stats[a.key]) || 0;
    else if (a.source === 'total') value = total;
    else if (a.source === 'level') value = level;
    return {
      id: a.id, name: a.name, emoji: a.emoji, desc: a.desc, unlocked: value >= a.threshold,
      value, threshold: a.threshold, benefit: a.bonus || null,
    };
  });
}

// ---------- Spooky Gamble ----------

// Multiplicador de premio de casino del jugador (poción Calabaza Dorada + beneficios permanentes).
function casinoBonusFactor(user) {
  return 1 + effectBonus(user, 'pumpkin') + permanentBonus(user, 'casinoPayout');
}

// Revisa el cooldown SIN consumir un uso: así un error de saldo no gasta un intento del ciclo.
function peekCooldown(user, key) {
  const remaining = db.getCooldownRemaining(user, key);
  return remaining > 0 ? { error: 'cooldown', remaining } : null;
}

function gamble(user, bet) {
  if (!Number.isSafeInteger(bet) || bet <= 0) return { error: 'invalid' };
  if (bet > user.cash) return { error: 'insufficient' };
  const win = Math.random() < cfg.GAMBLE_WIN_CHANCE;
  if (win) {
    const payout = Math.round(bet * 2 * (1 + effectBonus(user, 'pumpkin') + permanentBonus(user, 'casinoPayout')));
    if (!Number.isSafeInteger(payout) || !Number.isSafeInteger(user.cash - bet + payout)) return { error: 'balance_limit' };
    user.cash -= bet;
    user.cash += payout;
    db.incrementStat(user, 'casinoWins');
    db.markDirty(user);
    return { win: true, payout, net: payout - bet };
  }
  user.cash -= bet;
  db.markDirty(user);
  return { win: false, lost: bet };
}

function weightedSymbol(rng = Math.random) {
  const total = cfg.SLOTS_SYMBOLS.reduce((s, x) => s + x.weight, 0);
  let r = rng() * total;
  for (const s of cfg.SLOTS_SYMBOLS) {
    if (r < s.weight) return s.symbol;
    r -= s.weight;
  }
  return cfg.SLOTS_SYMBOLS[0].symbol;
}

function slotsOutcome(reels) {
  if (reels[0] === reels[1] && reels[1] === reels[2]) {
    return cfg.SLOTS_RARE_SYMBOLS.includes(reels[0])
      ? { kind: 'triple_rare', multiplier: cfg.SLOTS_TRIPLE_RARE_MULT }
      : { kind: 'triple', multiplier: cfg.SLOTS_TRIPLE_MULT };
  }
  if (reels[0] === reels[1] || reels[1] === reels[2] || reels[0] === reels[2]) {
    return { kind: 'double', multiplier: cfg.SLOTS_DOUBLE_MULT };
  }
  return { kind: 'none', multiplier: 0 };
}

// El resultado incluye TODO lo que la animación y el mensaje final necesitan (rodillos, multiplicador,
// premio): la interfaz nunca vuelve a sortear nada, solo lo dibuja.
function slots(user, bet, rng = Math.random) {
  if (!Number.isSafeInteger(bet) || bet <= 0) return { error: 'invalid' };
  if (bet > user.cash) return { error: 'insufficient' };
  const reels = [weightedSymbol(rng), weightedSymbol(rng), weightedSymbol(rng)];
  const { kind, multiplier } = slotsOutcome(reels);
  const bonusFactor = casinoBonusFactor(user);
  const payout = Math.round(bet * multiplier * bonusFactor);
  if (!Number.isSafeInteger(payout) || !Number.isSafeInteger(user.cash - bet + payout)) return { error: 'balance_limit' };
  user.cash -= bet;
  user.cash += payout;
  if (payout > bet) db.incrementStat(user, 'casinoWins');
  db.markDirty(user);
  return { reels, kind, multiplier, bonusFactor, payout, net: payout - bet };
}

// ---------- Dados ----------

function playDice(user, bet, guess) {
  if (!Number.isSafeInteger(bet) || bet <= 0) return { error: 'invalid' };
  if (bet > user.cash) return { error: 'insufficient' };
  if (!Number.isInteger(guess) || guess < 1 || guess > 6) return { error: 'invalid_guess' };
  const roll = db.randomInt(1, 6);
  const win = roll === guess;
  let payout = 0;
  if (win) {
    payout = Math.round(bet * cfg.DICE_PAYOUT_MULT * (1 + effectBonus(user, 'pumpkin') + permanentBonus(user, 'casinoPayout')));
    if (!Number.isSafeInteger(payout) || !Number.isSafeInteger(user.cash - bet + payout)) return { error: 'balance_limit' };
  }
  user.cash -= bet;
  if (win) {
    user.cash += payout;
    db.incrementStat(user, 'casinoWins');
  }
  db.markDirty(user);
  return { win, roll, payout, net: payout - bet };
}

// ---------- Ruleta embrujada ----------

function weightedRouletteColor(rng = Math.random) {
  const total = cfg.ROULETTE_COLORS.reduce((s, x) => s + x.weight, 0);
  let r = rng() * total;
  for (const c of cfg.ROULETTE_COLORS) {
    if (r < c.weight) return c;
    r -= c.weight;
  }
  return cfg.ROULETTE_COLORS[0];
}

function normalizeRouletteColor(colorChoice) {
  const raw = String(colorChoice || '').trim().toLowerCase();
  const aliases = {
    red: 'rojo', orange: 'rojo', naranja: 'rojo',
    black: 'negro',
    purple: 'morado', violet: 'morado',
    green: 'verde',
  };
  return aliases[raw] || raw;
}

function playRoulette(user, bet, colorChoice, rng = Math.random) {
  if (!Number.isSafeInteger(bet) || bet < cfg.ROULETTE_MIN_BET) return { error: 'invalid' };
  if (bet > user.cash) return { error: 'insufficient' };
  const choice = normalizeRouletteColor(colorChoice);
  const choiceDef = cfg.ROULETTE_COLORS.find((c) => c.id === choice && c.id !== 'calabaza');
  if (!choiceDef) return { error: 'invalid_color' };
  const cooling = peekCooldown(user, 'roulette');
  if (cooling) return cooling;
  const landed = weightedRouletteColor(rng);
  const landedIndex = cfg.ROULETTE_COLORS.indexOf(landed);
  const win = landed.id === choice;
  const bonusFactor = casinoBonusFactor(user);
  let payout = 0;
  if (win) {
    payout = Math.round(bet * landed.mult * bonusFactor);
    if (!Number.isSafeInteger(payout) || !Number.isSafeInteger(user.cash - bet + payout)) return { error: 'balance_limit' };
  }
  const used = consumeUse(user, 'roulette');
  if (used.error) return used;
  user.cash -= bet;
  if (win) {
    user.cash += payout;
    db.incrementStat(user, 'casinoWins');
  }
  db.markDirty(user);
  return {
    win,
    choice,
    landed: landed.id,
    landedLabel: landed.label,
    landedIndex,
    landedMult: landed.mult,
    multiplier: win ? landed.mult : 0,
    bonusFactor,
    payout,
    net: payout - bet,
  };
}

// ---------- Rueda de la fortuna ----------

function pickWheelSegment(rng = Math.random) {
  const total = cfg.WHEEL_SEGMENTS.reduce((s, x) => s + x.weight, 0);
  let r = rng() * total;
  for (let index = 0; index < cfg.WHEEL_SEGMENTS.length; index += 1) {
    const segment = cfg.WHEEL_SEGMENTS[index];
    if (r < segment.weight) return { segment, index };
    r -= segment.weight;
  }
  const index = cfg.WHEEL_SEGMENTS.length - 1;
  return { segment: cfg.WHEEL_SEGMENTS[index], index };
}

function playWheel(user, bet, rng = Math.random) {
  if (!Number.isSafeInteger(bet) || bet < cfg.WHEEL_MIN_BET) return { error: 'invalid' };
  if (bet > user.cash) return { error: 'insufficient' };
  const cooling = peekCooldown(user, 'wheel');
  if (cooling) return cooling;
  const { segment, index } = pickWheelSegment(rng);
  const bonusFactor = casinoBonusFactor(user);
  const payout = Math.round(bet * segment.mult * bonusFactor);
  if (!Number.isSafeInteger(payout) || !Number.isSafeInteger(user.cash - bet + payout)) return { error: 'balance_limit' };
  const used = consumeUse(user, 'wheel');
  if (used.error) return used;
  user.cash -= bet;
  user.cash += payout;
  if (payout > bet) db.incrementStat(user, 'casinoWins');
  db.markDirty(user);
  return {
    multiplier: segment.mult, segmentIndex: index, bonusFactor, payout, net: payout - bet,
  };
}

// ---------- Crash: la escoba de la bruja ----------
// La escoba sube hasta estrellarse en `crashPoint` (múltiplo con 2 decimales, mínimo x1.00).
// Eliges un múltiplo objetivo: si objetivo <= crashPoint cobras apuesta × objetivo; si no, pierdes.
// P(crashPoint >= m) = (1 - CRASH_HOUSE_EDGE) / m  →  retorno esperado = 1 - CRASH_HOUSE_EDGE.

function drawCrashPoint(rng = Math.random) {
  const r = rng();
  const raw = (1 - cfg.CRASH_HOUSE_EDGE) / (1 - r);
  const floored = Math.floor(raw * 100) / 100;
  if (!Number.isFinite(floored) || floored < 1) return 1;
  return Math.min(cfg.CRASH_MAX_MULTIPLIER, floored);
}

// Acepta "2", "2.5", "2,5", "2.5x", "x2.5". Devuelve un número con ≤2 decimales o null.
function parseCrashTarget(input) {
  if (input === undefined || input === null) return null;
  const raw = String(input).trim().toLowerCase().replace(/^x/, '').replace(/x$/, '').replace(',', '.');
  if (!/^\d+(?:\.\d{1,2})?$/.test(raw)) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < cfg.CRASH_MIN_TARGET || value > cfg.CRASH_MAX_TARGET) return null;
  return Math.round(value * 100) / 100;
}

function playCrash(user, bet, target, rng = Math.random) {
  if (!Number.isSafeInteger(bet) || bet < cfg.CRASH_MIN_BET) return { error: 'invalid' };
  if (bet > user.cash) return { error: 'insufficient' };
  const parsedTarget = parseCrashTarget(target);
  if (parsedTarget === null) return { error: 'invalid_target' };
  const targetCents = Math.round(parsedTarget * 100);
  const cooling = peekCooldown(user, 'crash');
  if (cooling) return cooling;
  const crashPoint = drawCrashPoint(rng);
  const crashCents = Math.round(crashPoint * 100);
  const win = crashCents >= targetCents;
  const bonusFactor = casinoBonusFactor(user);
  let payout = 0;
  if (win) {
    payout = Math.round((bet * targetCents * bonusFactor) / 100);
    if (!Number.isSafeInteger(payout) || !Number.isSafeInteger(user.cash - bet + payout)) return { error: 'balance_limit' };
  }
  const used = consumeUse(user, 'crash');
  if (used.error) return used;
  user.cash -= bet;
  if (win) {
    user.cash += payout;
    if (payout > bet) db.incrementStat(user, 'casinoWins');
  }
  db.markDirty(user);
  return {
    win, crashPoint, crashCents, target: parsedTarget, targetCents, bonusFactor, payout, net: payout - bet,
  };
}

// ---------- Blackjack (estado en memoria, una partida por usuario) ----------

const activeBlackjack = new Map();

function newDeck() {
  const suits = ['♠', '♥', '♦', '♣'];
  const ranks = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  const deck = [];
  for (const s of suits) for (const r of ranks) deck.push(r + s);
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function cardRank(card) { return card.slice(0, -1); }
function cardSuit(card) { return card.slice(-1); }

function cardValue(card) {
  const rank = cardRank(card);
  if (rank === 'A') return 11;
  if (['J', 'Q', 'K'].includes(rank)) return 10;
  return parseInt(rank, 10);
}

function handValue(hand) {
  let total = hand.reduce((s, c) => s + cardValue(c), 0);
  let aces = hand.filter((c) => cardRank(c) === 'A').length;
  while (total > 21 && aces > 0) { total -= 10; aces -= 1; }
  return total;
}

// Límite ESTRICTO: jugador + banca nunca suman más de cfg.BLACKJACK_MAX_CARDS cartas (iniciales incluidas).
function bjCardsOnTable(g) { return g.player.length + g.dealer.length; }
function bjCanHit(g) { return !!g && g.status === 'playing' && bjCardsOnTable(g) < cfg.BLACKJACK_MAX_CARDS; }

// Nunca devuelve undefined: si la baraja se agotara arma otra sin las cartas que ya están en mesa.
function bjDraw(g) {
  if (!g.deck.length) {
    const inPlay = new Set([...g.player, ...g.dealer]);
    g.deck = newDeck().filter((card) => !inPlay.has(card));
  }
  return g.deck.pop();
}

function startBlackjack(userId, user, bet) {
  if (!Number.isSafeInteger(bet) || bet <= 0) return { error: 'invalid' };
  if (bet > user.cash) return { error: 'insufficient' };
  if (activeBlackjack.has(userId)) return { error: 'already_playing' };
  const maxPayout = Math.round(bet * 2.5 * (1 + effectBonus(user, 'pumpkin') + permanentBonus(user, 'casinoPayout')));
  if (!Number.isSafeInteger(maxPayout) || !Number.isSafeInteger(user.cash - bet + maxPayout)) return { error: 'balance_limit' };
  user.cash -= bet;
  db.markDirty(user);
  const deck = newDeck();
  const player = [deck.pop(), deck.pop()];
  const dealer = [deck.pop(), deck.pop()];
  const game = {
    deck, player, dealer, bet, userId, status: 'playing', startedAt: Date.now(), resolution: null,
  };
  const naturalBJ = handValue(player) === 21;
  if (naturalBJ) game.status = 'stood';
  activeBlackjack.set(userId, game);
  return { game };
}

function getBlackjack(userId) { return activeBlackjack.get(userId); }

// La banca roba hasta 17 mientras queden cartas dentro del límite de la mesa.
function bjDealerPlay(g) {
  while (handValue(g.dealer) < 17 && bjCardsOnTable(g) < cfg.BLACKJACK_MAX_CARDS) g.dealer.push(bjDraw(g));
}

function bjHit(userId) {
  const g = activeBlackjack.get(userId);
  if (!g || g.status !== 'playing') return null;
  if (!bjCanHit(g)) {
    // Mesa llena: no se reparte ninguna carta más; la partida se cierra de forma segura.
    bjDealerPlay(g);
    g.status = 'stood';
    return g;
  }
  g.player.push(bjDraw(g));
  if (handValue(g.player) > 21) {
    g.status = 'bust';
    return g;
  }
  if (bjCardsOnTable(g) >= cfg.BLACKJACK_MAX_CARDS) {
    // Se acaba de colocar la última carta permitida: el jugador se planta automáticamente.
    bjDealerPlay(g);
    g.status = 'stood';
  }
  return g;
}

function bjStand(userId) {
  const g = activeBlackjack.get(userId);
  if (!g || g.status !== 'playing') return g || null;
  bjDealerPlay(g);
  g.status = 'stood';
  return g;
}

// Idempotente: resolver dos veces la misma partida nunca paga dos veces.
function bjResolve(user, g) {
  if (g.resolution) return g.resolution;
  const pv = handValue(g.player);
  const dv = handValue(g.dealer);
  const cards = bjCardsOnTable(g);
  const limitReached = cards >= cfg.BLACKJACK_MAX_CARDS;
  // Si la mesa se llenó antes de que la banca pudiera completar su mano (< 17), la partida
  // se declara empate y se devuelve la apuesta: el límite nunca favorece a nadie.
  const dealerBlocked = limitReached && g.status !== 'bust' && dv < 17;
  const naturalBJ = g.player.length === 2 && pv === 21;
  let result;
  let payout = 0;
  if (g.status === 'bust') {
    result = 'lose';
  } else if (dealerBlocked) {
    result = 'push';
    payout = g.bet;
  } else if (dv > 21 || pv > dv) {
    result = naturalBJ ? 'blackjack' : 'win';
    payout = Math.round((naturalBJ ? g.bet * 2.5 : g.bet * 2) * (1 + effectBonus(user, 'pumpkin') + permanentBonus(user, 'casinoPayout')));
  } else if (pv === dv) {
    result = 'push';
    payout = g.bet;
  } else {
    result = 'lose';
  }
  if (payout > 0) user.cash += payout;
  if (result === 'win' || result === 'blackjack') db.incrementStat(user, 'casinoWins');
  db.markDirty(user);
  activeBlackjack.delete(g.userId);
  g.resolution = {
    result, payout, net: payout - g.bet, playerValue: pv, dealerValue: dv, cards, limitReached, dealerBlocked,
  };
  return g.resolution;
}

function endBlackjack(userId) { activeBlackjack.delete(userId); }

// ---------- Tiendas ----------

function buyPotion(user, potionId, qty) {
  const p = potionDef(potionId);
  if (!p) return { error: 'notfound' };
  if (user.debt > 0) return { error: 'debt' };
  const quantity = Math.floor(Number(qty || 1));
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 99) return { error: 'invalid_quantity' };
  const totalCost = p.price * quantity;
  if (!Number.isSafeInteger(totalCost)) return { error: 'invalid_quantity' };
  if (user.cash < totalCost) return { error: 'insufficient' };
  user.cash -= totalCost;
  db.addInventory(user, p.id, quantity);
  db.markDirty(user);
  return { potion: p, quantity, totalCost };
}

function buyEventRole(now, user, idOrRoleId) {
  const normalized = String(idOrRoleId || '').trim().toLowerCase();
  const r = cfg.EVENT_SHOP.find((x) => x.id.toLowerCase() === normalized || x.roleId === idOrRoleId);
  if (!r) return { error: 'notfound' };
  if (now < cfg.EVENT_START) return { error: 'notstarted' };
  if (now >= cfg.EVENT_END) return { error: 'ended' };
  if (!Array.isArray(user.eventRolesPurchased)) user.eventRolesPurchased = [];
  if (user.eventRolesPurchased.includes(r.roleId)) return { error: 'already_owned', role: r };
  if (user.debt > 0) return { error: 'debt' };
  const missingMaterials = Object.entries(r.requirements || {})
    .filter(([materialId, required]) => (user.materials?.[materialId] || 0) < required)
    .map(([materialId, required]) => ({
      id: materialId,
      required,
      have: user.materials?.[materialId] || 0,
    }));
  if (missingMaterials.length) return { error: 'insufficient_materials', role: r, missingMaterials };
  if (user.cash < r.price) return { error: 'insufficient' };
  if (!user.materials || typeof user.materials !== 'object') user.materials = {};
  user.cash -= r.price;
  for (const [materialId, required] of Object.entries(r.requirements || {})) {
    user.materials[materialId] -= required;
    if (user.materials[materialId] <= 0) delete user.materials[materialId];
  }
  user.eventRolesPurchased.push(r.roleId);
  db.markDirty(user);
  return { role: r, materialsSpent: r.requirements || {} };
}

function activateEventRole(user, idOrRoleId, now = new Date()) {
  const normalized = String(idOrRoleId || '').trim().toLowerCase();
  const role = cfg.EVENT_SHOP.find((item) => item.id.toLowerCase() === normalized || item.roleId === idOrRoleId);
  if (!role) return { error: 'notfound' };
  if (now < cfg.EVENT_START) return { error: 'notstarted', role };
  if (now >= cfg.EVENT_END) return { error: 'ended', role };
  if (!Array.isArray(user.eventRolesPurchased) || !user.eventRolesPurchased.includes(role.roleId)) {
    return { error: 'not_purchased', role };
  }
  if (!Array.isArray(user.eventRolesActivated)) user.eventRolesActivated = [...user.eventRolesPurchased];
  if (user.eventRolesActivated.includes(role.roleId)) return { error: 'already_active', role };
  if (user.debt > 0) return { error: 'debt' };
  const activationCost = Math.ceil(role.price / 2);
  if (user.cash < activationCost) return { error: 'insufficient', role, activationCost };
  user.cash -= activationCost;
  user.eventRolesActivated.push(role.roleId);
  db.markDirty(user);
  return { role, activationCost };
}

function usePotion(user, potionId) {
  const p = potionDef(potionId);
  if (!p) return { error: 'notfound' };
  if (!db.removeInventory(user, potionId, 1)) return { error: 'none_owned' };
  const stacks = db.applyPotionEffect(user, p);
  return { potion: p, stacks };
}

function refundEventRole(user, role) {
  if (user.eventRolesPurchased) {
    user.eventRolesPurchased = user.eventRolesPurchased.filter((roleId) => roleId !== role.roleId);
  }
  if (user.eventRolesActivated) {
    user.eventRolesActivated = user.eventRolesActivated.filter((roleId) => roleId !== role.roleId);
  }
  user.cash += role.price;
  for (const [materialId, quantity] of Object.entries(role.requirements || {})) {
    db.addMaterial(user, materialId, quantity);
  }
  db.markDirty(user);
}

function rollbackEventRoleActivation(user, role) {
  if (user.eventRolesActivated) {
    user.eventRolesActivated = user.eventRolesActivated.filter((roleId) => roleId !== role.roleId);
  }
  user.cash += Math.ceil(role.price / 2);
  db.markDirty(user);
}

// ---------- Tienda del Evento: ingresos (collect) ----------
// Reglas:
//  · El ingreso lo paga SOLO el mejor rol activado (el de mayor collectReward).
//  · Los demás roles activados pasan a "Obtenido": siguen siendo tuyos (y su rol de Discord) pero no suman ingresos.
//  · Cada rol tiene su PROPIO cooldown (clave `collect:<id>`): al activar un rol mejor puedes reclamar su primer
//    ingreso sin esperar el cooldown del rol anterior.

function collectCooldownKey(role) {
  return `collect:${role.id}`;
}

function bestActivatedRole(user) {
  const activated = new Set(Array.isArray(user.eventRolesActivated) ? user.eventRolesActivated : []);
  return cfg.EVENT_SHOP
    .filter((role) => activated.has(role.roleId))
    .sort((a, b) => (b.collectReward - a.collectReward) || (b.price - a.price))[0] || null;
}

// Estado de cada rol para este usuario:
//   available → sin comprar · purchased → comprado, falta activar · active → activado y es el que paga
//   obtained  → activado pero ya lo supera un rol mejor (no paga ingresos)
function getEventRoleStatuses(user) {
  const purchased = new Set(Array.isArray(user.eventRolesPurchased) ? user.eventRolesPurchased : []);
  const activated = new Set(Array.isArray(user.eventRolesActivated) ? user.eventRolesActivated : []);
  const best = bestActivatedRole(user);
  return cfg.EVENT_SHOP.map((role) => {
    let status = 'available';
    if (activated.has(role.roleId)) status = best && best.roleId === role.roleId ? 'active' : 'obtained';
    else if (purchased.has(role.roleId)) status = 'purchased';
    // Un rol comprado que no supera al mejor activado no sumaría ingresos aunque se active.
    const wouldPay = status === 'purchased' && (!best || role.collectReward > best.collectReward);
    return { role, status, wouldPay, best };
  });
}

// El cooldown antiguo (una sola clave `collect`) se traslada al mejor rol actual: nadie obtiene un cobro extra
// por la actualización, y a partir del siguiente cobro cada rol usa su propia clave.
function migrateLegacyCollectCooldown(user, role) {
  if (!user.cooldowns || user.cooldowns.collect === undefined) return;
  const key = collectCooldownKey(role);
  user.cooldowns[key] = Math.max(user.cooldowns[key] || 0, Number(user.cooldowns.collect) || 0);
  delete user.cooldowns.collect;
  db.markDirty(user);
}

function getCollectRemaining(user, role = bestActivatedRole(user), now = Date.now()) {
  if (!role) return 0;
  const own = Number(user.cooldowns?.[collectCooldownKey(role)]) || 0;
  const legacy = Number(user.cooldowns?.collect) || 0;
  return Math.max(0, Math.max(own, legacy) - now);
}

function collectEventIncome(user, now = new Date()) {
  if (now < cfg.EVENT_START) return { error: 'notstarted' };
  if (now >= cfg.EVENT_END) return { error: 'ended' };
  const eligibleRole = bestActivatedRole(user);
  if (!eligibleRole) return { error: 'no_eligible_role' };
  migrateLegacyCollectCooldown(user, eligibleRole);
  const remaining = getCollectRemaining(user, eligibleRole);
  if (remaining > 0) return { error: 'cooldown', remaining, role: eligibleRole };

  const reward = Math.floor(eligibleRole.collectReward || 0);
  if (reward < 1) return { error: 'invalid_reward' };
  if (!isSafeSum(user.cash, reward)) return { error: 'balance_limit' };
  const cooldownMs = eligibleRole.collectCooldownMs || cfg.COOLDOWNS.collect;
  db.setCooldown(user, collectCooldownKey(eligibleRole), cooldownMs);
  user.cash += reward;
  db.incrementStat(user, 'eventCollects');
  db.markDirty(user);
  const obtained = getEventRoleStatuses(user).filter((item) => item.status === 'obtained').map((item) => item.role);
  return {
    reward, role: eligibleRole, cooldownMs, obtained, activity: recordActivity(user, 'collect'),
  };
}

function redeemCode(userId, user, code, now = new Date()) {
  return db.redeemCode(userId, user, code, now);
}

// ---------- Rankings / estadísticas del servidor ----------

function getLeaderboard(limit = 10) {
  const users = db.getAllUsers();
  const arr = [];
  for (const [id, u] of Object.entries(users)) {
    if (isOwnerId(id)) continue; // el dueño nunca entra en rankings globales (ni afecta posiciones/páginas)
    arr.push({ id, value: db.getTotal(u) });
  }
  arr.sort((a, b) => b.value - a.value);
  return arr.slice(0, limit);
}

function getDebtLeaderboard(limit = 10) {
  const users = db.getAllUsers();
  const arr = [];
  for (const [id, u] of Object.entries(users)) {
    if (isOwnerId(id) || !(u.debt > 0)) continue;
    arr.push({ id, value: u.debt });
  }
  arr.sort((a, b) => b.value - a.value);
  return arr.slice(0, limit);
}

// Puesto en el ranking de ricos (mismo orden estable que getLeaderboard) calculado en O(n) sin ordenar
// ni copiar la lista. El dueño no tiene puesto (null). Si el perfil no existe: último + 1.
function getRank(userId) {
  if (isOwnerId(userId)) return null;
  const users = db.getAllUsers();
  const me = users[userId];
  let count = 0;
  if (!me) {
    for (const id of Object.keys(users)) if (!isOwnerId(id)) count += 1;
    return count + 1;
  }
  const myTotal = db.getTotal(me);
  let ahead = 0;
  let seenMe = false;
  for (const [id, u] of Object.entries(users)) {
    if (isOwnerId(id)) continue;
    if (id === userId) { seenMe = true; continue; }
    const total = db.getTotal(u);
    if (total > myTotal || (total === myTotal && !seenMe)) ahead += 1;
  }
  return ahead + 1;
}

function getServerStats() {
  const users = db.getAllUsers();
  let totalCirculating = 0; let totalBank = 0; let totalDebt = 0; let userCount = 0;
  let richestId = null; let richestVal = -Infinity;
  for (const [id, u] of Object.entries(users)) {
    userCount += 1;
    totalCirculating += u.cash + u.bank;
    totalBank += u.bank;
    totalDebt += u.debt;
    if (isOwnerId(id)) continue; // "usuario más rico" es un ranking: el dueño queda fuera
    const total = db.getTotal(u);
    if (total > richestVal) { richestVal = total; richestId = id; }
  }
  return {
    userCount, totalCirculating, totalBank, totalDebt, richestId,
  };
}

function getLevelInfo(user) {
  const level = db.getLevel(user.xp);
  const currentFloor = db.xpForLevel(level);
  const nextCeil = db.xpForLevel(level + 1);
  const progress = nextCeil > currentFloor ? (user.xp - currentFloor) / (nextCeil - currentFloor) : 1;
  return {
    level, xp: user.xp, currentFloor, nextCeil, progress: db.clamp(progress, 0, 1),
    bonuses: cfg.LEVEL_BONUSES.filter((item) => level >= item.level),
  };
}

// ---------- Inventario: artículos del eventshop comprados pero sin activar ----------
// Solo cuenta lo que la persona realmente compró (eventRolesPurchased) y todavía no activó
// (eventRolesActivated). Tener el rol de Discord por otra vía NO lo convierte en "poseído".

function getPendingEventItems(user, now = new Date()) {
  const purchased = Array.isArray(user.eventRolesPurchased) ? user.eventRolesPurchased : [];
  const activated = new Set(Array.isArray(user.eventRolesActivated) ? user.eventRolesActivated : []);
  return cfg.EVENT_SHOP
    .filter((role) => purchased.includes(role.roleId) && !activated.has(role.roleId))
    .map((role) => ({
      id: role.id,
      name: role.name,
      roleId: role.roleId,
      activationCost: Math.ceil(role.price / 2),
      eventActive: now >= cfg.EVENT_START && now < cfg.EVENT_END,
      eventEnded: now >= cfg.EVENT_END,
    }));
}

// ---------- RPG: hoja de personaje (bonos acumulados + XP por acción a tu nivel) ----------

const BONUS_LABELS = [
  ['workReward', 'Recompensa de work, scavenge y harvest'],
  ['huntReward', 'Recompensa de hunt'],
  ['huntChance', 'Éxito en hunt'],
  ['crimeChance', 'Éxito en crime'],
  ['crimeReward', 'Recompensa de crime'],
  ['robChance', 'Éxito en rob'],
  ['robAmount', 'Candys robados con rob'],
  ['duelChance', 'Éxito en duel'],
  ['questReward', 'Recompensa de quest y candyraid'],
  ['begReward', 'Recompensa de beg'],
  ['bankFee', 'Menos comisión al retirar'],
  ['debtReduction', 'Menos deuda al fallar'],
  ['cooldownReduction', 'Menos cooldown'],
  ['casinoPayout', 'Premio extra en el casino'],
];

const SKILL_XP_ACTIONS = ['work', 'hunt', 'dungeon', 'boss', 'train'];

function getSkillSheet(user) {
  const level = db.getLevel(user.xp);
  const bonuses = BONUS_LABELS
    .map(([key, label]) => ({ key, label, value: permanentBonus(user, key) }))
    .filter((item) => item.value > 0);
  const xp = SKILL_XP_ACTIONS.map((action) => ({ action, ...xpRangeAtLevel(action, level) }));
  const weapon = user.equippedWeapon ? weaponDef(user.equippedWeapon) || null : null;
  const cls = user.class ? classDef(user.class) || null : null;
  return {
    level, factor: xpLevelFactor(level), class: cls, weapon, bonuses, xp, info: getLevelInfo(user),
  };
}

// ---------- Evento mundial aleatorio ----------

let worldEvent = null; // { channelId, endsAt, participants: Set, template }

function isWorldEventActive() {
  return !!worldEvent && Date.now() < worldEvent.endsAt;
}

function hasWorldEvent() {
  return !!worldEvent;
}

function registerWorldEventParticipant(channelId, userId) {
  if (isWorldEventActive() && worldEvent.channelId === channelId) {
    worldEvent.participants.add(userId);
    return true;
  }
  return false;
}

function startWorldEvent(channelId, template) {
  worldEvent = {
    channelId,
    endsAt: Date.now() + cfg.WORLD_EVENT_DURATION_MS,
    participants: new Set(),
    template,
  };
  return worldEvent;
}

function cancelWorldEvent() {
  if (!worldEvent) return false;
  worldEvent = null;
  return true;
}

function resolveWorldEvent() {
  if (!worldEvent) return null;
  const participantIds = [...worldEvent.participants];
  const winnerId = participantIds.length
    ? participantIds[Math.floor(Math.random() * participantIds.length)]
    : null;
  const otherCount = Math.max(1, participantIds.length - 1);
  const otherReward = participantIds.length > 1
    ? Math.min(
      cfg.WORLD_EVENT_OTHER_REWARD_MAX,
      Math.floor((cfg.WORLD_EVENT_MAX_TOTAL_REWARD - cfg.WORLD_EVENT_MAIN_REWARD) / otherCount),
    )
    : 0;
  const rewards = [];
  for (const id of participantIds) {
    const user = db.getUser(id);
    const isWinner = id === winnerId;
    const amount = isWinner ? cfg.WORLD_EVENT_MAIN_REWARD : otherReward;
    user.cash += amount;
    db.markDirty(user);
    rewards.push({ id, amount, isWinner });
  }
  const totalReward = rewards.reduce((sum, reward) => sum + reward.amount, 0);
  const result = { template: worldEvent.template, rewards, winnerId, totalReward };
  worldEvent = null;
  return result;
}

module.exports = {
  potionDef, classDef, weaponDef, effectBonus, hasEffect, permanentBonus, parseAmount,
  deposit, withdraw, transfer, payDebt, placeBounty,
  doWork, doBeg, doScavenge, doHarvest, doCandyRaid, doTrickOrTreat, doCrime,
  attemptRob,
  doHunt, doDungeon, doBoss, doQuest, doDaily, doInterest, doTrain,
  createDuelChallenge, getDuelChallenge, cancelDuelChallenge, claimDuelChallenge, resolveDuel,
  setClass, buyWeapon, equipWeapon,
  checkAchievements,
  gamble, slots, playDice, playRoulette, playWheel, normalizeRouletteColor,
  playCrash, drawCrashPoint, parseCrashTarget, casinoBonusFactor, weightedSymbol, slotsOutcome,
  startBlackjack, getBlackjack, bjHit, bjStand, bjResolve, endBlackjack, handValue, cardSuit, cardRank,
  bjCardsOnTable, bjCanHit,
  buyPotion, buyEventRole, activateEventRole, usePotion, refundEventRole, rollbackEventRoleActivation, collectEventIncome,
  bestActivatedRole, getEventRoleStatuses, getCollectRemaining, collectCooldownKey,
  redeemCode, recordActivity,
  xpRange, xpLevelFactor, xpRangeAtLevel, rollXp,
  isOwnerId, isOwnerUser, isTheftProtected, isSafeSum,
  getLeaderboard, getDebtLeaderboard, getRank, getServerStats, getLevelInfo,
  getPendingEventItems, getSkillSheet,
  isWorldEventActive, hasWorldEvent, registerWorldEventParticipant,
  startWorldEvent, cancelWorldEvent, resolveWorldEvent,
};
