/**
 * ============================================================================
 *  XERION v2.0.5 ULTRA — admin-panel.js
 * ----------------------------------------------------------------------------
 *  El nuevo `/panel-owner`: un panel Ephemeral Components V2 único, solo
 *  para el owner, que reemplaza el flujo manual de `/spawn` con un centro de
 *  control completo — forzar cofres, forzar portales, y activar/cancelar
 *  un evento global — todo desde el mismo mensaje, que se re-renderiza
 *  (interaction.update) después de cada acción en vez de mandar uno nuevo
 *  cada vez.
 *
 *  A propósito NO importa nada de game.js (evitaría una dependencia
 *  circular, porque game.js sí importa este archivo para registrar el
 *  comando). Todo lo que necesita de la lógica del juego le llega en
 *  `gameApi`, un objeto de funciones que game.js arma y pasa en cada
 *  llamada — este archivo solo entiende de Discord UI y enrutamiento.
 * ============================================================================
 */

'use strict';

const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { CONFIG } = require('./config.js');
const visuals = require('./visuals.js');

const commandDefinition = new SlashCommandBuilder()
  .setName('panel-owner')
  .setDescription('[Owner] Panel de control: forzar cofres, forzar portales, activar/cancelar eventos.')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

function isOwner(interaction) {
  return interaction.user.id === CONFIG.OWNER_ID;
}

async function renderStatus(gameApi) {
  const status = await gameApi.getOwnerPanelStatus();
  return visuals.buildOwnerPanelContainer(status);
}

/** `/panel-owner` — primer render. */
async function cmdPanelOwner(interaction, gameApi) {
  if (!isOwner(interaction)) {
    return interaction.reply({ content: 'This command is owner-only.', flags: MessageFlags.Ephemeral });
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const container = await renderStatus(gameApi);
    return interaction.editReply({ components: [container], flags: MessageFlags.IsComponentsV2 });
  } catch (err) {
    console.error('[Xerion] Error renderizando /panel-owner:', err);
    return interaction.editReply('No pude armar el panel — revisa los logs.');
  }
}

/** true si este customId (botón o select menu) pertenece al panel del owner — así game.js sabe cuándo delegar acá. */
function isRelevant(customId) {
  return customId.startsWith('xerion_admin_');
}

/**
 * Enruta cualquier botón/select del panel. Siempre re-renderiza el mismo
 * mensaje ephemeral al final (interaction.editReply), tanto si la acción
 * salió bien como si no — el panel nunca debería quedar "colgado".
 */
async function handleComponent(interaction, gameApi) {
  if (!isOwner(interaction)) {
    return interaction.reply({ content: 'This panel is owner-only.', flags: MessageFlags.Ephemeral });
  }

  await interaction.deferUpdate();
  let notice = null;

  try {
    if (interaction.customId.startsWith('xerion_admin_chest::')) {
      const key = interaction.customId.split('::')[1];
      const channel = await interaction.client.channels.fetch(CONFIG.CHEST_CHANNEL_ID).catch(() => null);
      if (!channel) {
        notice = 'No pude encontrar el canal de cofres configurado.';
      } else {
        const result = await gameApi.tryForceSpawnChest(channel, key === 'RANDOM' ? null : key);
        if (!result.spawned) {
          notice =
            result.reason === 'max'
              ? `Ya hay ${CONFIG.OWNER_FORCE_MAX_ACTIVE} cofres forzados activos (el máximo).`
              : `Espera ${Math.ceil((result.cooldownMsLeft || 0) / 1000)}s más antes de forzar otro.`;
        } else {
          notice = `✅ Cofre forzado en <#${CONFIG.CHEST_CHANNEL_ID}>.`;
        }
      }
    } else if (interaction.customId.startsWith('xerion_admin_portal::')) {
      const key = interaction.customId.split('::')[1];
      const channel = await interaction.client.channels.fetch(CONFIG.PORTAL_CHANNEL_ID).catch(() => null);
      if (!channel) {
        notice = 'No pude encontrar el canal de portales configurado.';
      } else {
        const spawned = await gameApi.forcePortalSpawn(channel, key === 'RANDOM' ? null : key);
        notice = spawned ? `✅ Portal forzado en <#${CONFIG.PORTAL_CHANNEL_ID}>.` : 'Ya hay un portal activo en ese canal — espera a que se cierre.';
      }
    } else if (interaction.customId === 'xerion_admin_event_select') {
      const key = interaction.values?.[0];
      const channel = await interaction.client.channels.fetch(CONFIG.CHEST_CHANNEL_ID).catch(() => null);
      if (!channel) {
        notice = 'No pude encontrar el canal configurado para anunciar el evento.';
      } else if (await gameApi.getCurrentEvent()) {
        notice = 'Ya hay un evento activo — cancélalo antes de activar otro.';
      } else {
        const type = await gameApi.activateEvent(channel, key === 'RANDOM' ? null : key);
        notice = `🎉 Evento activado: ${type.name} ${type.emoji}`;
      }
    } else if (interaction.customId === 'xerion_admin_event_cancel') {
      await gameApi.deactivateEvent(interaction.client, { announce: true });
      notice = '⛔ Evento cancelado.';
    } else if (interaction.customId === 'xerion_admin_refresh') {
      notice = '🔄 Panel actualizado.';
    }
  } catch (err) {
    console.error('[Xerion] Error manejando una acción de /panel-owner:', err);
    notice = 'Algo salió mal con esa acción — revisa los logs. El panel sigue funcionando.';
  }

  try {
    const container = await renderStatus(gameApi);
    await interaction.editReply({ components: [container], flags: MessageFlags.IsComponentsV2 });
    if (notice) await interaction.followUp({ content: notice, flags: MessageFlags.Ephemeral }).catch(() => {});
  } catch (err) {
    console.error('[Xerion] Error re-renderizando /panel-owner tras una acción:', err);
  }
}

module.exports = {
  commandDefinition,
  cmdPanelOwner,
  isRelevant,
  handleComponent,
};
