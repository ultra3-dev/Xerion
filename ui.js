'use strict';

const {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  SectionBuilder,
  ThumbnailBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} = require('discord.js');

const db = require('./database');
const economy = require('./economy');

// ---------- Primitivas ----------

function text(content) {
  return new TextDisplayBuilder().setContent(content);
}

function sep(large = false) {
  return new SeparatorBuilder().setDivider(true).setSpacing(large ? SeparatorSpacingSize.Large : SeparatorSpacingSize.Small);
}

function container(color) {
  return new ContainerBuilder().setAccentColor(color);
}

function button(customId, label, style, emoji) {
  const b = new ButtonBuilder().setCustomId(customId).setLabel(label).setStyle(style);
  if (emoji) b.setEmoji(emoji);
  return b;
}

function linkButton(url, label, emoji) {
  const b = new ButtonBuilder().setURL(url).setLabel(label).setStyle(ButtonStyle.Link);
  if (emoji) b.setEmoji(emoji);
  return b;
}

function row(...buttons) {
  return new ActionRowBuilder().addComponents(...buttons);
}

// El payload final que se envía a channel.send / message.edit / interaction.reply / update.
// allowedMentions con parse:[] deja que el texto siga mostrando menciones de
// usuario y de rol con su nombre/color normales, pero ninguna de ellas
// dispara una notificación real a nadie (ni @everyone/@here).
function payload(containers, extra = {}) {
  const list = Array.isArray(containers) ? containers : [containers];
  return {
    flags: MessageFlags.IsComponentsV2,
    components: list,
    allowedMentions: { parse: [] },
    ...extra,
  };
}

function progressBar(fraction, length = 12) {
  const filled = Math.round(db.clamp(fraction, 0, 1) * length);
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, length - filled));
}

// ---------- Botones "solo para ti" ----------
// Convención de customId: "<namespace>:<accion>:<idPermitido>"
// index.js compara interaction.user.id con ese idPermitido antes de actuar.

function lockedButton(namespace, action, allowedId, label, style, emoji) {
  return button(`${namespace}:${action}:${allowedId}`, label, style, emoji);
}

function addCatalogPagination(c, type, page, totalItems, pageSize, invokerId, targetId = invokerId) {
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const requestedPage = Number.isFinite(page) ? Math.trunc(page) : 0;
  const currentPage = db.clamp(requestedPage, 0, totalPages - 1);
  if (totalPages <= 1 || !invokerId) return currentPage;

  c.addSeparatorComponents(sep());
  c.addTextDisplayComponents(text(`-# Página ${currentPage + 1} de ${totalPages}`));
  c.addActionRowComponents(row(
    lockedButton(
      'catalog',
      'page',
      `${invokerId}:${type}:${currentPage - 1}:${targetId}`,
      'Anterior',
      ButtonStyle.Secondary,
      '⬅️',
    ).setDisabled(currentPage <= 0),
    lockedButton(
      'catalog',
      'page',
      `${invokerId}:${type}:${currentPage + 1}:${targetId}`,
      'Siguiente',
      ButtonStyle.Primary,
      '➡️',
    ).setDisabled(currentPage >= totalPages - 1),
  ));
  return currentPage;
}

// ---------- Tarjetas genéricas (éxito / error / info / deuda) ----------

function card(color, title, body, footer) {
  const c = container(color);
  c.addTextDisplayComponents(text(title));
  if (body) c.addTextDisplayComponents(text(body));
  if (footer) {
    c.addSeparatorComponents(sep());
    c.addTextDisplayComponents(text(`-# ${footer}`));
  }
  return c;
}

function successCard(cfg, title, body, footer) {
  return payload(card(cfg.COLORS.SUCCESS, `✅ ${title}`, body, footer));
}

function errorCard(cfg, title, body, footer) {
  return payload(card(cfg.COLORS.ERROR, `❌ ${title}`, body, footer));
}

function infoCard(cfg, title, body, footer) {
  return payload(card(cfg.COLORS.DEFAULT, title, body, footer));
}

function debtCard(cfg, title, body, footer) {
  return payload(card(cfg.COLORS.DEBT, title, body, footer));
}

// ---------- Tarjeta de Balance (avanzada) ----------

function balanceCard(cfg, member, dbUser, extra = {}) {
  const total = db.getTotal(dbUser);
  const c = container(cfg.COLORS.DEFAULT);
  const section = new SectionBuilder()
    .addTextDisplayComponents(text(`# 🍬 Balance de ${member.displayName}`))
    .setThumbnailAccessory(new ThumbnailBuilder().setURL(member.displayAvatarURL({ extension: 'png', size: 128 })));
  c.addSectionComponents(section);
  c.addSeparatorComponents(sep());
  c.addTextDisplayComponents(text(
    `💸 **Cash:** ${db.fmt(dbUser.cash)}${cfg.CANDY_EMOJI}\n`
    + `🏦 **Bank:** ${db.fmt(dbUser.bank)}${cfg.CANDY_EMOJI}\n`
    + `📊 **Total:** ${db.fmt(total)}${cfg.CANDY_EMOJI}`,
  ));
  c.addSeparatorComponents(sep());
  c.addTextDisplayComponents(text(`💀 **Debt:** -${db.fmt(dbUser.debt)}${cfg.CANDY_EMOJI}`));
  c.addSeparatorComponents(sep());

  const cls = dbUser.class ? economy.classDef(dbUser.class) : null;
  const lvl = economy.getLevelInfo(dbUser);
  const lines = [
    `🏆 **Rank:** #${db.fmt(extra.rank || 0)}${cls ? ` · ${cls.emoji} **${cls.name}**` : ' · 🎭 sin clase (`xn class`)'}`,
    `⭐ **Nivel ${lvl.level}** ${progressBar(lvl.progress)} \`${db.fmt(lvl.xp - lvl.currentFloor)}/${db.fmt(lvl.nextCeil - lvl.currentFloor)} XP\``,
  ];
  if (extra.activeCount) lines.push(`🧪 **Pociones activas:** ${extra.activeCount} — mira \`xn inventory\``);
  if (dbUser.bountyOn > 0) lines.push(`🎯 **¡Tienes ${db.fmt(dbUser.bountyOn)}${cfg.CANDY_EMOJI} de recompensa sobre tu cabeza!**`);
  c.addTextDisplayComponents(text(lines.join('\n')));

  if (extra.nextGoal) {
    c.addSeparatorComponents(sep());
    c.addTextDisplayComponents(text(`-# 🎯 Próxima meta: **${extra.nextGoal.name}** — te faltan ${db.fmt(extra.nextGoal.missing)}${cfg.CANDY_EMOJI}`));
  }
  return payload(c);
}

// ---------- Tarjeta de Perfil ----------

function profileCard(cfg, member, dbUser, rank, activePotionLines) {
  const total = db.getTotal(dbUser);
  const c = container(cfg.COLORS.GOLD);
  const section = new SectionBuilder()
    .addTextDisplayComponents(text(`# 🎃 Perfil de ${member.displayName}`))
    .setThumbnailAccessory(new ThumbnailBuilder().setURL(member.displayAvatarURL({ extension: 'png', size: 256 })));
  c.addSectionComponents(section);
  c.addSeparatorComponents(sep());
  const cls = dbUser.class ? economy.classDef(dbUser.class) : null;
  const lvl = economy.getLevelInfo(dbUser);
  const badge = dbUser.debt > 0 ? '🩸 Endeudado con la bruja' : (rank === 1 ? '👑 El más rico del cementerio' : '🎃 Espíritu de Halloween');
  c.addTextDisplayComponents(text(
    `${badge}\n`
    + `💸 **Cash:** ${db.fmt(dbUser.cash)}${cfg.CANDY_EMOJI} · 🏦 **Bank:** ${db.fmt(dbUser.bank)}${cfg.CANDY_EMOJI}\n`
    + `📊 **Total:** ${db.fmt(total)}${cfg.CANDY_EMOJI} · 💀 **Debt:** -${db.fmt(dbUser.debt)}${cfg.CANDY_EMOJI}\n`
    + `**Puesto en el ranking:** #${rank}\n`
    + `${cls ? `${cls.emoji} **Clase:** ${cls.name}` : '🎭 **Clase:** ninguna'} · ⭐ **Nivel:** ${lvl.level}`,
  ));
  if (activePotionLines && activePotionLines.length) {
    c.addSeparatorComponents(sep());
    c.addTextDisplayComponents(text(`**🧪 Pociones activas**\n${activePotionLines.join('\n')}`));
  }
  return payload(c);
}

// ---------- RPG: clases ----------

function classListContainer(cfg, dbUser, invokerId) {
  const c = container(cfg.COLORS.PURPLE || cfg.COLORS.DEBT);
  c.addTextDisplayComponents(text('# 🎭 Clases de Halloween'));
  const level = dbUser ? db.getLevel(dbUser.xp) : 0;
  c.addTextDisplayComponents(text(`-# Desbloquea en nivel 5 · elige con un botón o escribe \`${cfg.PREFIX} class <nombre|id>\` · elección permanente`));
  c.addSeparatorComponents(sep());
  cfg.CLASSES.forEach((cl) => {
    const selected = dbUser && dbUser.class === cl.id;
    const section = new SectionBuilder()
      .addTextDisplayComponents(text(`${cl.emoji} **${cl.name}** \`(${cl.id})\`${selected ? ' · ✅ Tu clase' : ''}\n${cl.desc}`))
      .setButtonAccessory(
        lockedButton('classpick', cl.id, invokerId || '0', selected ? 'Elegida' : 'Elegir', selected ? ButtonStyle.Secondary : ButtonStyle.Primary, selected ? '✅' : '🎭')
          .setDisabled(!invokerId || !!(dbUser && dbUser.class) || level < 5),
      );
    c.addSectionComponents(section);
  });
  if (level < 5 && !dbUser?.class) {
    c.addSeparatorComponents(sep());
    c.addTextDisplayComponents(text(`🔒 Te falta llegar al nivel 5. Tu nivel actual es **${level}**.`));
  }
  if (dbUser && dbUser.class) {
    c.addSeparatorComponents(sep());
    const current = economy.classDef(dbUser.class);
    c.addTextDisplayComponents(text(current
      ? `-# Tu clase actual: ${current.emoji} **${current.name}**`
      : '-# Tu perfil tiene una clase antigua que ya no está disponible.'));
  }
  return payload(c);
}

// ---------- RPG: armería ----------

function armoryContainer(cfg, dbUser, invokerId, page = 0) {
  const c = container(cfg.COLORS.DARK);
  c.addTextDisplayComponents(text('# ⚔️ Armería Embrujada'));
  c.addTextDisplayComponents(text(`-# Compra con el botón · equipa con \`${cfg.PREFIX} equip <id>\` (permanente, un arma a la vez)`));
  c.addSeparatorComponents(sep());
  const pageSize = 4;
  const totalPages = Math.max(1, Math.ceil(cfg.WEAPONS.length / pageSize));
  const currentPage = db.clamp(Number.isFinite(page) ? Math.trunc(page) : 0, 0, totalPages - 1);
  const start = currentPage * pageSize;
  cfg.WEAPONS.slice(start, start + pageSize).forEach((w, i, pageWeapons) => {
    const weaponIndex = start + i;
    const owned = db.hasWeapon(dbUser, w.id);
    const equipped = dbUser.equippedWeapon === w.id;
    const tag = equipped ? ' `equipada`' : (owned ? ' `en tu poder`' : '');
    const section = new SectionBuilder()
      .addTextDisplayComponents(text(`${w.emoji} **${w.name}**${tag}\n${w.desc}\n💰 **${db.fmt(w.price)}**${cfg.CANDY_EMOJI}`))
      .setButtonAccessory(
        lockedButton('shopbuy', w.id, `${invokerId}:${currentPage}`, owned ? 'Comprada' : 'Comprar', owned ? ButtonStyle.Secondary : ButtonStyle.Success, owned ? '✅' : '🛒')
          .setDisabled(owned),
      );
    c.addSectionComponents(section);
    if (i < pageWeapons.length - 1 || weaponIndex < cfg.WEAPONS.length - 1) c.addSeparatorComponents(sep());
  });
  addCatalogPagination(c, 'armory', currentPage, cfg.WEAPONS.length, pageSize, invokerId);
  return payload(c);
}

// ---------- RPG: nivel ----------

function levelCard(cfg, member, dbUser) {
  const lvl = economy.getLevelInfo(dbUser);
  const c = container(cfg.COLORS.GOLD);
  c.addTextDisplayComponents(text(`# ⭐ Nivel de ${member.displayName}`));
  c.addSeparatorComponents(sep());
  c.addTextDisplayComponents(text(
    `**Nivel actual:** ${lvl.level}\n`
    + `${progressBar(lvl.progress, 16)}\n`
    + `\`${db.fmt(lvl.xp)} XP total\` — faltan **${db.fmt(lvl.nextCeil - lvl.xp)} XP** para el nivel ${lvl.level + 1}`,
  ));
  const earned = lvl.bonuses;
  const next = cfg.LEVEL_BONUSES.find((bonus) => bonus.level > lvl.level);
  c.addSeparatorComponents(sep());
  c.addTextDisplayComponents(text(
    `**🎁 Beneficios de nivel**\n${earned.length ? earned.map((bonus) => `✅ Nivel ${bonus.level}: ${bonus.label}`).join('\n') : 'Aún no hay beneficios desbloqueados.'}`
    + (next ? `\n-# Próximo beneficio: nivel ${next.level} — ${next.label}` : '\n-# Ya desbloqueaste todos los hitos de nivel.'),
  ));
  return payload(c);
}

// ---------- RPG: logros ----------

function achievementsContainer(cfg, member, dbUser) {
  const list = economy.checkAchievements(dbUser);
  const unlocked = list.filter((a) => a.unlocked).length;
  const c = container(cfg.COLORS.GOLD);
  c.addTextDisplayComponents(text(`# 🏆 Logros de ${member.displayName} — ${unlocked}/${list.length}`));
  c.addSeparatorComponents(sep());
  list.forEach((achievement, index) => {
    const progress = Math.max(0, Math.min(achievement.value, achievement.threshold));
    c.addTextDisplayComponents(text(
      `${achievement.unlocked ? '✅' : '🔒'} ${achievement.emoji} **${achievement.name}**\n`
      + `${achievement.desc}\n`
      + `\`${progressBar(progress / Math.max(1, achievement.threshold), 10)}\` ${db.fmt(progress)}/${db.fmt(achievement.threshold)}`,
    ));
    if (index < list.length - 1) c.addSeparatorComponents(sep());
  });
  return payload(c);
}

// ---------- RPG: duelo ----------

function duelChallengeCard(cfg, challengerMember, targetMember, bet) {
  const c = container(cfg.COLORS.GOLD);
  c.addTextDisplayComponents(text(`# ⚔️ ¡${challengerMember.displayName} reta a ${targetMember.displayName}!`));
  c.addSeparatorComponents(sep());
  c.addTextDisplayComponents(text(`Apuesta: **${db.fmt(bet)}**${cfg.CANDY_EMOJI} cada uno. El ganador se lleva **${db.fmt(bet * 2)}**${cfg.CANDY_EMOJI}.`));
  c.addTextDisplayComponents(text(`-# Solo ${targetMember.displayName} puede responder. Expira en 60 segundos.`));
  c.addSeparatorComponents(sep());
  c.addActionRowComponents(row(
    lockedButton('duel', 'accept', targetMember.id, 'Aceptar', ButtonStyle.Success, '⚔️'),
    lockedButton('duel', 'decline', targetMember.id, 'Rechazar', ButtonStyle.Danger, '🏳️'),
  ));
  return c;
}

function duelAnimationCard(cfg, challengerMember, targetMember, bet, narration, frame = 0) {
  const c = container(cfg.COLORS.GOLD);
  const frames = ['⚔️ Los combatientes toman posición…', '🛡️ La arena tiembla con el primer choque…', '✨ El golpe decisivo está por llegar…'];
  c.addTextDisplayComponents(text(`# ⚔️ Duelo — ${challengerMember.displayName} vs. ${targetMember.displayName}`));
  c.addSeparatorComponents(sep());
  c.addTextDisplayComponents(text(`${frames[frame % frames.length]}\n\n${narration}`));
  c.addSeparatorComponents(sep());
  c.addTextDisplayComponents(text(`Apuesta: **${db.fmt(bet)}**${cfg.CANDY_EMOJI} cada uno · premio: **${db.fmt(bet * 2)}**${cfg.CANDY_EMOJI}`));
  return payload(c);
}

function duelResultCard(cfg, challengerMember, targetMember, result, narration = '') {
  const color = result.challengerWins ? cfg.COLORS.SUCCESS : cfg.COLORS.ERROR;
  const c = container(color);
  c.addTextDisplayComponents(text('# ⚔️ Resultado del duelo'));
  c.addSeparatorComponents(sep());
  const winner = result.challengerWins ? challengerMember : targetMember;
  const loser = result.challengerWins ? targetMember : challengerMember;
  c.addTextDisplayComponents(text(
    `🏆 **${winner.displayName}** gana el duelo: **+${db.fmt(result.pot - result.bet)}**${cfg.CANDY_EMOJI}\n`
    + `💀 **${loser.displayName}** pierde su apuesta: **-${db.fmt(result.bet)}**${cfg.CANDY_EMOJI}`
    + (narration ? `\n\n${narration}` : ''),
  ));
  return payload(c);
}

// ---------- Tienda de pociones ----------

function shopContainer(cfg, invokerId) {
  const c = container(cfg.COLORS.DEFAULT);
  c.addTextDisplayComponents(text('# 🧪 Tienda de Halloween'));
  c.addTextDisplayComponents(text(`-# Toca **Comprar** o usa \`${cfg.PREFIX} buy <id> [cantidad]\` para llevar más de una.`));
  c.addSeparatorComponents(sep());
  cfg.POTIONS.forEach((p, i) => {
    const section = new SectionBuilder()
      .addTextDisplayComponents(text(
        `${p.emoji} **${p.name}**\n${p.description}\n💰 **${db.fmt(p.price)}**${cfg.CANDY_EMOJI} · ⏱️ ${Math.round(p.durationMs / 60000)} min · 📚 x${p.maxStacks}`,
      ))
      .setButtonAccessory(lockedButton('shopbuy', p.id, invokerId, 'Comprar', ButtonStyle.Success, '🛒'));
    c.addSectionComponents(section);
    if (i < cfg.POTIONS.length - 1) c.addSeparatorComponents(sep());
  });
  return payload(c);
}

function privateShopPrompt(cfg, shopType, invokerId) {
  const eventShop = shopType === 'eventshop';
  const c = container(eventShop ? cfg.COLORS.GOLD : cfg.COLORS.DEFAULT);
  c.addTextDisplayComponents(text(eventShop ? '# 🎃 Tienda del Evento' : '# 🧪 Tienda de Halloween'));
  c.addTextDisplayComponents(text('Abre la tienda en privado. Las compras y sus recibos solo serán visibles para ti.'));
  c.addSeparatorComponents(sep());
  c.addActionRowComponents(row(
    lockedButton(
      'shopopen',
      eventShop ? 'eventshop' : 'shop',
      invokerId,
      'Abrir tienda privada',
      ButtonStyle.Primary,
      '🛍️',
    ),
  ));
  return payload(c);
}

// ---------- Tienda del evento ----------
// Nota anti-ping: aunque el texto usa <@&roleId> para MOSTRAR el rol con su
// nombre y color reales, el payload() de este archivo ya fuerza
// allowedMentions a no incluir "roles", así que nadie recibe notificación.

function eventShopContainer(cfg, now, member, invokerId, dbUser, page = 0) {
  const c = container(cfg.COLORS.GOLD);
  let status;
  const active = now >= cfg.EVENT_START && now < cfg.EVENT_END;
  if (now < cfg.EVENT_START) status = '🕰️ El evento comienza el **3 de octubre de 2026**.';
  else if (now >= cfg.EVENT_END) status = '🕸️ El evento de Halloween ha terminado.';
  else status = '🎉 ¡El evento está activo hasta el **9 de noviembre de 2026**!';
  c.addTextDisplayComponents(text('# 🎃 Tienda del Evento de Halloween'));
  c.addTextDisplayComponents(text(status));
  c.addSeparatorComponents(sep());
  const pageSize = 3;
  const totalPages = Math.max(1, Math.ceil(cfg.EVENT_SHOP.length / pageSize));
  const currentPage = db.clamp(Number.isFinite(page) ? Math.trunc(page) : 0, 0, totalPages - 1);
  const start = currentPage * pageSize;
  cfg.EVENT_SHOP.slice(start, start + pageSize).forEach((r, i, pageRoles) => {
    const roleIndex = start + i;
    const roleOwned = !!(member && member.roles && member.roles.cache && member.roles.cache.has(r.roleId));
    const purchased = !!(dbUser && Array.isArray(dbUser.eventRolesPurchased) && dbUser.eventRolesPurchased.includes(r.roleId));
    const activeBenefit = !!(dbUser && Array.isArray(dbUser.eventRolesActivated) && dbUser.eventRolesActivated.includes(r.roleId));
    const disabled = activeBenefit || !active;
    const label = activeBenefit ? 'Activado' : (purchased ? 'Activar' : 'Comprar');
    const action = purchased ? 'shopactivate' : 'shopbuy';
    const recipe = Object.entries(r.requirements || {})
      .map(([id, quantity]) => {
        const material = cfg.MATERIALS.find((item) => item.id === id);
        return `${material ? material.emoji : '🧱'} ${material ? material.name : id} ×${quantity}`;
      })
      .join(' · ');
    const cooldown = db.formatDuration(r.collectCooldownMs || cfg.COOLDOWNS.collect);
    const section = new SectionBuilder()
      .addTextDisplayComponents(text(
        `**${roleIndex + 1}.** <@&${r.roleId}>${roleOwned && !purchased ? ' · ya tienes el rol; falta comprarlo aquí' : ''}\n`
        + `🧾 Compra **${db.fmt(r.price)}**${cfg.CANDY_EMOJI} · 🔓 Activación **${db.fmt(Math.ceil(r.price / 2))}**${cfg.CANDY_EMOJI}\n`
        + `🎁 **${db.fmt(r.collectReward)}**${cfg.CANDY_EMOJI} por \`${cfg.PREFIX} collect\` cada **${cooldown}**\n`
        + `🧱 ${recipe}`,
      ))
      .setButtonAccessory(
        lockedButton(action, r.id, `${invokerId}:${currentPage}`, label, activeBenefit ? ButtonStyle.Secondary : ButtonStyle.Success, activeBenefit ? '✅' : (purchased ? '🔓' : '🛒'))
          .setDisabled(disabled),
      );
    c.addSectionComponents(section);
    if (i < pageRoles.length - 1) c.addSeparatorComponents(sep());
  });
  addCatalogPagination(c, 'eventshop', currentPage, cfg.EVENT_SHOP.length, pageSize, invokerId);
  c.addSeparatorComponents(sep());
  c.addActionRowComponents(row(linkButton(cfg.EVENT_INVITE_URL, 'Ver evento en Discord', '🔗')));
  return payload(c);
}

// ---------- Inventario ----------

function inventoryContainer(cfg, member, dbUser, invokerId = member?.id, page = 0) {
  const c = container(cfg.COLORS.DEFAULT);
  c.addTextDisplayComponents(text(`# 🎒 Inventario de ${member?.displayName || 'Usuario'}`));
  c.addSeparatorComponents(sep());
  const owned = Object.entries(dbUser.inventory || {}).filter(([, qty]) => qty > 0);
  if (!owned.length) {
    c.addTextDisplayComponents(text('No tienes pociones guardadas. Consíguelas con `xn shop`.'));
  } else {
    const lines = owned.map(([id, qty]) => {
      const p = cfg.POTIONS.find((x) => x.id === id);
      if (!p) return null;
      return `${p.emoji} **${p.name}** \`x${qty}\` — usa \`xn use ${p.id}\``;
    }).filter(Boolean);
    c.addTextDisplayComponents(text(lines.join('\n') || 'No tienes pociones guardadas.'));
  }
  c.addSeparatorComponents(sep());
  const ownedMaterials = cfg.MATERIALS
    .map((material) => ({ ...material, quantity: Number(dbUser.materials?.[material.id] || 0) }))
    .filter((material) => Number.isFinite(material.quantity) && material.quantity > 0);
  const materialPageSize = 12;
  const materialPageCount = Math.max(1, Math.ceil(ownedMaterials.length / materialPageSize));
  const materialPage = db.clamp(Number.isFinite(page) ? Math.trunc(page) : 0, 0, materialPageCount - 1);
  const visibleMaterials = ownedMaterials.slice(materialPage * materialPageSize, (materialPage + 1) * materialPageSize);
  const materialLines = visibleMaterials
    .map((material) => `${material.emoji} **${material.name}** ×${material.quantity}`)
    .join('\n');
  c.addTextDisplayComponents(text(ownedMaterials.length
    ? `**🧱 Materiales · ${ownedMaterials.length} en tu inventario**\n${materialLines}`
    : '**🧱 Materiales**\nNo tienes materiales todavía. Consíguelos jugando.'));
  addCatalogPagination(c, 'inventory', materialPage, ownedMaterials.length, materialPageSize, invokerId, member?.id || invokerId);
  c.addSeparatorComponents(sep());
  const activeLines = [];
  for (const p of cfg.POTIONS) {
    const remaining = db.getEffectRemaining(dbUser, p.id);
    if (remaining > 0) {
      const stacks = db.getStacks(dbUser, p.id);
      activeLines.push(`${p.emoji} **${p.name}** — x${stacks} carga(s) · ${db.formatDuration(remaining)} restante`);
    }
  }
  c.addTextDisplayComponents(text(activeLines.length ? `**🧪 Efectos activos**\n${activeLines.join('\n')}` : '**🧪 Efectos activos**\nNinguno por ahora.'));
  if (dbUser.weapons && dbUser.weapons.length) {
    c.addSeparatorComponents(sep());
    const wLines = dbUser.weapons.map((id) => {
      const w = cfg.WEAPONS.find((x) => x.id === id);
      if (!w) return null;
      return `${w.emoji} **${w.name}**${dbUser.equippedWeapon === id ? ' `equipada`' : ''}`;
    }).filter(Boolean);
    c.addTextDisplayComponents(text(`**⚔️ Armas**\n${wLines.join('\n')}`));
  }
  return payload(c);
}

// ---------- Info de pociones ----------

function potionsInfoContainer(cfg) {
  const c = container(cfg.COLORS.DEFAULT);
  c.addTextDisplayComponents(text('# 📖 Guía de Pociones'));
  c.addSeparatorComponents(sep());
  c.addTextDisplayComponents(text(`Usa \`${cfg.PREFIX} buy <id>\` para comprar y \`${cfg.PREFIX} use <id>\` para activar.`));
  c.addSeparatorComponents(sep());
  cfg.POTIONS.forEach((p) => {
    c.addTextDisplayComponents(text(
      `${p.emoji} **${p.name}** \`(${p.id})\`\n${p.description}\n💰 **${db.fmt(p.price)}**${cfg.CANDY_EMOJI} · ⏱️ ${Math.round(p.durationMs / 60000)} min · 📚 máx. ${p.maxStacks} cargas`,
    ));
    if (p !== cfg.POTIONS[cfg.POTIONS.length - 1]) c.addSeparatorComponents(sep());
  });
  return payload(c);
}

// ---------- Leaderboards / estadísticas ----------

const LEADERBOARD_PAGE_SIZE = 10;

function leaderboardContainer(cfg, mode, page, allEntries, invokerId) {
  const totalPages = Math.max(1, Math.ceil(allEntries.length / LEADERBOARD_PAGE_SIZE));
  const clampedPage = db.clamp(page, 0, totalPages - 1);
  const startIdx = clampedPage * LEADERBOARD_PAGE_SIZE;
  const pageEntries = allEntries.slice(startIdx, startIdx + LEADERBOARD_PAGE_SIZE);

  const isRich = mode === 'rich';
  const title = isRich ? '🏆 Top 100 global — Más ricos' : '🩸 Top 100 global — Más endeudados';
  const valueLabel = isRich ? '(Total)' : '(Debt)';
  const color = isRich ? cfg.COLORS.GOLD : cfg.COLORS.DEBT;

  const c = container(color);
  c.addTextDisplayComponents(text(`# ${title}`));
  c.addTextDisplayComponents(text(`-# Página ${clampedPage + 1} de ${totalPages} · ${allEntries.length} en la lista`));
  c.addSeparatorComponents(sep());
  if (!pageEntries.length) {
    c.addTextDisplayComponents(text('Todavía no hay nadie en esta lista.'));
  } else {
    const medals = ['🥇', '🥈', '🥉'];
    const lines = pageEntries.map((e, i) => {
      const rank = startIdx + i;
      const marker = medals[rank] || `**${rank + 1}.**`;
      const displayName = String(e.displayName || 'Jugador sin nombre')
        .replace(/[\r\n]+/g, ' ')
        .replace(/([\\*_`~|])/g, '\\$1')
        .replace(/^@+/, '')
        .replace(/@/g, '@\u200b');
      const userId = String(e.id || '');
      const userLabel = e.isGuildMember && /^\d{17,20}$/.test(userId)
        ? `<@${userId}>`
        : `@${displayName}`;
      return `${marker} **${userLabel}** — **${db.fmt(e.value)}**${cfg.CANDY_EMOJI} ${valueLabel}`;
    });
    c.addTextDisplayComponents(text(lines.join('\n')));
  }
  c.addSeparatorComponents(sep());
  c.addActionRowComponents(row(
    lockedButton('top', `prev-${mode}-${clampedPage}`, invokerId, 'Anterior', ButtonStyle.Secondary, '⬅️').setDisabled(clampedPage <= 0),
    lockedButton('top', `next-${mode}-${clampedPage}`, invokerId, 'Siguiente', ButtonStyle.Secondary, '➡️').setDisabled(clampedPage >= totalPages - 1),
  ));
  c.addActionRowComponents(row(
    lockedButton('top', `rich-${clampedPage}`, invokerId, 'Ricos', isRich ? ButtonStyle.Primary : ButtonStyle.Secondary, '🏆'),
    lockedButton('top', `debt-${clampedPage}`, invokerId, 'Endeudados', !isRich ? ButtonStyle.Primary : ButtonStyle.Secondary, '🩸'),
  ));
  const allowedUserIds = pageEntries
    .filter((entry) => entry.isGuildMember)
    .map((entry) => String(entry.id || ''))
    .filter((id) => /^\d{17,20}$/.test(id));
  return payload(c, {
    flags: MessageFlags.IsComponentsV2 | MessageFlags.SuppressNotifications,
    allowedMentions: { parse: [], users: allowedUserIds },
  });
}

function cooldownsContainer(cfg, member, lines) {
  const c = container(cfg.COLORS.DEFAULT);
  c.addTextDisplayComponents(text(`# ⏱️ Cooldowns de ${member.displayName}`));
  c.addTextDisplayComponents(text('-# En curso muestra el tiempo exacto; listo significa que puedes volver a usarlo.'));
  c.addSeparatorComponents(sep());
  const active = lines.filter((item) => typeof item === 'object' && item.status !== 'progress' && item.remaining > 0);
  const ready = lines.filter((item) => typeof item === 'object' && item.status !== 'progress' && item.remaining <= 0);
  const progress = lines.filter((item) => typeof item === 'object' && item.status === 'progress');
  if (!active.length && !ready.length) {
    if (progress.length) {
      c.addTextDisplayComponents(text(`**📜 En curso · ${progress.length}**\n${progress.map((item) => `${item.emoji || '📜'} **${item.label}** — ${item.detail}`).join('\n')}`));
    } else {
      c.addTextDisplayComponents(text(lines.length ? lines.join('\n') : 'No hay cooldowns ni misiones en curso.'));
    }
    return payload(c);
  }
  c.addTextDisplayComponents(text(`**⏳ En curso · ${active.length}**\n${active.length
    ? active.map((item) => `${item.emoji || '⌛'} **${item.label}** — vuelve en **${db.formatDuration(item.remaining)}**`).join('\n')
    : 'Ninguno. Puedes jugar.'}`));
  if (progress.length) {
    c.addSeparatorComponents(sep());
    c.addTextDisplayComponents(text(`**📜 En curso · ${progress.length}**\n${progress.map((item) => `${item.emoji || '📜'} **${item.label}** — ${item.detail}`).join('\n')}`));
  }
  c.addSeparatorComponents(sep());
  c.addTextDisplayComponents(text(`**✅ Listos · ${ready.length}**\n${ready.length
    ? ready.map((item) => `${item.emoji || '🎃'} **${item.label}**`).join('\n')
    : 'Tus actividades siguen enfriándose.'}`));
  return payload(c);
}

function questCard(cfg, member, quest, { completed = false, reward = 0, gotBonus = false } = {}) {
  const c = container(completed ? cfg.COLORS.SUCCESS : cfg.COLORS.GOLD);
  const progress = completed ? quest.target : Math.max(0, quest.progress || 0);
  c.addTextDisplayComponents(text(`${completed ? '# ✅ Misión completada' : '# 📜 Encargo de la Bruja'}${member ? ` — ${member.displayName}` : ''}`));
  c.addSeparatorComponents(sep());
  c.addTextDisplayComponents(text(
    `**Objetivo:** ${quest.description}\n`
    + `**Progreso:** \`${progressBar(progress / Math.max(quest.target, 1), 14)}\` **${progress}/${quest.target}**\n`
    + (completed
      ? `🎁 Recompensa: **+${db.fmt(reward)}**${cfg.CANDY_EMOJI}${gotBonus ? ' · botín extra incluido' : ''}`
      : `-# Completa el objetivo usando los comandos del bot. Tu progreso queda guardado.`),
  ));
  return payload(c);
}

function serverStatsContainer(cfg, guildName, stats) {
  const c = container(cfg.COLORS.DARK);
  c.addTextDisplayComponents(text(`# 📊 Estadísticas de ${guildName}`));
  c.addSeparatorComponents(sep());
  c.addTextDisplayComponents(text(
    `👥 **Jugadores registrados:** ${db.fmt(stats.userCount)}\n`
    + `💰 **Candys en circulación (Cash+Bank):** ${db.fmt(stats.totalCirculating)}${cfg.CANDY_EMOJI}\n`
    + `🏦 **Guardado en bancos:** ${db.fmt(stats.totalBank)}${cfg.CANDY_EMOJI}\n`
    + `🩸 **Deuda total:** ${db.fmt(stats.totalDebt)}${cfg.CANDY_EMOJI}\n`
    + `👑 **Usuario más rico:** ${stats.richestId ? `<@${stats.richestId}>` : 'N/A'}`,
  ));
  return payload(c);
}

// ---------- Evento mundial aleatorio ----------

function worldEventStartCard(cfg, template) {
  const c = container(cfg.COLORS.GOLD);
  c.addTextDisplayComponents(text(`# ${template.title}`));
  c.addSeparatorComponents(sep());
  c.addTextDisplayComponents(text(template.description));
  c.addSeparatorComponents(sep());
  c.addTextDisplayComponents(text('-# Solo tienes que escribir cualquier mensaje en este canal para participar.'));
  return payload(c);
}

function worldEventResultCard(cfg, result) {
  const c = container(cfg.COLORS.SUCCESS);
  c.addTextDisplayComponents(text(`# ${result.template.title.replace(/^\S+\s/, '🎉 ')} — ¡Terminó!`));
  c.addSeparatorComponents(sep());
  if (!result.rewards.length) {
    c.addTextDisplayComponents(text('Nadie participó a tiempo... el evento desapareció sin dejar rastro.'));
  } else if (result.rewards.length <= 15) {
    const lines = result.rewards.map((r) => `<@${r.id}> ganó **+${db.fmt(r.amount)}**${cfg.CANDY_EMOJI}`);
    c.addTextDisplayComponents(text(lines.join('\n')));
  } else {
    const total = result.rewards.reduce((s, r) => s + r.amount, 0);
    c.addTextDisplayComponents(text(`**${result.rewards.length}** personas participaron y se repartieron **${db.fmt(total)}**${cfg.CANDY_EMOJI} en total.`));
  }
  return payload(c);
}

// ---------- Blackjack — tablero visual con cartas en ASCII ----------

function cardBox(cardStr) {
  if (cardStr === '??') return ['┌────┐', '│░░░░│', '│░░░░│', '└────┘'];
  const rank = economy.cardRank(cardStr);
  const suit = economy.cardSuit(cardStr);
  return [
    '┌────┐',
    `│${rank.padEnd(4)}│`,
    `│${suit.padStart(4)}│`,
    '└────┘',
  ];
}

function cardRow(cards, hideLast) {
  const display = hideLast ? [...cards.slice(0, -1), '??'] : cards;
  const boxes = display.map(cardBox);
  const rendered = [0, 1, 2, 3].map((i) => boxes.map((b) => b[i]).join(' ')).join('\n');
  return `\`\`\`\n${rendered}\n\`\`\``;
}

function blackjackCard(cfg, member, game, {
  hideDealer = false, footer = '', color = null,
} = {}) {
  const c = container(color || cfg.COLORS.DEFAULT);
  c.addTextDisplayComponents(text(`# 🃏 Blackjack — ${member.displayName}`));
  c.addSeparatorComponents(sep());
  const dealerVal = hideDealer ? '❓' : economy.handValue(game.dealer);
  c.addTextDisplayComponents(text(`**🂠 Dealer** — \`${dealerVal} pts\``));
  c.addTextDisplayComponents(text(cardRow(game.dealer, hideDealer)));
  c.addSeparatorComponents(sep());
  c.addTextDisplayComponents(text(`**🧑 Tu mano** — \`${economy.handValue(game.player)} pts\``));
  c.addTextDisplayComponents(text(cardRow(game.player, false)));
  c.addSeparatorComponents(sep());
  c.addTextDisplayComponents(text(`💰 **Apuesta:** ${db.fmt(game.bet)}${cfg.CANDY_EMOJI}`));
  if (footer) {
    c.addSeparatorComponents(sep());
    c.addTextDisplayComponents(text(footer));
  }
  return c;
}

function blackjackButtons(userId, disabled = false) {
  return row(
    lockedButton('bj', 'hit', userId, 'Pedir', ButtonStyle.Primary, '🃏').setDisabled(disabled),
    lockedButton('bj', 'stand', userId, 'Plantarse', ButtonStyle.Secondary, '✋').setDisabled(disabled),
  );
}

// ---------- Tragamonedas ----------

function slotsFrame(cfg, reels, { spinning = false, payout = null, bet = null } = {}) {
  let color = cfg.COLORS.DEFAULT;
  if (!spinning) color = payout > bet ? cfg.COLORS.SUCCESS : payout === bet ? cfg.COLORS.GOLD : cfg.COLORS.ERROR;
  const c = container(color);
  c.addTextDisplayComponents(text('# 🎰 Tragamonedas Embrujada'));
  c.addSeparatorComponents(sep());
  c.addTextDisplayComponents(text(`# ${reels.join('   ')}`));
  c.addSeparatorComponents(sep());
  if (spinning) {
    c.addTextDisplayComponents(text('-# Girando...'));
  } else {
    const diff = payout - bet;
    const line = diff > 0
      ? `🎉 ¡Ganaste **+${db.fmt(diff)}**${cfg.CANDY_EMOJI}! (recibiste ${db.fmt(payout)}${cfg.CANDY_EMOJI})`
      : diff === 0
        ? `Recuperaste tu apuesta (${db.fmt(payout)}${cfg.CANDY_EMOJI}).`
        : `Perdiste **-${db.fmt(bet)}**${cfg.CANDY_EMOJI}.`;
    c.addTextDisplayComponents(text(line));
  }
  return payload(c);
}

// ---------- Dados / Ruleta / Rueda ----------

function diceResultCard(cfg, bet, result) {
  const win = result.win;
  const c = container(win ? cfg.COLORS.SUCCESS : cfg.COLORS.ERROR);
  c.addTextDisplayComponents(text(`# 🎲 Dados — salió ${result.roll}`));
  c.addSeparatorComponents(sep());
  c.addTextDisplayComponents(text(win
    ? `¡Acertaste! Ganaste **+${db.fmt(result.net)}**${cfg.CANDY_EMOJI} (recibiste ${db.fmt(result.payout)}${cfg.CANDY_EMOJI}).`
    : `No acertaste. Perdiste **-${db.fmt(bet)}**${cfg.CANDY_EMOJI}.`));
  return payload(c);
}

function rouletteResultCard(cfg, bet, choiceId, result) {
  const { win } = result;
  const c = container(win ? cfg.COLORS.SUCCESS : cfg.COLORS.ERROR);
  const choiceDef = cfg.ROULETTE_COLORS.find((cl) => cl.id === choiceId);
  const choiceLabel = choiceDef ? choiceDef.label : choiceId;
  c.addTextDisplayComponents(text(`# 🎡 Ruleta Embrujada — cayó en ${result.landedLabel}`));
  c.addSeparatorComponents(sep());
  c.addTextDisplayComponents(text(win
    ? `¡Acertaste tu apuesta a **${choiceLabel}** (x${choiceDef.mult})! Ganaste **+${db.fmt(result.net)}**${cfg.CANDY_EMOJI}.`
    : `Apostaste a **${choiceLabel}**. Perdiste **-${db.fmt(bet)}**${cfg.CANDY_EMOJI}.`));
  return payload(c);
}

function rouletteSpinCard(cfg, bet, frame) {
  const colors = cfg.ROULETTE_COLORS;
  const offset = frame % colors.length;
  const wheel = [...colors.slice(offset), ...colors.slice(0, offset)]
    .map((color, index) => `${index === 0 ? '🔻 ' : ''}${color.label}`)
    .join('  ·  ');
  const c = container(cfg.COLORS.GOLD);
  c.addTextDisplayComponents(text('# 🎡 Ruleta Embrujada'));
  c.addSeparatorComponents(sep());
  c.addTextDisplayComponents(text(`🎲 **Apuesta:** ${db.fmt(bet)}${cfg.CANDY_EMOJI}\n\n${wheel}\n\n-# La rueda está girando...`));
  return payload(c);
}

function wheelResultCard(cfg, bet, result) {
  const win = result.payout > bet;
  const isPush = result.payout === bet;
  const c = container(win ? cfg.COLORS.SUCCESS : isPush ? cfg.COLORS.GOLD : cfg.COLORS.ERROR);
  c.addTextDisplayComponents(text(`# 🎡 Rueda de la Fortuna Embrujada — x${result.multiplier}`));
  c.addSeparatorComponents(sep());
  c.addTextDisplayComponents(text(win
    ? `¡La rueda te sonrió! Ganaste **+${db.fmt(result.net)}**${cfg.CANDY_EMOJI} (recibiste ${db.fmt(result.payout)}${cfg.CANDY_EMOJI}).`
    : isPush
      ? `Recuperaste tu apuesta (${db.fmt(result.payout)}${cfg.CANDY_EMOJI}).`
      : `La rueda no te favoreció. Perdiste **-${db.fmt(bet - result.payout)}**${cfg.CANDY_EMOJI}.`));
  return payload(c);
}

function wheelSpinCard(cfg, bet, frame) {
  const segments = cfg.WHEEL_SEGMENTS;
  const offset = frame % segments.length;
  const wheel = [...segments.slice(offset), ...segments.slice(0, offset)]
    .map((segment, index) => `${index === 0 ? '🔻 ' : ''}x${segment.mult}`)
    .join('  ·  ');
  const c = container(cfg.COLORS.GOLD);
  c.addTextDisplayComponents(text('# 🎡 Rueda de la Fortuna'));
  c.addSeparatorComponents(sep());
  c.addTextDisplayComponents(text(`🎲 **Apuesta:** ${db.fmt(bet)}${cfg.CANDY_EMOJI}\n\n${wheel}\n\n-# La rueda está girando...`));
  return payload(c);
}

// ---------- Confirmación genérica (admin) ----------

function confirmCard(cfg, title, body, confirmId, cancelId) {
  const c = container(cfg.COLORS.ERROR);
  c.addTextDisplayComponents(text(`# ⚠️ ${title}`));
  c.addTextDisplayComponents(text(body));
  c.addSeparatorComponents(sep());
  c.addActionRowComponents(row(
    button(confirmId, 'Sí, confirmar', ButtonStyle.Danger, '✅'),
    button(cancelId, 'Cancelar', ButtonStyle.Secondary, '✖️'),
  ));
  return payload(c);
}

// ---------- Info del evento ----------

function eventInfoCard(cfg, now) {
  const c = container(cfg.COLORS.GOLD);
  c.addTextDisplayComponents(text('# 🎃 Evento de Halloween'));
  c.addSeparatorComponents(sep());
  let status;
  if (now < cfg.EVENT_START) {
    status = `🕰️ Comienza en **${db.formatDuration(cfg.EVENT_START - now)}** (3 de octubre de 2026).`;
  } else if (now >= cfg.EVENT_END) {
    status = '🕸️ El evento ya terminó. ¡Gracias por participar!';
  } else {
    status = `🎉 ¡Activo ahora mismo! Termina en **${db.formatDuration(cfg.EVENT_END - now)}** (9 de noviembre de 2026).`;
  }
  c.addTextDisplayComponents(text(status));
  c.addSeparatorComponents(sep());
  c.addTextDisplayComponents(text(`Consulta los premios con \`${cfg.PREFIX} eventshop\`.`));
  c.addActionRowComponents(row(linkButton(cfg.EVENT_INVITE_URL, 'Ver evento en Discord', '🔗')));
  return payload(c);
}

// ---------- Ayuda ----------

const HELP_CATEGORIES = {
  economia: {
    label: '🎃 Economía', emoji: '🎃',
    text:
      '`balance` (`bal`) `[usuario]` — Cash, Bank, Debt y Total tuyo o de otra persona\n'
      + '`profile [usuario]` — Tarjeta de perfil completa\n'
      + '`deposit` (`dep`) `<cant|all>` — Guardar Candys en el banco\n'
      + '`withdraw` (`with`) `<cant|all>` — Sacar del banco (comisión hasta 10%)\n'
      + '`pay <@user> <cant|all>` — Enviar Candys a alguien\n'
      + '`debt` — Ver el detalle de tu deuda\n'
      + '`paydebt` (`pd`) `[cant]` — Pagarle a la bruja\n'
      + '`bounty` (`bnt`) `<@user> <cant>` — Poner precio a su cabeza\n'
      + '`leaderboard` (`top`) — Top 100 con botones: página y ricos/endeudados\n'
      + '`serverstats` (`stats`) — Estadísticas del servidor\n'
      + '`cooldowns` (`cd`) — Tus tiempos de espera\n'
      + '`inventory` (`inv`) `[usuario]` — Pociones, efectos y armas',
  },
  ganancia: {
    label: '💼 Ganancia', emoji: '💼',
    text:
      '`work` — Trabajar por Candys\n'
      + '`crime` — Arriesgarte por más Candys (o deuda)\n'
      + '`beg` — Pedir Candys\n'
      + '`scavenge` (`scav`) — Buscar dulces escondidos\n'
      + '`harvest` — Cosechar Candys\n'
      + '`candyraid` (`raid`) — Salir de cabalgata de dulces con riesgo\n'
      + '`daily` — Recompensa diaria (¡bono especial el último día del evento!)\n'
      + '`collect` — Reclamar el ingreso del mejor rol activado; cada rol tiene su cooldown\n'
      + '`trickortreat` (`tot`) — Dulce o truco diario\n'
      + '`rob <@user>` — Intentar robar Candys en efectivo\n'
      + '`redeem-code <código>` (`rc`) — Canjear código desde nivel 10',
  },
  rpg: {
    label: '🐺 RPG', emoji: '🐺',
    text:
      '`class [nombre|id]` — Elegir con botón o nombre/ID, sin distinguir mayúsculas\n'
      + '`hunt` — Cazar una criatura de Halloween\n'
      + '`duel <@user> <cant>` — Retar a un duelo por Candys\n'
      + '`dungeon` (`dg`) — Explorar una mazmorra embrujada\n'
      + '`boss` — Enfrentar a La Calabaza Ancestral\n'
      + '`quest` — Misión de la Bruja\n'
      + '`level` — Ver tu nivel y experiencia\n'
      + '`achievements` (`ach`) — Ver tus logros\n'
      + '`armory` (`arm`) — Tienda de armas\n'
      + '`equip <id>` — Equipar un arma que ya tengas',
  },
  casino: {
    label: '🎰 Casino Espeluznante', emoji: '🎰',
    text:
      '`gamble <cant>` (`sg`) — Doble o nada contra la bruja\n'
      + '`slots <cant>` — Tragamonedas embrujada\n'
      + '`blackjack <cant>` (`bj`) — Blackjack visual con botones\n'
      + '`dice <cant> <1-6>` — Adivina el dado (paga x5)\n'
      + '`roulette <cant|all> <color>` — Ruleta (red, black, purple, green); mínimo, sin máximo y con animación\n'
      + '`wheel <cant|all>` — Rueda animada, sin máximo, con mínimo y cooldown',
  },
  tienda: {
    label: '🛒 Tiendas', emoji: '🛒',
    text:
      '`shop` — Abre la tienda de pociones en privado\n'
      + '`eventshop` (`evshop`) — Abre la tienda de roles en privado\n'
      + '`buy <id> [cantidad]` — Comprar de cualquier tienda por texto\n'
      + '`use <id>` — Activar una poción\n'
      + '`potions` — Guía de todas las pociones',
  },
  info: {
    label: '📊 Información', emoji: '📊',
    text:
      '`eventinfo` (`einfo`) — Estado del evento de Halloween\n'
      + '`help` — Este menú',
  },
  admin: {
    label: '🛠️ Administración', emoji: '🛠️',
    text:
      '-# Solo el dueño configurado del bot puede usar estos comandos.\n'
      + '`addcandy` (`add`) `<@user> <cant>` — Dar Candys\n'
      + '`removecandy` (`rm`) `<@user> <cant>` — Quitar Candys\n'
      + '`setdebt` (`sd`) `<@user> <cant>` — Fijar deuda exacta\n'
      + '`resetuser` (`reset`) `<@user>` — Reiniciar el perfil (con confirmación)\n'
      + 'Dashboard privado — crear códigos con vencimiento y solicitar reinicio global con confirmación por DM.',
  },
};

function helpContainer(cfg, categoryKey, invokerId) {
  const key = HELP_CATEGORIES[categoryKey] ? categoryKey : 'economia';
  const cat = HELP_CATEGORIES[key];
  const c = container(cfg.COLORS.DEFAULT);
  c.addTextDisplayComponents(text(`# 🍬 Ayuda — ${cat.label}`));
  c.addTextDisplayComponents(text(`-# Prefijo: \`Xn\` (cualquier combinación de mayúsculas) · 50 comandos en total · v${cfg.BOT_VERSION}`));
  c.addSeparatorComponents(sep());
  c.addTextDisplayComponents(text(cat.text));
  c.addSeparatorComponents(sep());
  const keys = Object.keys(HELP_CATEGORIES);
  const rows = [keys.slice(0, 4), keys.slice(4)];
  for (const rowKeys of rows) {
    if (!rowKeys.length) continue;
    const buttons = rowKeys.map((k) => lockedButton(
      'help', k, invokerId,
      HELP_CATEGORIES[k].label.replace(/^\S+\s/, ''),
      k === key ? ButtonStyle.Primary : ButtonStyle.Secondary,
      HELP_CATEGORIES[k].emoji,
    ));
    c.addActionRowComponents(row(...buttons));
  }
  return payload(c);
}

module.exports = {
  text, sep, container, button, linkButton, lockedButton, row, payload, progressBar,
  successCard, errorCard, infoCard, debtCard,
  balanceCard, profileCard,
  classListContainer, armoryContainer, levelCard, achievementsContainer,
  duelChallengeCard, duelAnimationCard, duelResultCard, questCard,
  shopContainer, eventShopContainer, inventoryContainer, potionsInfoContainer,
  privateShopPrompt,
  leaderboardContainer, cooldownsContainer, serverStatsContainer,
  worldEventStartCard, worldEventResultCard,
  blackjackCard, blackjackButtons, slotsFrame,
  diceResultCard, rouletteResultCard, rouletteSpinCard, wheelSpinCard, wheelResultCard,
  confirmCard, eventInfoCard,
  helpContainer, HELP_CATEGORIES,
  ButtonStyle,
};
