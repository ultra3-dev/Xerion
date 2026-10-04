'use strict';

// ============================================================
//  ECONOMY — Toda la lógica de juego vive aquí, desacoplada de
//  discord.js. Recibe/devuelve datos planos; index.js se encarga
//  de leer argumentos y mandar mensajes.
// ============================================================

const cfg = require('./config');
const db = require('./database');

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

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
  if (!amount || amount <= 0) return { error: 'invalid' };
  if (amount > fromUser.cash) return { error: 'insufficient' };
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

// ---------- Robo ----------

function attemptRob(robber, target) {
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
    let amount = Math.round(target.cash * pct * (1 + effectBonus(robber, 'vampire') + permanentBonus(robber, 'robAmount')));
    amount = db.clamp(amount, 1, Math.min(target.cash, cfg.MAX_SINGLE_GAIN));
    target.cash -= amount;
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

function recordActivity(user, action) {
  const actionXp = cfg.XP_PER_ACTION[action] || 0;
  if (actionXp > 0) db.addXp(user, actionXp);
  const actionDropChance = {
    work: 0.35, beg: 0.15, crime: 0.35, scavenge: 0.55, harvest: 0.45,
    candyraid: 0.50, trickortreat: 0.30, rob: 0.35, hunt: 0.60,
    dungeon: 0.80, boss: 0.90, duel: 0.50, collect: 1,
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
      questXp = cfg.XP_PER_ACTION.quest || 0;
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

function weightedSymbol() {
  const total = cfg.SLOTS_SYMBOLS.reduce((s, x) => s + x.weight, 0);
  let r = Math.random() * total;
  for (const s of cfg.SLOTS_SYMBOLS) {
    if (r < s.weight) return s.symbol;
    r -= s.weight;
  }
  return cfg.SLOTS_SYMBOLS[0].symbol;
}

function slots(user, bet) {
  if (!Number.isSafeInteger(bet) || bet <= 0) return { error: 'invalid' };
  if (bet > user.cash) return { error: 'insufficient' };
  const reels = [weightedSymbol(), weightedSymbol(), weightedSymbol()];
  let multiplier = 0;
  if (reels[0] === reels[1] && reels[1] === reels[2]) {
    multiplier = cfg.SLOTS_RARE_SYMBOLS.includes(reels[0]) ? cfg.SLOTS_TRIPLE_RARE_MULT : cfg.SLOTS_TRIPLE_MULT;
  } else if (reels[0] === reels[1] || reels[1] === reels[2] || reels[0] === reels[2]) {
    multiplier = cfg.SLOTS_DOUBLE_MULT;
  }
  const payout = Math.round(bet * multiplier * (1 + effectBonus(user, 'pumpkin') + permanentBonus(user, 'casinoPayout')));
  if (!Number.isSafeInteger(payout) || !Number.isSafeInteger(user.cash - bet + payout)) return { error: 'balance_limit' };
  user.cash -= bet;
  user.cash += payout;
  if (payout > bet) db.incrementStat(user, 'casinoWins');
  db.markDirty(user);
  return { reels, payout, net: payout - bet };
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

function weightedRouletteColor() {
  const total = cfg.ROULETTE_COLORS.reduce((s, x) => s + x.weight, 0);
  let r = Math.random() * total;
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

function playRoulette(user, bet, colorChoice) {
  if (!Number.isSafeInteger(bet) || bet < cfg.ROULETTE_MIN_BET) return { error: 'invalid' };
  if (bet > user.cash) return { error: 'insufficient' };
  const choice = normalizeRouletteColor(colorChoice);
  const choiceDef = cfg.ROULETTE_COLORS.find((c) => c.id === choice && c.id !== 'calabaza');
  if (!choiceDef) return { error: 'invalid_color' };
  const used = consumeUse(user, 'roulette');
  if (used.error) return used;
  const landed = weightedRouletteColor();
  const win = landed.id === choice;
  let payout = 0;
  if (win) {
    payout = Math.round(bet * landed.mult * (1 + effectBonus(user, 'pumpkin') + permanentBonus(user, 'casinoPayout')));
    if (!Number.isSafeInteger(payout) || !Number.isSafeInteger(user.cash - bet + payout)) return { error: 'balance_limit' };
  }
  user.cash -= bet;
  if (win) {
    user.cash += payout;
    db.incrementStat(user, 'casinoWins');
  }
  db.markDirty(user);
  return {
    win, landed: landed.id, landedLabel: landed.label, payout, net: payout - bet,
  };
}

// ---------- Rueda de la fortuna ----------

function playWheel(user, bet) {
  if (!Number.isSafeInteger(bet) || bet < cfg.WHEEL_MIN_BET) return { error: 'invalid' };
  if (bet > user.cash) return { error: 'insufficient' };
  const used = consumeUse(user, 'wheel');
  if (used.error) return used;
  const total = cfg.WHEEL_SEGMENTS.reduce((s, x) => s + x.weight, 0);
  let r = Math.random() * total;
  let segment = cfg.WHEEL_SEGMENTS[cfg.WHEEL_SEGMENTS.length - 1];
  for (const s of cfg.WHEEL_SEGMENTS) {
    if (r < s.weight) { segment = s; break; }
    r -= s.weight;
  }
  const payout = Math.round(bet * segment.mult * (1 + effectBonus(user, 'pumpkin') + permanentBonus(user, 'casinoPayout')));
  if (!Number.isSafeInteger(payout) || !Number.isSafeInteger(user.cash - bet + payout)) return { error: 'balance_limit' };
  user.cash -= bet;
  user.cash += payout;
  if (payout > bet) db.incrementStat(user, 'casinoWins');
  db.markDirty(user);
  return { multiplier: segment.mult, payout, net: payout - bet };
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
    deck, player, dealer, bet, userId, status: 'playing', startedAt: Date.now(),
  };
  const naturalBJ = handValue(player) === 21;
  if (naturalBJ) game.status = 'stood';
  activeBlackjack.set(userId, game);
  return { game };
}

function getBlackjack(userId) { return activeBlackjack.get(userId); }

function bjHit(userId) {
  const g = activeBlackjack.get(userId);
  if (!g || g.status !== 'playing') return null;
  g.player.push(g.deck.pop());
  if (handValue(g.player) > 21) g.status = 'bust';
  return g;
}

function bjStand(userId) {
  const g = activeBlackjack.get(userId);
  if (!g || g.status !== 'playing') return g || null;
  while (handValue(g.dealer) < 17) g.dealer.push(g.deck.pop());
  g.status = 'stood';
  return g;
}

function bjResolve(user, g) {
  const pv = handValue(g.player);
  const dv = handValue(g.dealer);
  const naturalBJ = g.player.length === 2 && pv === 21;
  let result;
  let payout = 0;
  if (g.status === 'bust') {
    result = 'lose';
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
  return {
    result, payout, net: payout - g.bet, playerValue: pv, dealerValue: dv,
  };
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

function collectEventIncome(user, now = new Date()) {
  if (now < cfg.EVENT_START) return { error: 'notstarted' };
  if (now >= cfg.EVENT_END) return { error: 'ended' };
  const activated = new Set(Array.isArray(user.eventRolesActivated) ? user.eventRolesActivated : []);
  const eligibleRole = cfg.EVENT_SHOP
    .filter((role) => activated.has(role.roleId))
    .sort((a, b) => b.collectReward - a.collectReward)[0];
  if (!eligibleRole) return { error: 'no_eligible_role' };
  if (db.isOnCooldown(user, 'collect')) {
    return { error: 'cooldown', remaining: db.getCooldownRemaining(user, 'collect') };
  }

  const reward = Math.floor(eligibleRole.collectReward || 0);
  if (reward < 1) return { error: 'invalid_reward' };
  const cooldownMs = eligibleRole.collectCooldownMs || cfg.COOLDOWNS.collect;
  db.setCooldown(user, 'collect', cooldownMs);
  user.cash += reward;
  db.incrementStat(user, 'eventCollects');
  db.markDirty(user);
  return { reward, role: eligibleRole, cooldownMs, activity: recordActivity(user, 'collect') };
}

function redeemCode(userId, user, code, now = new Date()) {
  return db.redeemCode(userId, user, code, now);
}

// ---------- Rankings / estadísticas del servidor ----------

function getLeaderboard(limit = 10) {
  const users = db.getAllUsers();
  const arr = Object.entries(users).map(([id, u]) => ({ id, value: db.getTotal(u) }));
  arr.sort((a, b) => b.value - a.value);
  return arr.slice(0, limit);
}

function getDebtLeaderboard(limit = 10) {
  const users = db.getAllUsers();
  const arr = Object.entries(users).filter(([, u]) => u.debt > 0).map(([id, u]) => ({ id, value: u.debt }));
  arr.sort((a, b) => b.value - a.value);
  return arr.slice(0, limit);
}

function getRank(userId) {
  const lb = getLeaderboard(Infinity);
  const idx = lb.findIndex((e) => e.id === userId);
  return idx === -1 ? lb.length + 1 : idx + 1;
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
  doHunt, doDungeon, doBoss, doQuest, doDaily,
  createDuelChallenge, getDuelChallenge, cancelDuelChallenge, resolveDuel,
  setClass, buyWeapon, equipWeapon,
  checkAchievements,
  gamble, slots, playDice, playRoulette, playWheel, normalizeRouletteColor,
  startBlackjack, getBlackjack, bjHit, bjStand, bjResolve, endBlackjack, handValue, cardSuit, cardRank,
  buyPotion, buyEventRole, activateEventRole, usePotion, refundEventRole, rollbackEventRoleActivation, collectEventIncome,
  redeemCode, recordActivity,
  getLeaderboard, getDebtLeaderboard, getRank, getServerStats, getLevelInfo,
  isWorldEventActive, hasWorldEvent, registerWorldEventParticipant,
  startWorldEvent, cancelWorldEvent, resolveWorldEvent,
};
