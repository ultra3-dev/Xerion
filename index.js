'use strict';

require('dotenv').config();
const http = require('http');
const crypto = require('crypto');

// ============================================================
//  ÍNDICE — Cliente de Discord, listeners y los 50 comandos.
//  Prefijo: "xn" (sin distinguir mayúsculas). Toda la lógica de
//  economía vive en economy.js; todo el render en ui.js.
//  v1.0.0
// ============================================================

const {
  Client,
  GatewayIntentBits,
  MessageFlags,
  ActivityType,
} = require('discord.js');

const cfg = require('./config');
const db = require('./database');
const economy = require('./economy');
const ui = require('./ui');

if (!process.env.BOT_TOKEN) {
  console.error('❌ Falta BOT_TOKEN. Define la variable en .env o en el panel de Render.');
  process.exit(1);
}

const databaseReady = db.loadDB();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
});

// ---------- Helpers ----------

function stripMentionArgs(args) {
  return args.filter((a) => !/^<@!?\d+>$/.test(a));
}

// Solo este ID puede usar comandos de administración, sin importar
// permisos del servidor (pedido explícito: "solo esa persona, osea yo").
function isOwner(message) {
  return message.author.id === cfg.OWNER_ID;
}

function ownerOnlyCard() {
  return ui.errorCard(cfg, 'Solo el dueño del bot', 'Este comando solo lo puede usar el propietario configurado del bot.');
}

function activeEffectLines(dbUser) {
  const lines = [];
  for (const p of cfg.POTIONS) {
    const remaining = db.getEffectRemaining(dbUser, p.id);
    if (remaining > 0) {
      const stacks = db.getStacks(dbUser, p.id);
      lines.push(`${p.emoji} **${p.name}** x${stacks} — ${db.formatDuration(remaining)}`);
    }
  }
  return lines;
}

function countActiveEffects(dbUser) {
  return cfg.POTIONS.filter((p) => db.getEffectRemaining(dbUser, p.id) > 0).length;
}

function materialDropLine(result) {
  if (!result || !result.material) return '';
  return `\n🧱 Material encontrado: **+${result.material.qty} ${result.material.name}**.`;
}

// Sugiere la meta más barata de la tienda del evento que el usuario todavía
// no compró y no puede costear ahora mismo (para el balance avanzado).
function computeNextGoal(member, dbUser) {
  const spendableCash = dbUser.cash;
  const sorted = [...cfg.EVENT_SHOP].sort((a, b) => a.price - b.price);
  for (const item of sorted) {
    const alreadyPurchased = Array.isArray(dbUser.eventRolesPurchased) && dbUser.eventRolesPurchased.includes(item.roleId);
    if (!alreadyPurchased && spendableCash < item.price) {
      return { name: item.name, missing: item.price - spendableCash };
    }
  }
  return null;
}

// Solo quien fue autorizado (dueño del reto, jugador del blackjack, etc.)
// puede usar un botón — así nadie más "roba" la interacción de otro.
function checkButtonOwner(interaction, allowedId) {
  if (interaction.user.id !== allowedId) {
    interaction.reply({ content: 'Este botón no es tuyo.', flags: MessageFlags.Ephemeral }).catch(() => {});
    return false;
  }
  return true;
}

// ---------- Comandos ----------

const commands = {};

commands.balance = async (message, args, member, dbUser) => {
  const targetMember = message.mentions.members?.first() || member;
  const targetData = targetMember.id === message.author.id ? dbUser : db.getUser(targetMember.id);
  const extra = {
    rank: economy.getRank(targetMember.id),
    activeCount: countActiveEffects(targetData),
    nextGoal: computeNextGoal(targetMember, targetData),
  };
  return message.channel.send(ui.balanceCard(cfg, targetMember, targetData, extra));
};

commands.profile = async (message, args, member, dbUser) => {
  const targetMember = message.mentions.members?.first() || member;
  const targetData = targetMember.id === message.author.id ? dbUser : db.getUser(targetMember.id);
  const rank = economy.getRank(targetMember.id);
  const lines = activeEffectLines(targetData);
  return message.channel.send(ui.profileCard(cfg, targetMember, targetData, rank, lines));
};

commands.deposit = async (message, args, member, dbUser) => {
  const amount = economy.parseAmount(args[0], dbUser.cash);
  if (!amount) return message.channel.send(ui.errorCard(cfg, 'Cantidad inválida', `Usa \`${cfg.PREFIX} deposit <cantidad|all>\`.`));
  const result = economy.deposit(dbUser, amount);
  if (result.error === 'insufficient') return message.channel.send(ui.errorCard(cfg, 'No tienes eso en Cash', `Tu Cash es ${db.fmt(dbUser.cash)}${cfg.CANDY_EMOJI}.`));
  if (result.error) return message.channel.send(ui.errorCard(cfg, 'Cantidad inválida', `Usa \`${cfg.PREFIX} deposit <cantidad|all>\`.`));
  return message.channel.send(ui.successCard(cfg, 'Depósito realizado', `Guardaste **${db.fmt(result.amount)}**${cfg.CANDY_EMOJI} en el Banco. Ahí nadie puede robártelos.`));
};

commands.withdraw = async (message, args, member, dbUser) => {
  const amount = economy.parseAmount(args[0], dbUser.bank);
  if (!amount) return message.channel.send(ui.errorCard(cfg, 'Cantidad inválida', `Usa \`${cfg.PREFIX} withdraw <cantidad|all>\`.`));
  const result = economy.withdraw(dbUser, amount);
  if (result.error === 'insufficient') return message.channel.send(ui.errorCard(cfg, 'No tienes eso en el Banco', `Tu Bank es ${db.fmt(dbUser.bank)}${cfg.CANDY_EMOJI}.`));
  if (result.error) return message.channel.send(ui.errorCard(cfg, 'Cantidad inválida', `Usa \`${cfg.PREFIX} withdraw <cantidad|all>\`.`));
  const pctText = (result.feePct * 100).toFixed(1);
  return message.channel.send(ui.successCard(cfg, 'Retiro del banco', `Sacaste +${db.fmt(result.net)}${cfg.CANDY_EMOJI} del Banco y la Bruja de Halloween se quedó con el ${pctText}% (**${db.fmt(result.fee)}**${cfg.CANDY_EMOJI} de comisión).`));
};

commands.pay = async (message, args, member, dbUser) => {
  const targetMember = message.mentions.members?.first();
  if (!targetMember) return message.channel.send(ui.errorCard(cfg, 'Falta el destinatario', `Usa \`${cfg.PREFIX} pay @usuario <cantidad|all>\`.`));
  if (targetMember.id === message.author.id) return message.channel.send(ui.errorCard(cfg, 'No puedes pagarte a ti mismo', 'Elige a otra persona.'));
  if (targetMember.user.bot) return message.channel.send(ui.errorCard(cfg, 'No puedes pagarle a un bot', 'Los bots no usan Candys.'));
  const rest = stripMentionArgs(args);
  const amount = economy.parseAmount(rest[0], dbUser.cash);
  if (!amount) return message.channel.send(ui.errorCard(cfg, 'Cantidad inválida', `Usa \`${cfg.PREFIX} pay @usuario <cantidad|all>\`.`));
  const targetData = db.getUser(targetMember.id);
  const result = economy.transfer(dbUser, targetData, amount);
  if (result.error === 'insufficient') return message.channel.send(ui.errorCard(cfg, 'No tienes suficiente Cash', `Tu Cash es ${db.fmt(dbUser.cash)}${cfg.CANDY_EMOJI}.`));
  if (result.error) return message.channel.send(ui.errorCard(cfg, 'Cantidad inválida', `Usa \`${cfg.PREFIX} pay @usuario <cantidad|all>\`.`));
  return message.channel.send(ui.successCard(cfg, 'Transferencia enviada', `Le enviaste **${db.fmt(result.amount)}**${cfg.CANDY_EMOJI} a **${targetMember.displayName}**.`));
};

commands.work = async (message, args, member, dbUser) => {
  const result = economy.doWork(dbUser);
  if (result.error === 'cooldown') return message.channel.send(ui.errorCard(cfg, 'Todavía cansado', `Podrás trabajar de nuevo en ${db.formatDuration(result.remaining)}.`));
  return message.channel.send(ui.successCard(cfg, 'Trabajo terminado', `${result.flavor} y ganaste **+${db.fmt(result.reward)}**${cfg.CANDY_EMOJI}.${materialDropLine(result)}`));
};

commands.crime = async (message, args, member, dbUser) => {
  const result = economy.doCrime(dbUser);
  if (result.error === 'cooldown') return message.channel.send(ui.errorCard(cfg, 'Muy pronto', `Podrás intentarlo de nuevo en ${db.formatDuration(result.remaining)}.`));
  if (result.success) return message.channel.send(ui.successCard(cfg, '¡Crimen exitoso!', `${result.flavor} y ganaste **+${db.fmt(result.reward)}**${cfg.CANDY_EMOJI}.${materialDropLine(result)}`));
  if (result.revived) return message.channel.send(ui.infoCard(cfg, '¡Te salvaste!', `${result.flavor}, pero tu Elixir de Resurrección anuló la deuda justo a tiempo.`));
  return message.channel.send(ui.errorCard(cfg, '¡Te atraparon!', `${result.flavor}. La Bruja te dejó con **-${db.fmt(result.debtAmount)}**${cfg.CANDY_EMOJI} de deuda.`));
};

commands.beg = async (message, args, member, dbUser) => {
  const result = economy.doBeg(dbUser);
  if (result.error === 'cooldown') return message.channel.send(ui.errorCard(cfg, 'Espera un poco', `Podrás pedir de nuevo en ${db.formatDuration(result.remaining)}.`));
  if (result.reward === 0) return message.channel.send(ui.infoCard(cfg, 'Nada de nada', `${result.flavor}.`));
  return message.channel.send(ui.successCard(cfg, 'Consiguiste algo', `${result.flavor} y ganaste **+${db.fmt(result.reward)}**${cfg.CANDY_EMOJI}.${materialDropLine(result)}`));
};

commands.scavenge = async (message, args, member, dbUser) => {
  const result = economy.doScavenge(dbUser);
  if (result.error === 'cooldown') return message.channel.send(ui.errorCard(cfg, 'Agotaste la zona', `Podrás buscar dulces otra vez en ${db.formatDuration(result.remaining)}.`));
  return message.channel.send(ui.successCard(cfg, '¡Botín encontrado!', `${result.flavor} y conseguiste **+${db.fmt(result.reward)}**${cfg.CANDY_EMOJI}.${materialDropLine(result)}`));
};

commands.harvest = async (message, args, member, dbUser) => {
  const result = economy.doHarvest(dbUser);
  if (result.error === 'cooldown') return message.channel.send(ui.errorCard(cfg, 'El huerto necesita descansar', `Podrás cosechar dulces de nuevo en ${db.formatDuration(result.remaining)}.`));
  return message.channel.send(ui.successCard(cfg, '¡Cosecha embrujada!', `${result.flavor}\nConseguiste **+${db.fmt(result.reward)}**${cfg.CANDY_EMOJI}.${materialDropLine(result)}`));
};

commands.candyraid = async (message, args, member, dbUser) => {
  const result = economy.doCandyRaid(dbUser);
  if (result.error === 'cooldown') return message.channel.send(ui.errorCard(cfg, 'La pandilla necesita descansar', `Podrás unirte a otra cabalgata en ${db.formatDuration(result.remaining)}.`));
  if (result.success) return message.channel.send(ui.successCard(cfg, '¡Cabalgata de dulces!', `${result.flavor} y ganaste **+${db.fmt(result.reward)}**${cfg.CANDY_EMOJI}.${materialDropLine(result)}`));
  if (result.revived) return message.channel.send(ui.infoCard(cfg, '¡Te salvaste!', `${result.flavor} El Elixir de Resurrección anuló la deuda.`));
  return message.channel.send(ui.errorCard(cfg, 'La niebla se quedó con el botín', `${result.flavor}\nDeuda: **-${db.fmt(result.debtAmount)}**${cfg.CANDY_EMOJI}.`));
};

commands.trickortreat = async (message, args, member, dbUser) => {
  const result = economy.doTrickOrTreat(dbUser);
  if (result.error === 'cooldown') return message.channel.send(ui.errorCard(cfg, 'Ya pasaste hoy', `Vuelve a intentarlo en ${db.formatDuration(result.remaining)}.`));
  if (result.treat) return message.channel.send(ui.successCard(cfg, '¡Dulce!', `${result.flavor} y ganaste **+${db.fmt(result.reward)}**${cfg.CANDY_EMOJI}.${materialDropLine(result)}`));
  if (result.revived) return message.channel.send(ui.infoCard(cfg, '¡Truco esquivado!', `${result.flavor}, pero tu Elixir de Resurrección te salvó de la deuda.`));
  return message.channel.send(ui.errorCard(cfg, '¡Truco!', `${result.flavor}. Te quedaste con **-${db.fmt(result.debtAmount)}**${cfg.CANDY_EMOJI} de deuda.`));
};

commands.rob = async (message, args, member, dbUser) => {
  const targetMember = message.mentions.members?.first();
  if (!targetMember) return message.channel.send(ui.errorCard(cfg, 'Falta la víctima', `Menciona a alguien: \`${cfg.PREFIX} rob @usuario\`.`));
  if (targetMember.id === message.author.id) return message.channel.send(ui.errorCard(cfg, 'No puedes robarte a ti mismo', 'Busca otra víctima. 😈'));
  if (targetMember.user.bot) return message.channel.send(ui.errorCard(cfg, 'No puedes robar a un bot', 'Los bots no cargan Candys.'));
  const targetData = db.getUser(targetMember.id);
  const result = economy.attemptRob(dbUser, targetData);
  if (result.error === 'cooldown') return message.channel.send(ui.errorCard(cfg, 'Espera un poco', `Todavía estás bajo sospecha. Intenta de nuevo en ${db.formatDuration(result.remaining)}.`));
  if (result.error === 'target_too_poor') return message.channel.send(ui.errorCard(cfg, 'Objetivo sin nada que robar', 'Esa persona no tiene suficiente Cash para valer la pena.'));
  if (result.error === 'target_protected') return message.channel.send(ui.errorCard(cfg, 'Objetivo protegido', `Ya lo robaron hace poco. Espera ${db.formatDuration(result.remaining)}.`));
  if (result.error === 'target_shadow') return message.channel.send(ui.errorCard(cfg, 'No puedes verlo', 'Una Poción de las Sombras lo hace invisible ante los ladrones ahora mismo.'));
  if (result.success) {
    const bountyText = result.bountyClaimed > 0 ? ` 🎯 ¡También cobraste su recompensa de **+${db.fmt(result.bountyClaimed)}**${cfg.CANDY_EMOJI}!` : '';
    return message.channel.send(ui.successCard(cfg, '¡Robo exitoso!', `${result.flavor} de **${targetMember.displayName}** y conseguiste **+${db.fmt(result.amount)}**${cfg.CANDY_EMOJI}.${bountyText}`));
  }
  if (result.revived) return message.channel.send(ui.infoCard(cfg, '¡Casi te atrapan!', `${targetMember.displayName} ${result.flavor}, pero tu Elixir de Resurrección anuló la deuda justo a tiempo.`));
  return message.channel.send(ui.errorCard(cfg, '¡Te atraparon!', `${targetMember.displayName} ${result.flavor}. La Bruja te cobró **-${db.fmt(result.debtAmount)}**${cfg.CANDY_EMOJI} de deuda.`));
};

commands.debt = async (message, args, member, dbUser) => {
  const targetMember = message.mentions.members?.first();
  const rawId = (stripMentionArgs(args)[0] || '').replace(/[<@!>]/g, '');
  const targetId = targetMember?.id || rawId || message.author.id;
  if (!/^\d{15,22}$/.test(targetId)) {
    return message.channel.send(ui.errorCard(cfg, 'Usuario inválido', `Usa \`${cfg.PREFIX} debt [@usuario|ID]\`.`));
  }
  const targetData = targetId === message.author.id ? dbUser : db.getAllUsers()[targetId];
  if (!targetData) {
    return message.channel.send(ui.infoCard(cfg, 'Sin perfil', 'Esa persona todavía no tiene un perfil económico.'));
  }
  const label = targetId === message.author.id ? 'Tu deuda con la Bruja' : `Deuda de ${targetMember?.displayName || `<@${targetId}>`}`;
  if (targetData.debt <= 0) return message.channel.send(ui.successCard(cfg, 'Sin deudas', `${label}: **0**${cfg.CANDY_EMOJI}.`));
  return message.channel.send(ui.debtCard(cfg, label, `💀 **Debt:** -${db.fmt(targetData.debt)}${cfg.CANDY_EMOJI}${targetId === message.author.id ? `\n\nPágala con \`${cfg.PREFIX} paydebt [cantidad]\` antes de comprar en las tiendas.` : ''}`));
};

commands.paydebt = async (message, args, member, dbUser) => {
  if (dbUser.debt <= 0) return message.channel.send(ui.successCard(cfg, 'Sin deudas', 'No le debes nada a la Bruja. 🎉'));
  const amount = args[0] ? economy.parseAmount(args[0], Math.min(dbUser.cash, dbUser.debt)) : null;
  if (args[0] && !amount) return message.channel.send(ui.errorCard(cfg, 'Cantidad inválida', `Usa \`${cfg.PREFIX} paydebt [cantidad|all]\`.`));
  const result = economy.payDebt(dbUser, amount);
  if (result.error === 'insufficient') return message.channel.send(ui.errorCard(cfg, 'No tienes suficiente Cash', `Necesitas Candys en Cash para pagarle a la Bruja. Tu deuda es de ${db.fmt(dbUser.debt)}${cfg.CANDY_EMOJI}.`));
  if (result.error) return message.channel.send(ui.errorCard(cfg, 'Cantidad inválida', 'Revisa la cantidad ingresada.'));
  const pctText = (result.refundPct * 100).toFixed(1);
  return message.channel.send(ui.successCard(cfg, 'Pago a la Bruja', `Le pagaste **-${db.fmt(result.payAmount)}**${cfg.CANDY_EMOJI} de tu deuda. Ella, contenta, te devolvió el ${pctText}% (**+${db.fmt(result.refund)}**${cfg.CANDY_EMOJI}).\nDeuda restante: **${db.fmt(result.remainingDebt)}**${cfg.CANDY_EMOJI}.`));
};

commands.bounty = async (message, args, member, dbUser) => {
  const targetMember = message.mentions.members?.first();
  if (!targetMember) return message.channel.send(ui.errorCard(cfg, 'Falta el objetivo', `Usa \`${cfg.PREFIX} bounty @usuario <cantidad>\`.`));
  if (targetMember.id === message.author.id) return message.channel.send(ui.errorCard(cfg, 'No puedes poner recompensa sobre ti mismo', 'Elige a otra persona.'));
  if (targetMember.user.bot) return message.channel.send(ui.errorCard(cfg, 'No puedes poner recompensa a un bot', 'Los bots no cargan Candys.'));
  const rest = stripMentionArgs(args);
  const amount = economy.parseAmount(rest[0], dbUser.cash);
  if (!amount) return message.channel.send(ui.errorCard(cfg, 'Cantidad inválida', `Usa \`${cfg.PREFIX} bounty @usuario <cantidad>\` (mínimo ${db.fmt(cfg.BOUNTY_MIN)}${cfg.CANDY_EMOJI}).`));
  const targetData = db.getUser(targetMember.id);
  const result = economy.placeBounty(dbUser, targetData, amount);
  if (result.error === 'too_small') return message.channel.send(ui.errorCard(cfg, 'Recompensa muy baja', `El mínimo es ${db.fmt(cfg.BOUNTY_MIN)}${cfg.CANDY_EMOJI}.`));
  if (result.error === 'insufficient') return message.channel.send(ui.errorCard(cfg, 'No tienes suficiente Cash', `Tu Cash es ${db.fmt(dbUser.cash)}${cfg.CANDY_EMOJI}.`));
  if (result.error === 'cooldown') return message.channel.send(ui.errorCard(cfg, 'Espera un poco', `Podrás poner otra recompensa en ${db.formatDuration(result.remaining)}.`));
  return message.channel.send(ui.successCard(cfg, '🎯 Recompensa activada', `Pusiste **-${db.fmt(result.amount)}**${cfg.CANDY_EMOJI} de recompensa sobre **${targetMember.displayName}**. Quien lo robe con éxito se la lleva completa.\nRecompensa total acumulada sobre esa persona: **${db.fmt(result.totalBounty)}**${cfg.CANDY_EMOJI}.`));
};

// ---------- RPG ----------

commands.class = async (message, args, member, dbUser) => {
  const id = args.join(' ').trim().toLowerCase();
  if (!id) return message.channel.send(ui.classListContainer(cfg, dbUser));
  const result = economy.setClass(dbUser, id);
  if (result.error === 'notfound') return message.channel.send(ui.errorCard(cfg, 'Clase no encontrada', `Revisa \`${cfg.PREFIX} class\` para ver las opciones.`));
  if (result.error === 'level_required') return message.channel.send(ui.errorCard(cfg, 'Clase bloqueada', `Necesitas llegar al **nivel ${result.level}** para elegir una clase. Tu nivel actual es **${db.getLevel(dbUser.xp)}**.`));
  if (result.error === 'already_chosen') return message.channel.send(ui.errorCard(cfg, 'Tu clase es permanente', 'Ya elegiste tu clase y no se puede cambiar.'));
  if (result.error === 'same_class') return message.channel.send(ui.infoCard(cfg, 'Ya elegiste esta clase', 'Tu elección es permanente y no se puede cambiar.'));
  if (result.error === 'cooldown') return message.channel.send(ui.errorCard(cfg, 'Todavía no puedes cambiar de clase', `Podrás cambiar en ${db.formatDuration(result.remaining)}.`));
  return message.channel.send(ui.successCard(cfg, 'Clase elegida', `Ahora eres ${result.classDef.emoji} **${result.classDef.name}**.\n${result.classDef.desc}`));
};

commands.hunt = async (message, args, member, dbUser) => {
  const result = economy.doHunt(dbUser);
  if (result.error === 'cooldown') return message.channel.send(ui.errorCard(cfg, 'Todavía cansado', `Podrás cazar de nuevo en ${db.formatDuration(result.remaining)}.`));
  if (result.success) return message.channel.send(ui.successCard(cfg, '¡Cacería exitosa!', `Cazaste a ${result.monster.emoji} **${result.monster.name}** y ganaste **+${db.fmt(result.reward)}**${cfg.CANDY_EMOJI}.${materialDropLine(result)}`));
  return message.channel.send(ui.errorCard(cfg, 'Se escapó...', `${result.monster.emoji} **${result.monster.name}** logró escapar. Sin recompensa esta vez.`));
};

commands.duel = async (message, args, member, dbUser) => {
  const targetMember = message.mentions.members?.first();
  if (!targetMember) return message.channel.send(ui.errorCard(cfg, 'Falta el rival', `Usa \`${cfg.PREFIX} duel @usuario <cantidad|all>\`.`));
  if (targetMember.id === message.author.id) return message.channel.send(ui.errorCard(cfg, 'No puedes retarte a ti mismo', 'Busca a otra persona.'));
  if (targetMember.user.bot) return message.channel.send(ui.errorCard(cfg, 'No puedes retar a un bot', 'Los bots no apuestan Candys.'));
  const rest = stripMentionArgs(args);
  const bet = economy.parseAmount(rest[0], dbUser.cash);
  if (!bet) return message.channel.send(ui.errorCard(cfg, 'Apuesta inválida', `Usa \`${cfg.PREFIX} duel @usuario <cantidad|all>\`.`));
  if (bet > dbUser.cash) return message.channel.send(ui.errorCard(cfg, 'No tienes eso en Cash', `Tu Cash es ${db.fmt(dbUser.cash)}${cfg.CANDY_EMOJI}.`));
  const targetData = db.getUser(targetMember.id);
  if (targetData.cash < bet) return message.channel.send(ui.errorCard(cfg, 'Tu rival no puede cubrir la apuesta', `${targetMember.displayName} no tiene suficiente Cash.`));

  const created = economy.createDuelChallenge(message.author.id, dbUser, targetMember.id, bet);
  if (created.error === 'cooldown') return message.channel.send(ui.errorCard(cfg, 'Espera un poco', `Podrás retar de nuevo en ${db.formatDuration(created.remaining)}.`));
  if (created.error === 'already_pending') return message.channel.send(ui.errorCard(cfg, 'Ya hay un reto pendiente', `${targetMember.displayName} ya tiene un duelo esperando respuesta.`));

  const c = ui.duelChallengeCard(cfg, member, targetMember, bet);
  const sent = await message.channel.send(ui.payload(c));

  setTimeout(async () => {
    const stillPending = economy.getDuelChallenge(targetMember.id);
    if (!stillPending || stillPending.challengerId !== message.author.id) return;
    economy.cancelDuelChallenge(targetMember.id);
    await sent.edit(ui.errorCard(cfg, 'Reto expirado', `${targetMember.displayName} no respondió a tiempo.`)).catch(() => {});
  }, cfg.DUEL_TIMEOUT_MS);
};

commands.dungeon = async (message, args, member, dbUser) => {
  const result = economy.doDungeon(dbUser);
  if (result.error === 'cooldown') return message.channel.send(ui.errorCard(cfg, 'Todavía explorando', `Podrás volver a entrar en ${db.formatDuration(result.remaining)}.`));
  if (result.success) return message.channel.send(ui.successCard(cfg, '¡Mazmorra superada!', `${result.flavor} y ganaste **+${db.fmt(result.reward)}**${cfg.CANDY_EMOJI}.${materialDropLine(result)}`));
  if (result.revived) return message.channel.send(ui.infoCard(cfg, '¡Te salvaste!', `${result.flavor}, pero tu Elixir de Resurrección anuló la deuda.`));
  return message.channel.send(ui.errorCard(cfg, 'La mazmorra te venció', `${result.flavor}. Quedaste con **-${db.fmt(result.debtAmount)}**${cfg.CANDY_EMOJI} de deuda.`));
};

commands.boss = async (message, args, member, dbUser) => {
  const result = economy.doBoss(dbUser);
  if (result.error === 'cooldown') return message.channel.send(ui.errorCard(cfg, 'El jefe sigue débil', `Podrás retarlo de nuevo en ${db.formatDuration(result.remaining)}.`));
  if (result.success) return message.channel.send(ui.successCard(cfg, `¡Derrotaste a ${cfg.BOSS_NAME}!`, `${cfg.BOSS_EMOJI} Ganaste **+${db.fmt(result.reward)}**${cfg.CANDY_EMOJI}.${materialDropLine(result)}`));
  if (result.revived) return message.channel.send(ui.infoCard(cfg, '¡Sobreviviste por poco!', `${cfg.BOSS_NAME} casi te vence, pero tu Elixir de Resurrección anuló la deuda.`));
  return message.channel.send(ui.errorCard(cfg, `${cfg.BOSS_NAME} te venció`, `Quedaste con **-${db.fmt(result.debtAmount)}**${cfg.CANDY_EMOJI} de deuda. Inténtalo de nuevo más tarde.`));
};

commands.quest = async (message, args, member, dbUser) => {
  const result = economy.doQuest(dbUser);
  if (result.error === 'cooldown') return message.channel.send(ui.errorCard(cfg, 'Misión ya entregada', `Vuelve en ${db.formatDuration(result.remaining)}.`));
  if (result.error === 'all_quests_done') return message.channel.send(ui.infoCard(cfg, 'Todas las misiones completadas', 'Ya completaste todas las misiones disponibles. No se repetirán.'));
  if (result.error) return message.channel.send(ui.errorCard(cfg, 'No se pudo cargar la misión', 'Inténtalo de nuevo más tarde.'));
  if (result.assigned) {
    return message.channel.send(ui.infoCard(
      cfg,
      'Nueva misión',
      `📜 **${result.mission.description}**\nProgreso: **0/${result.quest.target}**. Usa \`${cfg.PREFIX} quest\` para revisar tu progreso; la recompensa se entrega al completar la misión.`,
    ));
  }
  if (result.incomplete) {
    return message.channel.send(ui.infoCard(
      cfg,
      'Misión en progreso',
      `📜 ${result.mission.description}\nProgreso: **${result.quest.progress}/${result.quest.target}**. Sigue jugando y vuelve a revisar con \`${cfg.PREFIX} quest\`.`,
    ));
  }
  const bonusText = result.gotBonus ? '\n🎁 ¡Encontraste un botín extra en el camino!' : '';
  return message.channel.send(ui.successCard(cfg, 'Misión completada', `${result.flavor} y ganaste **+${db.fmt(result.total)}**${cfg.CANDY_EMOJI}.${bonusText}${materialDropLine(result)}`));
};

commands.level = async (message, args, member, dbUser) => message.channel.send(ui.levelCard(cfg, member, dbUser));

commands.achievements = async (message, args, member, dbUser) => message.channel.send(ui.achievementsContainer(cfg, member, dbUser));

commands.armory = async (message, args, member, dbUser) => message.channel.send(ui.armoryContainer(cfg, dbUser, message.author.id));

commands.equip = async (message, args, member, dbUser) => {
  const id = (args[0] || '').toLowerCase();
  if (!id) return message.channel.send(ui.errorCard(cfg, 'Falta el arma', `Usa \`${cfg.PREFIX} equip <id>\`. Revisa \`${cfg.PREFIX} inventory\`.`));
  const result = economy.equipWeapon(dbUser, id);
  if (result.error === 'notfound') return message.channel.send(ui.errorCard(cfg, 'Arma no encontrada', `Revisa los IDs con \`${cfg.PREFIX} armory\`.`));
  if (result.error === 'not_owned') return message.channel.send(ui.errorCard(cfg, 'No tienes esa arma', `Cómprala primero con \`${cfg.PREFIX} buy ${id}\`.`));
  return message.channel.send(ui.successCard(cfg, 'Arma equipada', `Ahora llevas equipada: ${result.weapon.emoji} **${result.weapon.name}**.`));
};

// ---------- Casino / RNG ----------

commands.gamble = async (message, args, member, dbUser) => {
  const bet = economy.parseAmount(args[0], dbUser.cash);
  if (!bet) return message.channel.send(ui.errorCard(cfg, 'Apuesta inválida', `Usa \`${cfg.PREFIX} gamble <cantidad|all>\`.`));
  const result = economy.gamble(dbUser, bet);
  if (result.error === 'insufficient') return message.channel.send(ui.errorCard(cfg, 'No tienes eso en Cash', `Tu Cash es ${db.fmt(dbUser.cash)}${cfg.CANDY_EMOJI}.`));
  if (result.error) return message.channel.send(ui.errorCard(cfg, 'Apuesta inválida', 'Ingresa una cantidad válida.'));
  if (result.win) return message.channel.send(ui.successCard(cfg, '¡Ganaste el doble o nada!', `La Bruja se equivocó de hechizo. Ganaste **+${db.fmt(result.net)}**${cfg.CANDY_EMOJI} (recibiste ${db.fmt(result.payout)}${cfg.CANDY_EMOJI}).`));
  return message.channel.send(ui.errorCard(cfg, 'Perdiste', `La Bruja se quedó con tus **-${db.fmt(result.lost)}**${cfg.CANDY_EMOJI}. Suerte para la próxima.`));
};

commands.slots = async (message, args, member, dbUser) => {
  const bet = economy.parseAmount(args[0], dbUser.cash);
  if (!bet) return message.channel.send(ui.errorCard(cfg, 'Apuesta inválida', `Usa \`${cfg.PREFIX} slots <cantidad|all>\`.`));
  if (bet > dbUser.cash) return message.channel.send(ui.errorCard(cfg, 'No tienes eso en Cash', `Tu Cash es ${db.fmt(dbUser.cash)}${cfg.CANDY_EMOJI}.`));
  const result = economy.slots(dbUser, bet);
  const sent = await message.channel.send(ui.slotsFrame(cfg, ['🌀', '🌀', '🌀'], { spinning: true }));
  const randomFrame = () => [0, 0, 0].map(() => cfg.SLOTS_SYMBOLS[Math.floor(Math.random() * cfg.SLOTS_SYMBOLS.length)].symbol);
  await new Promise((r) => setTimeout(r, 700));
  await sent.edit(ui.slotsFrame(cfg, randomFrame(), { spinning: true })).catch(() => {});
  await new Promise((r) => setTimeout(r, 700));
  await sent.edit(ui.slotsFrame(cfg, result.reels, { spinning: false, payout: result.payout, bet })).catch(() => {});
};

commands.blackjack = async (message, args, member, dbUser) => {
  const bet = economy.parseAmount(args[0], dbUser.cash);
  if (!bet) return message.channel.send(ui.errorCard(cfg, 'Apuesta inválida', `Usa \`${cfg.PREFIX} blackjack <cantidad|all>\`.`));
  const startResult = economy.startBlackjack(message.author.id, dbUser, bet);
  if (startResult.error === 'already_playing') return message.channel.send(ui.errorCard(cfg, 'Ya tienes una partida abierta', 'Termina tu blackjack actual con los botones antes de iniciar otro.'));
  if (startResult.error === 'insufficient') return message.channel.send(ui.errorCard(cfg, 'No tienes eso en Cash', `Tu Cash es ${db.fmt(dbUser.cash)}${cfg.CANDY_EMOJI}.`));
  if (startResult.error) return message.channel.send(ui.errorCard(cfg, 'Apuesta inválida', 'Ingresa una cantidad válida.'));
  const { game } = startResult;

  if (game.status === 'stood') {
    const resolution = economy.bjResolve(dbUser, game);
    const color = resolution.result === 'blackjack' ? cfg.COLORS.SUCCESS : cfg.COLORS.GOLD;
    const footer = resolution.result === 'blackjack'
      ? `¡Blackjack natural! Ganaste **+${db.fmt(resolution.net)}**${cfg.CANDY_EMOJI}.`
      : 'Empate con el dealer. Recuperaste tu apuesta.';
    const c = ui.blackjackCard(cfg, member, game, { hideDealer: false, footer, color });
    return message.channel.send(ui.payload(c));
  }

  const c = ui.blackjackCard(cfg, member, game, { hideDealer: true, footer: 'Usa los botones para jugar. Tienes 90 segundos.' });
  c.addActionRowComponents(ui.blackjackButtons(message.author.id));
  const sent = await message.channel.send(ui.payload(c));

  setTimeout(async () => {
    const current = economy.getBlackjack(message.author.id);
    if (!current || current !== game) return; // ya se resolvió con los botones
    const resolved = economy.bjStand(message.author.id);
    if (!resolved) return;
    const resolution = economy.bjResolve(dbUser, resolved);
    const footerMap = {
      win: `⏰ Se acabó el tiempo y te plantaste automáticamente. ¡Ganaste! +${db.fmt(resolution.net)}${cfg.CANDY_EMOJI}`,
      blackjack: `⏰ Se acabó el tiempo. ¡Blackjack! +${db.fmt(resolution.net)}${cfg.CANDY_EMOJI}`,
      push: '⏰ Se acabó el tiempo y te plantaste automáticamente. Empate, recuperaste tu apuesta.',
      lose: `⏰ Se acabó el tiempo y te plantaste automáticamente. Perdiste **-${db.fmt(resolved.bet)}**${cfg.CANDY_EMOJI}.`,
    };
    const colorMap = {
      win: cfg.COLORS.SUCCESS, blackjack: cfg.COLORS.SUCCESS, push: cfg.COLORS.GOLD, lose: cfg.COLORS.ERROR,
    };
    const c2 = ui.blackjackCard(cfg, member, resolved, { hideDealer: false, footer: footerMap[resolution.result], color: colorMap[resolution.result] });
    await sent.edit(ui.payload(c2)).catch(() => {});
  }, cfg.BLACKJACK_TIMEOUT_MS);

  return sent;
};

commands.dice = async (message, args, member, dbUser) => {
  const bet = economy.parseAmount(args[0], dbUser.cash);
  const guess = Number(args[1]);
  if (!bet) return message.channel.send(ui.errorCard(cfg, 'Apuesta inválida', `Usa \`${cfg.PREFIX} dice <cantidad> <1-6>\`.`));
  if (!Number.isInteger(guess) || guess < 1 || guess > 6) return message.channel.send(ui.errorCard(cfg, 'Número inválido', `Elige un número entero del 1 al 6: \`${cfg.PREFIX} dice <cantidad> <1-6>\`.`));
  if (bet > dbUser.cash) return message.channel.send(ui.errorCard(cfg, 'No tienes eso en Cash', `Tu Cash es ${db.fmt(dbUser.cash)}${cfg.CANDY_EMOJI}.`));
  const result = economy.playDice(dbUser, bet, guess);
  return message.channel.send(ui.diceResultCard(cfg, bet, result));
};

const ROULETTE_BETTABLE = () => cfg.ROULETTE_COLORS.filter((c) => c.id !== 'calabaza');

commands.roulette = async (message, args, member, dbUser) => {
  const bet = economy.parseAmount(args[0], dbUser.cash);
  const rawChoice = (args[1] || '').toLowerCase();
  const choice = economy.normalizeRouletteColor(rawChoice);
  if (!bet) return message.channel.send(ui.errorCard(cfg, 'Apuesta inválida', `Usa \`${cfg.PREFIX} roulette <cantidad|all> <red|black|purple|green>\` (mínimo ${db.fmt(cfg.ROULETTE_MIN_BET)}${cfg.CANDY_EMOJI}, sin máximo).`));
  if (bet < cfg.ROULETTE_MIN_BET) return message.channel.send(ui.errorCard(cfg, 'Apuesta por debajo del mínimo', `La apuesta mínima es **${db.fmt(cfg.ROULETTE_MIN_BET)}**${cfg.CANDY_EMOJI}.`));
  if (!ROULETTE_BETTABLE().some((c) => c.id === choice)) return message.channel.send(ui.errorCard(cfg, 'Color inválido', 'Elige `red`/`naranja`, `black`/`negro`, `purple`/`morado` o `green`/`verde`.'));
  if (bet > dbUser.cash) return message.channel.send(ui.errorCard(cfg, 'No tienes eso en Cash', `Tu Cash es ${db.fmt(dbUser.cash)}${cfg.CANDY_EMOJI}.`));
  const result = economy.playRoulette(dbUser, bet, choice);
  if (result.error === 'cooldown') return message.channel.send(ui.errorCard(cfg, 'La ruleta necesita enfriarse', `Podrás apostar otra vez en ${db.formatDuration(result.remaining)}.`));
  if (result.error) return message.channel.send(ui.errorCard(cfg, 'No se pudo apostar', 'Revisa el color y la apuesta mínima.'));
  const sent = await message.channel.send(ui.rouletteSpinCard(cfg, bet, 0));
  for (let frame = 1; frame <= 3; frame += 1) {
    await new Promise((resolve) => setTimeout(resolve, 700));
    await sent.edit(ui.rouletteSpinCard(cfg, bet, frame)).catch(() => {});
  }
  return sent.edit(ui.rouletteResultCard(cfg, bet, choice, result)).catch(() => sent);
};

commands.wheel = async (message, args, member, dbUser) => {
  const bet = economy.parseAmount(args[0], dbUser.cash);
  if (!bet) return message.channel.send(ui.errorCard(cfg, 'Apuesta inválida', `Usa \`${cfg.PREFIX} wheel <cantidad|all>\` (mínimo ${db.fmt(cfg.WHEEL_MIN_BET)}${cfg.CANDY_EMOJI}, sin máximo).`));
  if (bet < cfg.WHEEL_MIN_BET) return message.channel.send(ui.errorCard(cfg, 'Apuesta por debajo del mínimo', `La apuesta mínima es **${db.fmt(cfg.WHEEL_MIN_BET)}**${cfg.CANDY_EMOJI}.`));
  const result = economy.playWheel(dbUser, bet);
  if (result.error === 'cooldown') return message.channel.send(ui.errorCard(cfg, 'La rueda está girando', `Podrás jugar otra vez en ${db.formatDuration(result.remaining)}.`));
  if (result.error === 'insufficient') return message.channel.send(ui.errorCard(cfg, 'No tienes eso en Cash', `Tu Cash es ${db.fmt(dbUser.cash)}${cfg.CANDY_EMOJI}.`));
  if (result.error) return message.channel.send(ui.errorCard(cfg, 'Apuesta inválida', 'Ingresa una cantidad mayor que cero.'));
  const sent = await message.channel.send(ui.wheelSpinCard(cfg, bet, 0));
  for (let frame = 1; frame <= 3; frame += 1) {
    await new Promise((resolve) => setTimeout(resolve, 700));
    await sent.edit(ui.wheelSpinCard(cfg, bet, frame)).catch(() => {});
  }
  return sent.edit(ui.wheelResultCard(cfg, bet, result)).catch(() => sent);
};

// ---------- Tiendas ----------

commands.shop = async (message) => message.channel.send(ui.privateShopPrompt(cfg, 'shop', message.author.id));

commands.eventshop = async (message) => message.channel.send(ui.privateShopPrompt(cfg, 'eventshop', message.author.id));

// Lógica de compra compartida entre el comando de texto `buy` y el botón
// "Comprar" de las tiendas (shop/armory/eventshop) — un solo lugar, sin
// duplicar reglas entre los dos caminos.
async function executeBuy(id, dbUser, member, qty) {
  const potion = cfg.POTIONS.find((p) => p.id === id);
  if (potion) {
    const result = economy.buyPotion(dbUser, id, qty || 1);
    if (result.error === 'debt') return ui.debtCard(cfg, 'Tienes una deuda pendiente', `Debes pagarle a la Bruja antes de comprar. Usa \`${cfg.PREFIX} paydebt\`.`);
    if (result.error === 'insufficient') return ui.errorCard(cfg, 'No tienes suficientes Candys', `Tienes ${db.fmt(dbUser.cash)}${cfg.CANDY_EMOJI}.`);
    if (result.error) return ui.errorCard(cfg, 'No se pudo comprar', 'Intenta de nuevo.');
    return ui.successCard(cfg, 'Compra realizada', `Compraste **${result.quantity}x ${result.potion.emoji} ${result.potion.name}** por **-${db.fmt(result.totalCost)}**${cfg.CANDY_EMOJI}.\nActívala con \`${cfg.PREFIX} use ${result.potion.id}\`.`);
  }

  const weapon = cfg.WEAPONS.find((w) => w.id === id);
  if (weapon) {
    const result = economy.buyWeapon(dbUser, id);
    if (result.error === 'already_owned') return ui.errorCard(cfg, 'Ya tienes esa arma', `Equípala con \`${cfg.PREFIX} equip ${id}\`.`);
    if (result.error === 'debt') return ui.debtCard(cfg, 'Tienes una deuda pendiente', `Debes pagarle a la Bruja antes de comprar. Usa \`${cfg.PREFIX} paydebt\`.`);
    if (result.error === 'insufficient') return ui.errorCard(cfg, 'No tienes suficientes Candys', `Tienes ${db.fmt(dbUser.cash)}${cfg.CANDY_EMOJI}.`);
    if (result.error) return ui.errorCard(cfg, 'No se pudo comprar', 'Intenta de nuevo.');
    return ui.successCard(cfg, '¡Arma conseguida!', `Compraste ${result.weapon.emoji} **${result.weapon.name}** por **-${db.fmt(result.weapon.price)}**${cfg.CANDY_EMOJI}.\nEquípala con \`${cfg.PREFIX} equip ${id}\`.`);
  }

  const eventItem = cfg.EVENT_SHOP.find((r) => r.id === id);
  if (eventItem) {
    const alreadyPurchased = Array.isArray(dbUser.eventRolesPurchased)
      && dbUser.eventRolesPurchased.includes(eventItem.roleId);
    const alreadyHasRole = member && member.roles && member.roles.cache
      && member.roles.cache.has(eventItem.roleId);
    if (alreadyPurchased) {
      return ui.infoCard(cfg, 'Ese rol ya fue comprado', 'Cada rol de evento solo se puede comprar una vez por usuario.');
    }
    const activation = !!alreadyHasRole;
    const result = economy.buyEventRole(new Date(), dbUser, id, { activation });
    if (result.error === 'notstarted') return ui.errorCard(cfg, 'El evento no ha comenzado', 'Vuelve el 3 de octubre de 2026.');
    if (result.error === 'ended') return ui.errorCard(cfg, 'El evento ya terminó', 'Gracias por participar. 🎃');
    if (result.error === 'debt') return ui.debtCard(cfg, 'Tienes una deuda pendiente', `Debes pagarle a la Bruja antes de comprar. Usa \`${cfg.PREFIX} paydebt\`.`);
    if (result.error === 'insufficient') return ui.errorCard(cfg, 'No tienes suficientes Candys', `Tienes ${db.fmt(dbUser.cash)}${cfg.CANDY_EMOJI}.`);
    if (result.error === 'materials') {
      const list = result.missingMaterials.map((item) => `• ${item.name}: necesitas ${item.required}, tienes ${item.owned}`).join('\n');
      return ui.errorCard(cfg, 'Te faltan materiales', `${list}\n\nCosto en Candys: **${db.fmt(result.cashCost)}**${cfg.CANDY_EMOJI}. Consigue materiales jugando y vuelve a intentarlo.`);
    }
    if (result.error === 'already_owned') return ui.infoCard(cfg, 'Ese rol ya fue comprado', 'Cada rol de evento solo se puede comprar una vez por usuario.');
    if (result.error) return ui.errorCard(cfg, 'No se pudo comprar', 'Intenta de nuevo.');
    if (!await db.saveDB()) {
      economy.refundEventRole(dbUser, result.role, result);
      await db.saveDB();
      return ui.errorCard(cfg, 'No se pudo guardar la compra', 'La compra fue revertida porque no pude guardarla en la base de datos.');
    }
    if (!alreadyHasRole) {
      try {
        await member.roles.add(result.role.roleId);
      } catch (err) {
        console.error('[buy] No se pudo asignar el rol:', err);
        economy.refundEventRole(dbUser, result.role, result);
        await db.saveDB();
        return ui.errorCard(cfg, 'No se pudo entregar el rol', 'Te devolví tus Candys. Revisa que mi rol esté por encima del rol comprado y que tenga permiso de Gestionar Roles.');
      }
    }
    const status = alreadyHasRole
      ? 'El rol que ya tenías quedó activado para generar ingresos.'
      : `Ahora tienes <@&${result.role.roleId}>.`;
    const materialSummary = Object.entries(result.materialsCost)
      .map(([materialId, qty]) => `${qty} ${(cfg.MATERIALS.find((item) => item.id === materialId) || { name: materialId }).name}`)
      .join(', ');
    const hours = Math.round(result.role.collectCooldownMs / (60 * 60 * 1000));
    return ui.successCard(cfg, '¡Beneficio activado!', `${status}\nPagaste **-${db.fmt(result.cashCost)}**${cfg.CANDY_EMOJI}${result.activation ? ' (precio de activación)' : ''} y entregaste: ${materialSummary}.\nUsa \`${cfg.PREFIX} collect\` cada **${hours} horas** para reclamar **${db.fmt(result.role.collectReward)}**${cfg.CANDY_EMOJI}.`);
  }

  return ui.errorCard(cfg, 'Item no encontrado', `Revisa el ID con \`${cfg.PREFIX} shop\`, \`${cfg.PREFIX} armory\` o \`${cfg.PREFIX} eventshop\`.`);
}

commands.buy = async (message, args, member, dbUser) => {
  const id = (args[0] || '').toLowerCase();
  if (!id) return message.channel.send(ui.errorCard(cfg, 'Falta el ID', `Usa \`${cfg.PREFIX} shop\`, \`${cfg.PREFIX} armory\` o \`${cfg.PREFIX} eventshop\` para ver los IDs.`));
  const qtyRaw = args[1] ? Number(args[1]) : 1;
  if (!Number.isSafeInteger(qtyRaw) || qtyRaw < 1 || qtyRaw > 99) {
    return message.channel.send(ui.errorCard(cfg, 'Cantidad inválida', 'Puedes comprar entre 1 y 99 pociones por comando.'));
  }
  const qty = qtyRaw;
  const resultPayload = await executeBuy(id, dbUser, member, qty);
  return message.channel.send(resultPayload);
};

commands.use = async (message, args, member, dbUser) => {
  const id = (args[0] || '').toLowerCase();
  if (!id) return message.channel.send(ui.errorCard(cfg, 'Falta la poción', `Usa \`${cfg.PREFIX} use <id>\`. Revisa \`${cfg.PREFIX} inventory\`.`));
  const result = economy.usePotion(dbUser, id);
  if (result.error === 'notfound') return message.channel.send(ui.errorCard(cfg, 'Poción no encontrada', `Revisa los IDs con \`${cfg.PREFIX} potions\`.`));
  if (result.error === 'none_owned') return message.channel.send(ui.errorCard(cfg, 'No tienes esa poción', `Cómprala primero con \`${cfg.PREFIX} buy ${id}\`.`));
  return message.channel.send(ui.successCard(cfg, 'Poción activada', `${result.potion.emoji} **${result.potion.name}** activa con **${result.stacks}** carga(s) por los próximos minutos.`));
};

commands.potions = async (message) => message.channel.send(ui.potionsInfoContainer(cfg));

commands.inventory = async (message, args, member, dbUser) => {
  const targetMember = message.mentions.members?.first() || member;
  const targetData = targetMember.id === message.author.id ? dbUser : db.getUser(targetMember.id);
  return message.channel.send(ui.inventoryContainer(cfg, targetMember, targetData));
};

// ---------- Información ----------

commands.leaderboard = async (message) => {
  const entries = economy.getLeaderboard(100);
  return message.channel.send(ui.leaderboardContainer(cfg, 'rich', 0, entries, message.author.id));
};

commands.eventinfo = async (message) => message.channel.send(ui.eventInfoCard(cfg, new Date()));

commands.daily = async (message, args, member, dbUser) => {
  const result = economy.doDaily(dbUser, new Date());
  if (result.error === 'cooldown') return message.channel.send(ui.errorCard(cfg, 'Ya reclamaste hoy', `Vuelve en ${db.formatDuration(result.remaining)}.`));
  if (result.finale) {
    return message.channel.send(ui.successCard(cfg, '🎉 ¡Regalo de cierre del evento!', `${result.flavor}. Como el evento de Halloween termina hoy, la Bruja te dio un regalo especial: **+${db.fmt(result.total)}**${cfg.CANDY_EMOJI}.${materialDropLine(result)}`));
  }
  return message.channel.send(ui.successCard(cfg, 'Recompensa diaria', `${result.flavor} y ganaste **+${db.fmt(result.total)}**${cfg.CANDY_EMOJI}.${materialDropLine(result)}`));
};

commands.collect = async (message, args, member, dbUser) => {
  const result = economy.collectEventIncome(dbUser);
  if (result.error === 'notstarted') return message.channel.send(ui.errorCard(cfg, 'El evento aún no comienza', 'Los ingresos por roles se activan el 3 de octubre de 2026.'));
  if (result.error === 'ended') return message.channel.send(ui.infoCard(cfg, 'El evento terminó', 'Ya no se pueden reclamar ingresos de roles de este evento.'));
  if (result.error === 'no_eligible_role') {
    return message.channel.send(ui.errorCard(cfg, 'Beneficio sin activar', `Compra el rol desde \`${cfg.PREFIX} eventshop\` para activar sus ingresos. Tener el rol en Discord por sí solo no activa el beneficio.`));
  }
  if (result.error === 'cooldown') {
    return message.channel.send(ui.errorCard(cfg, 'Ya reclamaste el ingreso', `Vuelve en ${db.formatDuration(result.remaining)} para reclamar el ingreso de nuevo.`));
  }
  if (result.error) return message.channel.send(ui.errorCard(cfg, 'No se pudo reclamar', 'El ingreso configurado no es válido. Avísale al equipo del bot.'));
  return message.channel.send(ui.successCard(cfg, 'Ingreso del evento reclamado', `Tu rol **${result.role.name}** te entregó **+${db.fmt(result.reward)}**${cfg.CANDY_EMOJI}.\nVuelve en **${Math.round(result.cooldownMs / (60 * 60 * 1000))} horas**.${materialDropLine(result)}`));
};

commands.cooldowns = async (message, args, member, dbUser) => {
  const keys = [
    ['work', '💼 Work'], ['crime', '🕵️ Crime'], ['beg', '🙏 Beg'], ['scavenge', '🔎 Scavenge'], ['harvest', '🎃 Harvest'],
    ['candyraid', '🎠 Candy Raid'], ['trickortreat', '🍬 Trick or Treat'],
    ['daily', '🎁 Daily'], ['collect', '💰 Collect'], ['rob', '🥷 Rob'], ['hunt', '🏹 Hunt'], ['duel', '⚔️ Duel'],
    ['dungeon', '🗺️ Dungeon'], ['boss', '🎃 Boss'], ['quest', '📜 Quest'],
    ['roulette', '🎡 Roulette'], ['wheel', '🎡 Wheel'], ['bounty', '🎯 Bounty'],
  ];
  const lines = keys.map(([k, label]) => {
    const remaining = db.getCooldownRemaining(dbUser, k);
    const policy = cfg.COOLDOWN_POLICIES[k];
    const cycle = dbUser.cooldownCycles[k];
    if (remaining > 0) {
      const phase = cycle?.lastWasRest
        ? ' · descanso largo'
        : (policy ? ` · ciclo: ${cycle?.uses || 0}/${policy.uses} usos` : '');
      return `${label}: **${db.formatDuration(remaining)}**${phase}`;
    }
    return `${label}: ✅ Disponible${policy ? ` · ${policy.uses - (cycle?.uses || 0)} usos antes del descanso` : ''}`;
  });
  return message.channel.send(ui.cooldownsContainer(cfg, member, lines));
};

commands.serverstats = async (message) => message.channel.send(ui.serverStatsContainer(cfg, message.guild ? message.guild.name : 'Servidor', economy.getServerStats()));

commands.help = async (message, args) => message.channel.send(ui.helpContainer(cfg, (args[0] || '').toLowerCase(), message.author.id));

// ---------- Admin (solo cfg.OWNER_ID) ----------

commands.addcandy = async (message, args, member, dbUser) => {
  if (!isOwner(message)) return message.channel.send(ownerOnlyCard());
  const targetMember = message.mentions.members?.first();
  if (!targetMember) return message.channel.send(ui.errorCard(cfg, 'Falta el usuario', `Usa \`${cfg.PREFIX} addcandy @usuario <cantidad>\`.`));
  const rest = stripMentionArgs(args);
  if (!rest[0] || ['all', 'todo', 'max', 'everything'].includes(rest[0].toLowerCase())) {
    return message.channel.send(ui.errorCard(cfg, 'Cantidad inválida', 'Ingresa un número válido (no se acepta "all" aquí).'));
  }
  const amount = economy.parseAmount(rest[0], Number.MAX_SAFE_INTEGER);
  if (!amount || !Number.isFinite(amount)) return message.channel.send(ui.errorCard(cfg, 'Cantidad inválida', 'Ingresa un número válido (no se acepta "all" aquí).'));
  const targetData = db.getUser(targetMember.id);
  targetData.cash += amount;
  db.markDirty(targetData);
  return message.channel.send(ui.successCard(cfg, 'Candys añadidos', `Se le dieron **+${db.fmt(amount)}**${cfg.CANDY_EMOJI} en Cash a **${targetMember.displayName}**.`));
};

commands.removecandy = async (message, args, member, dbUser) => {
  if (!isOwner(message)) return message.channel.send(ownerOnlyCard());
  const targetMember = message.mentions.members?.first();
  if (!targetMember) return message.channel.send(ui.errorCard(cfg, 'Falta el usuario', `Usa \`${cfg.PREFIX} removecandy @usuario <cantidad>\`.`));
  const rest = stripMentionArgs(args);
  if (!rest[0] || ['all', 'todo', 'max', 'everything'].includes(rest[0].toLowerCase())) {
    return message.channel.send(ui.errorCard(cfg, 'Cantidad inválida', 'Ingresa un número válido (no se acepta "all" aquí).'));
  }
  const amount = economy.parseAmount(rest[0], Number.MAX_SAFE_INTEGER);
  if (!amount || !Number.isFinite(amount)) return message.channel.send(ui.errorCard(cfg, 'Cantidad inválida', 'Ingresa un número válido (no se acepta "all" aquí).'));
  const targetData = db.getUser(targetMember.id);
  targetData.cash = Math.max(0, targetData.cash - amount);
  db.markDirty(targetData);
  return message.channel.send(ui.successCard(cfg, 'Candys removidos', `Se le quitaron **-${db.fmt(amount)}**${cfg.CANDY_EMOJI} en Cash a **${targetMember.displayName}**.`));
};

commands.setdebt = async (message, args, member, dbUser) => {
  if (!isOwner(message)) return message.channel.send(ownerOnlyCard());
  const targetMember = message.mentions.members?.first();
  if (!targetMember) return message.channel.send(ui.errorCard(cfg, 'Falta el usuario', `Usa \`${cfg.PREFIX} setdebt @usuario <cantidad>\`.`));
  const rest = stripMentionArgs(args);
  if (!rest[0] || ['all', 'todo', 'max', 'everything'].includes(rest[0].toLowerCase())) {
    return message.channel.send(ui.errorCard(cfg, 'Cantidad inválida', 'Ingresa un número válido (0 para borrar la deuda, no se acepta "all").'));
  }
  const amount = rest[0] === '0' ? 0 : economy.parseAmount(rest[0], Number.MAX_SAFE_INTEGER);
  if (amount === null || amount === undefined || !Number.isFinite(amount)) return message.channel.send(ui.errorCard(cfg, 'Cantidad inválida', 'Ingresa un número válido (0 para borrar la deuda, no se acepta "all").'));
  const targetData = db.getUser(targetMember.id);
  targetData.debt = Math.max(0, amount);
  db.markDirty(targetData);
  return message.channel.send(ui.successCard(cfg, 'Deuda actualizada', `La deuda de **${targetMember.displayName}** ahora es **${db.fmt(targetData.debt)}**${cfg.CANDY_EMOJI}.`));
};

commands.redeem = async (message, args, member, dbUser) => {
  const code = (args[0] || '').trim();
  if (!code) return message.channel.send(ui.errorCard(cfg, 'Falta el código', `Usa \`${cfg.PREFIX} redeem <código>\` o \`${cfg.PREFIX} rc <código>\`. Necesitas nivel 10.`));
  if (db.getLevel(dbUser.xp) < 10) {
    return message.channel.send(ui.errorCard(cfg, 'Nivel insuficiente', `Necesitas llegar al **nivel 10** para canjear códigos. Tu nivel actual es **${db.getLevel(dbUser.xp)}**.`));
  }
  const result = await db.redeemCode(message.author.id, code);
  const errors = {
    notfound: ['Código inválido', 'Revisa el código e inténtalo de nuevo.'],
    expired: ['Código vencido', 'Este código ya pasó su fecha de expiración.'],
    exhausted: ['Código agotado', 'Este código ya alcanzó su límite de usos.'],
    already_redeemed: ['Código ya usado', 'Cada usuario solo puede canjear este código una vez.'],
    level_required: ['Nivel insuficiente', 'Necesitas llegar al nivel 10 para canjear códigos.'],
    balance_limit: ['Saldo máximo alcanzado', 'No se pudo añadir la recompensa porque excedería el saldo admitido.'],
    persistence_error: ['No se pudo guardar', 'El canje no se completó. Inténtalo de nuevo más tarde.'],
  };
  if (result.error) {
    const [title, body] = errors[result.error] || ['No se pudo canjear', 'Inténtalo de nuevo más tarde.'];
    return message.channel.send(ui.errorCard(cfg, title, body));
  }
  return message.channel.send(ui.successCard(cfg, 'Código canjeado', `**${result.code.toUpperCase()}** te entregó **+${db.fmt(result.reward)}**${cfg.CANDY_EMOJI}.`));
};

commands.resetuser = async (message, args) => {
  if (!isOwner(message)) return message.channel.send(ownerOnlyCard());
  const targetMember = message.mentions.members?.first();
  if (!targetMember) return message.channel.send(ui.errorCard(cfg, 'Falta el usuario', `Usa \`${cfg.PREFIX} resetuser @usuario\`.`));
  return message.channel.send(ui.confirmCard(
    cfg,
    '¿Reiniciar este perfil?',
    `Esto borrará TODO el progreso económico de **${targetMember.displayName}** (Cash, Bank, Debt, inventario, clase, arma, XP, cooldowns). Esta acción no se puede deshacer.`,
    `confirm:reset:${targetMember.id}`,
    `cancel:reset:${targetMember.id}`,
  ));
};

const ALIASES = {
  bal: 'balance',
  tot: 'trickortreat',
  sg: 'gamble',
  bj: 'blackjack',
  evshop: 'eventshop',
  inv: 'inventory',
  top: 'leaderboard',
  cd: 'cooldowns',
  ach: 'achievements',
  with: 'withdraw',
  dep: 'deposit',
  add: 'addcandy',
  rm: 'removecandy',
  sd: 'setdebt',
  reset: 'resetuser',
  rc: 'redeem',
  arm: 'armory',
  dg: 'dungeon',
  pd: 'paydebt',
  scav: 'scavenge',
  raid: 'candyraid',
  prof: 'profile',
  stats: 'serverstats',
  rl: 'roulette',
  einfo: 'eventinfo',
  bnt: 'bounty',
};

// ---------- Evento mundial aleatorio ----------

function scheduleWorldEvents() {
  setInterval(async () => {
    try {
      if (maintenanceMode) return;
      if (economy.isWorldEventActive()) return;
      if (Math.random() >= cfg.WORLD_EVENT_CHANCE) return;
      const channel = await client.channels.fetch(cfg.WORLD_EVENT_CHANNEL_ID).catch(() => null);
      if (!channel) return;
      const template = cfg.WORLD_EVENT_TEMPLATES[Math.floor(Math.random() * cfg.WORLD_EVENT_TEMPLATES.length)];
      economy.startWorldEvent(cfg.WORLD_EVENT_CHANNEL_ID, template);
      await channel.send(ui.worldEventStartCard(cfg, template));
      setTimeout(async () => {
        try {
          const result = economy.resolveWorldEvent();
          if (result) await channel.send(ui.worldEventResultCard(cfg, result));
        } catch (err) {
          console.error('[WorldEvent] Error al resolver:', err);
        }
      }, cfg.WORLD_EVENT_DURATION_MS);
    } catch (err) {
      console.error('[WorldEvent] Error:', err);
    }
  }, cfg.WORLD_EVENT_INTERVAL_MS);
}

// ---------- Eventos de Discord ----------

client.once('ready', () => {
  console.log(`✅ Bot conectado como ${client.user.tag} — v${cfg.BOT_VERSION}`);
  client.user.setPresence({
    activities: [{ name: `${cfg.PREFIX} help | 🍬 Halloween`, type: ActivityType.Watching }],
    status: 'online',
  });
  db.startAutoSave();
  scheduleWorldEvents();
  serviceReady = true;
});

client.on('messageCreate', async (message) => {
  try {
    if (message.author.bot || !message.guild) return;
    if (maintenanceMode) return message.channel.send(ui.infoCard(cfg, 'Mantenimiento', 'El bot está reiniciando el progreso. Intenta de nuevo en unos segundos.'));
    const { content } = message;
    const lower = content.toLowerCase();

    const dbUser = db.getUser(message.author.id);
    economy.earnFromMessage(dbUser);
    economy.registerWorldEventParticipant(message.channel.id, message.author.id);

    if (!lower.startsWith(cfg.PREFIX)) return;
    const afterPrefix = content.slice(cfg.PREFIX.length);
    if (afterPrefix.length > 0 && !/^\s/.test(afterPrefix)) return;

    const args = afterPrefix.trim().split(/\s+/).filter(Boolean);
    const cmdNameRaw = (args.shift() || '').toLowerCase();
    if (!cmdNameRaw) return;
    const cmdName = ALIASES[cmdNameRaw] || cmdNameRaw;
    const handler = commands[cmdName];
    if (!handler) return;

    await handler(message, args, message.member, dbUser);
  } catch (err) {
    console.error('[messageCreate] Error:', err);
    try {
      await message.channel.send(ui.errorCard(cfg, 'Ups, algo salió mal', 'Ocurrió un error inesperado ejecutando ese comando. Inténtalo de nuevo.'));
    } catch (_) { /* noop */ }
  }
});

client.on('interactionCreate', async (interaction) => {
  try {
    if (!interaction.isButton()) return;
    if (maintenanceMode) {
      return interaction.reply({ content: 'El bot está reiniciando el progreso. Intenta de nuevo en unos segundos.', flags: MessageFlags.Ephemeral });
    }
    const [ns, action, allowedId] = interaction.customId.split(':');

    if (ns === 'shopopen') {
      if (!checkButtonOwner(interaction, allowedId)) return;
      const dbUser = db.getUser(allowedId);
      const view = action === 'eventshop'
        ? ui.eventShopContainer(cfg, new Date(), interaction.member, allowedId, dbUser)
        : ui.shopContainer(cfg, allowedId);
      return interaction.reply({
        ...view,
        flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
      });
    }

    if (ns === 'help') {
      if (!checkButtonOwner(interaction, allowedId)) return;
      return interaction.update(ui.helpContainer(cfg, action, allowedId));
    }

    if (ns === 'top') {
      if (!checkButtonOwner(interaction, allowedId)) return;
      const parts = action.split('-');
      let mode;
      let page;
      if (parts[0] === 'prev' || parts[0] === 'next') {
        [, mode] = parts;
        page = parseInt(parts[2], 10) + (parts[0] === 'prev' ? -1 : 1);
      } else {
        [mode] = parts;
        page = 0;
      }
      const entries = mode === 'debt' ? economy.getDebtLeaderboard(100) : economy.getLeaderboard(100);
      return interaction.update(ui.leaderboardContainer(cfg, mode, page, entries, allowedId));
    }

    if (ns === 'shopbuy') {
      if (!checkButtonOwner(interaction, allowedId)) return;
      await interaction.deferReply({ flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2 });
      const dbUser = db.getUser(allowedId);
      const resultPayload = await executeBuy(action, dbUser, interaction.member, 1);
      if (cfg.EVENT_SHOP.some((item) => item.id === action)) {
        await interaction.message.edit(ui.eventShopContainer(cfg, new Date(), interaction.member, allowedId, dbUser)).catch(() => {});
      } else if (cfg.WEAPONS.some((item) => item.id === action)) {
        await interaction.message.edit(ui.armoryContainer(cfg, dbUser, allowedId)).catch(() => {});
      }
      return interaction.editReply(resultPayload);
    }

    if (ns === 'bj') {
      if (!checkButtonOwner(interaction, allowedId)) return;
      const dbUser = db.getUser(allowedId);
      const { member } = interaction;

      if (action === 'hit') {
        const game = economy.bjHit(allowedId);
        if (!game) return interaction.deferUpdate();
        if (game.status === 'bust') {
          economy.bjResolve(dbUser, game);
          const c = ui.blackjackCard(cfg, member, game, { hideDealer: false, footer: `Te pasaste de 21. Perdiste **-${db.fmt(game.bet)}**${cfg.CANDY_EMOJI}.`, color: cfg.COLORS.ERROR });
          return interaction.update(ui.payload(c));
        }
        const c = ui.blackjackCard(cfg, member, game, { hideDealer: true, footer: 'Usa los botones para jugar.' });
        c.addActionRowComponents(ui.blackjackButtons(allowedId));
        return interaction.update(ui.payload(c));
      }

      if (action === 'stand') {
        const game = economy.bjStand(allowedId);
        if (!game) return interaction.deferUpdate();
        const resolution = economy.bjResolve(dbUser, game);
        const footerMap = {
          win: `¡Ganaste! +${db.fmt(resolution.net)}${cfg.CANDY_EMOJI}`,
          blackjack: `¡Blackjack! +${db.fmt(resolution.net)}${cfg.CANDY_EMOJI}`,
          push: 'Empate. Recuperaste tu apuesta.',
          lose: `Perdiste **-${db.fmt(game.bet)}**${cfg.CANDY_EMOJI}.`,
        };
        const colorMap = {
          win: cfg.COLORS.SUCCESS, blackjack: cfg.COLORS.SUCCESS, push: cfg.COLORS.GOLD, lose: cfg.COLORS.ERROR,
        };
        const c = ui.blackjackCard(cfg, member, game, { hideDealer: false, footer: footerMap[resolution.result], color: colorMap[resolution.result] });
        return interaction.update(ui.payload(c));
      }
    }

    if (ns === 'duel') {
      if (!checkButtonOwner(interaction, allowedId)) return;
      const challenge = economy.getDuelChallenge(allowedId);
      if (!challenge) {
        return interaction.update(ui.errorCard(cfg, 'Este reto ya no existe', 'Puede que haya expirado o ya se haya respondido.'));
      }
      if (action === 'decline') {
        economy.cancelDuelChallenge(allowedId);
        return interaction.update(ui.infoCard(cfg, 'Duelo rechazado', `${interaction.member.displayName} decidió no pelear.`));
      }
      if (action === 'accept') {
        const { challengerId, bet } = challenge;
        const challengerData = db.getUser(challengerId);
        const targetData = db.getUser(allowedId);
        const result = economy.resolveDuel(challengerData, challengerId, targetData, allowedId, bet);
        if (result.error) {
          economy.cancelDuelChallenge(allowedId);
          return interaction.update(ui.errorCard(cfg, 'No se pudo realizar el duelo', 'Alguno de los dos ya no tiene suficiente Cash.'));
        }
        const challengerMember = await interaction.guild.members.fetch(challengerId).catch(() => null);
        if (!challengerMember) {
          return interaction.update(ui.infoCard(cfg, 'Duelo resuelto', 'El resultado se calculó, pero no pude cargar el perfil del retador.'));
        }
        await interaction.update(ui.duelAnimationCard(cfg, challengerMember, interaction.member, 0));
        for (let frame = 1; frame <= 3; frame += 1) {
          await new Promise((resolve) => setTimeout(resolve, 450));
          await interaction.editReply(ui.duelAnimationCard(cfg, challengerMember, interaction.member, frame)).catch(() => {});
        }
        return interaction.editReply(ui.duelResultCard(cfg, challengerMember, interaction.member, result));
      }
    }

    if (ns === 'confirm' && action === 'reset') {
      if (interaction.user.id !== cfg.OWNER_ID) {
        return interaction.reply({ content: 'Solo el dueño del bot puede confirmar esto.', flags: MessageFlags.Ephemeral });
      }
      db.resetUser(allowedId);
      return interaction.update(ui.successCard(cfg, 'Usuario reiniciado', `El perfil económico de <@${allowedId}> fue reiniciado.`));
    }

    if (ns === 'cancel' && action === 'reset') {
      if (interaction.user.id !== cfg.OWNER_ID) {
        return interaction.reply({ content: 'Solo el dueño del bot puede cancelar esto.', flags: MessageFlags.Ephemeral });
      }
      return interaction.update(ui.infoCard(cfg, 'Cancelado', 'No se hicieron cambios.'));
    }
  } catch (err) {
    console.error('[interactionCreate] Error:', err);
    try {
      const errPayload = { content: 'Ocurrió un error inesperado.', flags: MessageFlags.Ephemeral };
      if (interaction.deferred || interaction.replied) await interaction.followUp(errPayload);
      else await interaction.reply(errPayload);
    } catch (_) { /* noop */ }
  }
});

client.on('error', (err) => console.error('[Discord Client Error]', err));
process.on('unhandledRejection', (err) => console.error('[Unhandled Rejection]', err));

let serviceReady = false;
let shuttingDown = false;
let healthServer = null;
let maintenanceMode = false;
const dashboardSessions = new Map();
const dashboardLoginFailures = new Map();

function htmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function dashboardPage(session, notice = {}) {
  const message = notice.error
    ? `<p class="notice error">${htmlEscape(notice.error)}</p>`
    : notice.success
      ? `<p class="notice success">${htmlEscape(notice.success)}</p>`
      : '';
  const csrf = htmlEscape(session.csrf);
  const csrfInput = `<input type="hidden" name="csrf" value="${csrf}">`;

  if (!session.authenticated) {
    return `<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Acceso al panel de Xerion</title>
      <style>body{font:16px system-ui;background:#17151c;color:#f7f2e8;max-width:480px;margin:12vh auto;padding:24px}form{display:grid;gap:12px}input,button{font:inherit;padding:12px;border-radius:8px}button{background:#f28c28;border:0;font-weight:700}label{display:grid;gap:6px}.notice{padding:12px;border-radius:8px;background:#382b20}</style>
      <h1>Panel de Xerion</h1><p>Acceso exclusivo del propietario.</p>${message}
      <form method="post" action="/dashboard/login">${csrfInput}<label>Contraseña<input name="password" type="password" autocomplete="current-password" required></label><button>Entrar</button></form></html>`;
  }

  const rows = db.getRedeemCodes().map((code) => {
    const state = code.active ? 'Activo' : 'Desactivado';
    const expirationDate = new Date(code.expiresAt);
    const expiration = Number.isFinite(expirationDate.getTime())
      ? expirationDate.toISOString().replace('T', ' ').replace('.000Z', ' UTC')
      : 'Fecha inválida';
    const deactivate = code.active
      ? `<form method="post" action="/dashboard/codes/deactivate">${csrfInput}<input type="hidden" name="code" value="${htmlEscape(code.code)}"><button class="secondary">Desactivar</button></form>`
      : '—';
    return `<tr><td><code>${htmlEscape(code.code)}</code></td><td>${db.fmt(code.reward)}</td><td>${htmlEscape(expiration)}</td><td>${code.redeemedCount}/${code.maxUses}</td><td>${state}</td><td>${deactivate}</td></tr>`;
  }).join('');

  const resetPanel = session.resetChallenge && session.resetChallenge.expiresAt > Date.now()
    ? `<h3>Confirmar reinicio global</h3><p>Ingresa el código de seis dígitos enviado por DM de Discord al propietario. Vence en cinco minutos.</p>
       <form method="post" action="/dashboard/reset/confirm">${csrfInput}<label>Código de Discord<input name="resetCode" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" required></label><button class="danger">Confirmar reinicio de progreso</button></form>`
    : `<form method="post" action="/dashboard/reset/request">${csrfInput}<button class="danger">Solicitar reinicio global</button></form>`;

  return `<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Panel de Xerion</title>
    <style>body{font:15px system-ui;background:#17151c;color:#f7f2e8;max-width:1000px;margin:36px auto;padding:0 20px}section{background:#24212a;padding:20px;border-radius:12px;margin:18px 0}form{display:flex;gap:10px;align-items:end;flex-wrap:wrap}label{display:grid;gap:6px}input,button{font:inherit;padding:10px;border-radius:7px;border:1px solid #514a58;background:#17151c;color:inherit}button{background:#f28c28;border:0;color:#20160d;font-weight:700;cursor:pointer}.secondary{background:#514a58;color:white}.danger{background:#d9534f;color:white}.notice{padding:12px;border-radius:8px}.error{background:#512c31}.success{background:#244531}table{border-collapse:collapse;width:100%;margin-top:14px}th,td{text-align:left;padding:9px;border-bottom:1px solid #514a58}td form{display:block}code{color:#ffc477}small{color:#c9c1ce}</style>
    <header><h1>🎃 Panel de Xerion</h1><form method="post" action="/dashboard/logout">${csrfInput}<button class="secondary">Cerrar sesión</button></form></header>
    ${message}
    <section><h2>Crear código de canje</h2><p>Cada jugador de nivel 10 o superior puede canjear un código una sola vez. La fecha de vencimiento se ingresa en UTC.</p>
      <form method="post" action="/dashboard/codes">
        ${csrfInput}
        <label>Código<input name="code" minlength="3" maxlength="32" pattern="[A-Za-z0-9_-]+" required></label>
        <label>Recompensa en Candys<input name="reward" type="number" min="1" step="1" required></label>
        <label>Vence (UTC)<input name="expiresAt" type="datetime-local" step="60" required></label>
        <label>Canjes máximos<input name="maxUses" type="number" min="1" max="1000000" step="1" value="1" required></label>
        <button>Crear código</button>
      </form>
    </section>
    <section><h2>Códigos de canje</h2><table><thead><tr><th>Código</th><th>Recompensa</th><th>Vencimiento</th><th>Canjes</th><th>Estado</th><th>Acción</th></tr></thead><tbody>${rows || '<tr><td colspan="6">Todavía no hay códigos.</td></tr>'}</tbody></table></section>
    <section><h2>Zona de riesgo</h2><p>Esto borra todos los perfiles de jugadores y el estado temporal de las partidas. Las definiciones de códigos y el historial de canjes se conservan. El código de confirmación se envía solo por DM de Discord al propietario y nunca se muestra en esta página.</p>${resetPanel}</section>
  </html>`;
}

function dashboardCookie(id, request) {
  const secure = request.socket.encrypted || request.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  return `xerion_dashboard=${id}; Path=/dashboard; HttpOnly; SameSite=Strict; Max-Age=28800${secure}`;
}

function readDashboardSession(request) {
  const cookie = String(request.headers.cookie || '').split(';').map((part) => part.trim())
    .find((part) => part.startsWith('xerion_dashboard='));
  if (!cookie) return null;
  const id = cookie.slice('xerion_dashboard='.length);
  const session = dashboardSessions.get(id);
  if (!session || session.expiresAt <= Date.now()) {
    dashboardSessions.delete(id);
    return null;
  }
  return { id, session };
}

function createDashboardSession(authenticated = false) {
  const now = Date.now();
  for (const [sessionId, session] of dashboardSessions) {
    if (session.expiresAt <= now) dashboardSessions.delete(sessionId);
  }
  while (dashboardSessions.size >= 1000) {
    const oldest = dashboardSessions.keys().next().value;
    if (!oldest) break;
    dashboardSessions.delete(oldest);
  }
  const id = crypto.randomBytes(32).toString('base64url');
  const session = {
    authenticated,
    csrf: crypto.randomBytes(32).toString('base64url'),
    expiresAt: now + 8 * 60 * 60 * 1000,
    resetChallenge: null,
    lastResetRequestAt: 0,
  };
  dashboardSessions.set(id, session);
  return { id, session };
}

function safeTokenEqual(expected, provided) {
  const left = crypto.createHash('sha256').update(String(expected)).digest();
  const right = crypto.createHash('sha256').update(String(provided)).digest();
  return crypto.timingSafeEqual(left, right);
}

async function readDashboardForm(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 16 * 1024) {
      const error = new Error('Request body too large');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString('utf8')));
}

function sendDashboardHtml(response, status, html, headers = {}) {
  response.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    ...headers,
  });
  response.end(html);
}

function redirectDashboard(response, cookie) {
  response.writeHead(303, {
    Location: '/dashboard',
    'Cache-Control': 'no-store',
    'Set-Cookie': cookie,
  });
  response.end();
}

function normalizeDashboardExpiry(value) {
  const raw = String(value || '').trim();
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(raw)) return `${raw}:00Z`;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(raw)) return `${raw}Z`;
  return raw;
}

async function handleHttpRequest(request, response) {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  if (request.method === 'GET' && url.pathname === '/health') {
    response.writeHead(serviceReady ? 200 : 503, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end(serviceReady ? 'ok' : 'starting');
    return;
  }
  if (!url.pathname.startsWith('/dashboard')) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
    return;
  }
  if (!process.env.DASHBOARD_PASSWORD) {
    sendDashboardHtml(response, 503, '<!doctype html><meta charset="utf-8"><h1>Panel no disponible</h1><p>Configura DASHBOARD_PASSWORD en las variables de entorno del servicio.</p>');
    return;
  }
  if (url.pathname !== '/dashboard' && url.pathname !== '/dashboard/') {
    // Route-specific actions are handled below; reject unknown paths explicitly.
    if (![
      '/dashboard/login',
      '/dashboard/logout',
      '/dashboard/codes',
      '/dashboard/codes/deactivate',
      '/dashboard/reset/request',
      '/dashboard/reset/confirm',
    ].includes(url.pathname)) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Not found');
      return;
    }
  }

  let current = readDashboardSession(request);
  if (request.method === 'GET' && (url.pathname === '/dashboard' || url.pathname === '/dashboard/')) {
    if (!current) current = createDashboardSession(false);
    sendDashboardHtml(response, 200, dashboardPage(current.session), { 'Set-Cookie': dashboardCookie(current.id, request) });
    return;
  }

  if (request.method !== 'POST') {
    response.writeHead(405, { Allow: 'GET, POST', 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Method not allowed');
    return;
  }
  if (!current) {
    response.writeHead(303, { Location: '/dashboard', 'Cache-Control': 'no-store' });
    response.end();
    return;
  }

  let form;
  try {
    form = await readDashboardForm(request);
  } catch (error) {
    response.writeHead(error.statusCode || 400, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end(error.statusCode === 413 ? 'Request too large' : 'Invalid form');
    return;
  }
  if (!safeTokenEqual(current.session.csrf, form.csrf || '')) {
    sendDashboardHtml(response, 403, dashboardPage(current.session, { error: 'El formulario venció. Recarga el panel e inténtalo de nuevo.' }));
    return;
  }

  if (url.pathname === '/dashboard/login') {
    const ip = request.socket.remoteAddress || 'unknown';
    for (const [address, entry] of dashboardLoginFailures) {
      if (entry.until <= Date.now()) dashboardLoginFailures.delete(address);
    }
    while (dashboardLoginFailures.size >= 4096) {
      const oldest = dashboardLoginFailures.keys().next().value;
      if (!oldest) break;
      dashboardLoginFailures.delete(oldest);
    }
    const failure = dashboardLoginFailures.get(ip);
    if (failure && failure.until > Date.now() && failure.count >= 5) {
      sendDashboardHtml(response, 429, dashboardPage(current.session, { error: 'Demasiados intentos. Espera 15 minutos.' }));
      return;
    }
    const configuredDigest = crypto.createHash('sha256').update(process.env.DASHBOARD_PASSWORD).digest();
    const submittedDigest = crypto.createHash('sha256').update(String(form.password || '')).digest();
    if (!crypto.timingSafeEqual(configuredDigest, submittedDigest)) {
      const entry = failure && failure.until > Date.now() ? failure : { count: 0, until: Date.now() + 15 * 60 * 1000 };
      entry.count += 1;
      dashboardLoginFailures.set(ip, entry);
      sendDashboardHtml(response, 401, dashboardPage(current.session, { error: 'Contraseña incorrecta.' }));
      return;
    }
    dashboardLoginFailures.delete(ip);
    dashboardSessions.delete(current.id);
    const authenticated = createDashboardSession(true);
    redirectDashboard(response, dashboardCookie(authenticated.id, request));
    return;
  }

  if (!current.session.authenticated) {
    sendDashboardHtml(response, 401, dashboardPage(current.session, { error: 'Primero inicia sesión.' }));
    return;
  }

  if (url.pathname === '/dashboard/logout') {
    dashboardSessions.delete(current.id);
    response.writeHead(303, {
      Location: '/dashboard',
      'Cache-Control': 'no-store',
      'Set-Cookie': 'xerion_dashboard=; Path=/dashboard; HttpOnly; SameSite=Strict; Max-Age=0',
    });
    response.end();
    return;
  }

  if (url.pathname === '/dashboard/codes') {
    const created = await db.createRedeemCode({
      code: form.code,
      reward: Number(form.reward),
      expiresAt: normalizeDashboardExpiry(form.expiresAt),
      maxUses: Number(form.maxUses),
    });
    const errorText = {
      invalid_code: 'El código debe tener entre 3 y 32 letras, números, guiones o guiones bajos.',
      invalid_reward: 'La recompensa debe ser un entero positivo seguro.',
      invalid_expiry: 'Elige una fecha futura (UTC).',
      invalid_uses: 'Los canjes máximos deben estar entre 1 y 1.000.000.',
      exists: 'Ese código ya existe.',
      persistence_error: 'No se pudo guardar el código.',
    };
    sendDashboardHtml(response, created.error ? 400 : 200, dashboardPage(
      current.session,
      created.error ? { error: errorText[created.error] || 'No se pudo crear el código.' } : { success: `Código ${created.code.code} creado.` },
    ));
    return;
  }

  if (url.pathname === '/dashboard/codes/deactivate') {
    const result = await db.deactivateRedeemCode(form.code);
    sendDashboardHtml(response, result.error ? 404 : 200, dashboardPage(
      current.session,
      result.error ? { error: 'No se encontró ese código.' } : { success: `Código ${result.code.code} desactivado.` },
    ));
    return;
  }

  if (url.pathname === '/dashboard/reset/request') {
    if (current.session.resetChallenge && current.session.resetChallenge.expiresAt > Date.now()) {
      sendDashboardHtml(response, 200, dashboardPage(current.session, { success: 'Ya hay un código activo. Revisa el DM de Discord del propietario.' }));
      return;
    }
    if (Date.now() - current.session.lastResetRequestAt < 30 * 1000) {
      sendDashboardHtml(response, 429, dashboardPage(current.session, { error: 'Espera 30 segundos antes de solicitar otro código.' }));
      return;
    }
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    current.session.lastResetRequestAt = Date.now();
    current.session.resetChallenge = {
      digest: crypto.createHash('sha256').update(code).digest('hex'),
      expiresAt: Date.now() + 5 * 60 * 1000,
      attempts: 0,
    };
    try {
      const owner = await client.users.fetch(cfg.OWNER_ID);
      await owner.send(`Código de reinicio del panel de Xerion: ${code}\nVence en 5 minutos. No lo compartas.`);
      sendDashboardHtml(response, 200, dashboardPage(current.session, { success: 'Se envió un código de un solo uso al DM de Discord del propietario. No se muestra aquí.' }));
    } catch (error) {
      current.session.resetChallenge = null;
      sendDashboardHtml(response, 503, dashboardPage(current.session, { error: 'No se pudo enviar el DM. Verifica la conexión del bot y la configuración de mensajes directos de Discord.' }));
    }
    return;
  }

  if (url.pathname === '/dashboard/reset/confirm') {
    const challenge = current.session.resetChallenge;
    if (!challenge || challenge.expiresAt <= Date.now()) {
      current.session.resetChallenge = null;
      sendDashboardHtml(response, 400, dashboardPage(current.session, { error: 'El código venció. Solicita uno nuevo.' }));
      return;
    }
    const entered = String(form.resetCode || '').trim();
    const digest = crypto.createHash('sha256').update(entered).digest('hex');
    if (!/^\d{6}$/.test(entered) || !safeTokenEqual(challenge.digest, digest)) {
      challenge.attempts += 1;
      if (challenge.attempts >= 5) current.session.resetChallenge = null;
      sendDashboardHtml(response, 400, dashboardPage(current.session, {
        error: challenge.attempts >= 5 ? 'Demasiados intentos incorrectos. Solicita un código nuevo.' : 'Código incorrecto. Tienes hasta cinco intentos.',
      }));
      return;
    }

    current.session.resetChallenge = null;
    maintenanceMode = true;
    try {
      const count = await db.resetAllUsers();
      economy.resetTransientState();
      await client.users.fetch(cfg.OWNER_ID).then((owner) => owner.send(`Xerion global progress reset completed for ${count} profiles.`)).catch(() => {});
      sendDashboardHtml(response, 200, dashboardPage(current.session, { success: `Reinicio global completado. Se borraron ${count} perfiles; las definiciones de códigos y su historial se conservaron.` }));
    } catch (error) {
      console.error('[Dashboard] Global reset failed:', error.message);
      sendDashboardHtml(response, 500, dashboardPage(current.session, { error: 'Falló el reinicio global. No se confirmó el éxito; revisa la conexión a la base de datos antes de volver a intentarlo.' }));
    } finally {
      maintenanceMode = false;
    }
    return;
  }

  response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  response.end('Not found');
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  serviceReady = false;
  console.log(`[Shutdown] Cerrando tras ${signal}...`);
  try {
    await databaseReady.catch(() => {});
    await db.closeDB();
    client.destroy();
    if (healthServer) await new Promise((resolve) => healthServer.close(resolve));
  } catch (err) {
    console.error('[Shutdown] Error al cerrar:', err.message);
  } finally {
    process.exit(0);
  }
}
process.on('SIGINT', () => { void shutdown('SIGINT'); });
process.on('SIGTERM', () => { void shutdown('SIGTERM'); });

// Render's web listener serves health checks and the password-protected
// owner dashboard; all other paths are closed.
if (process.env.PORT) {
  healthServer = http.createServer((request, response) => {
    void handleHttpRequest(request, response).catch((error) => {
      console.error('[HTTP] Request failed:', error.message);
      if (!response.headersSent) {
        response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      }
      response.end('Internal server error');
    });
  });
  healthServer.listen(Number(process.env.PORT), '0.0.0.0', () => {
    console.log(`[HTTP] Health check activo en el puerto ${process.env.PORT}`);
  });
}

databaseReady
  .then(() => client.login(process.env.BOT_TOKEN))
  .catch((err) => {
  console.error('❌ No se pudo iniciar la base de datos o Discord:', err.message);
  process.exit(1);
});

module.exports = {
  commands, ALIASES, isOwner, stripMentionArgs, computeNextGoal, checkButtonOwner, countActiveEffects, client, executeBuy,
};
