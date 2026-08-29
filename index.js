/**
 * ============================================================================
 *  XERION v2.0.4 ULTRA — index.js
 * ----------------------------------------------------------------------------
 *  Punto de entrada. Junta los otros 4 archivos (config.js, database.js,
 *  visuals.js, game.js), levanta el cliente de Discord, la página
 *  informativa + endpoint de salud, y arranca todo de forma ordenada.
 *
 *  No hay lógica de juego aquí — este archivo solo conecta las piezas.
 * ============================================================================
 */

'use strict';

const express = require('express');
const { Client, GatewayIntentBits, Partials, Events, ActivityType } = require('discord.js');

const { CONFIG, CHEST_TYPE_LIST } = require('./config.js');
const db = require('./database.js');
const game = require('./game.js');

// ============================================================================
// SERVIDOR WEB — página informativa + endpoint de salud para UptimeRobot.
// No es el foco del rediseño, así que se toca lo mínimo: versión, comandos
// y la sección de probabilidades para reflejar los 3 tipos de cofre nuevos.
// ============================================================================

const TIER_CARDS_HTML = CHEST_TYPE_LIST.map((t) => {
  const arise = t.rewardTable.find((r) => r.key === 'ARISE');
  const feathers = t.rewardTable.find((r) => r.key === 'FEATHERS');
  const hex = `#${t.color.toString(16).padStart(6, '0')}`;
  return `
        <div class="reward-card" style="--accent:${hex}">
          <span class="reward-emoji">${t.emoji}</span>
          <span class="reward-name">${t.name}</span>
          <span class="reward-pct">${arise.chance}%</span>
          <span class="reward-sub">${t.tierLabel} · +${feathers.amountMin}–${feathers.amountMax} Feathers</span>
        </div>`;
}).join('\n');

const WEBSITE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Xerion — Chest-drop &amp; elimination bot</title>
<meta name="description" content="Xerion: a Discord bot where a chest can appear at any moment, but only one survivor gets to open it." />
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Anton&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@500;700&display=swap" rel="stylesheet">
<style>
  :root {
    --bg: #0c0805;
    --bg-alt: #150f0a;
    --panel: #1b140d;
    --ember: #ff5a36;
    --ember-dim: #e8442c;
    --gold: #e8b613;
    --violet: #8b5cf6;
    --crimson: #9d0208;
    --ash: #7a7168;
    --text: #f5efe6;
    --text-dim: #b6ab9d;
    --border: rgba(245, 239, 230, 0.08);
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html { scroll-behavior: smooth; }
  body {
    background: radial-gradient(ellipse at 20% -10%, #241609 0%, var(--bg) 45%), var(--bg);
    color: var(--text);
    font-family: 'Inter', sans-serif;
    line-height: 1.6;
    overflow-x: hidden;
  }
  .noise {
    position: fixed; inset: 0; pointer-events: none; z-index: 1; opacity: .035;
    background-image: radial-gradient(circle at 1px 1px, #fff 1px, transparent 0);
    background-size: 3px 3px;
  }
  .wrap { max-width: 980px; margin: 0 auto; padding: 0 24px; position: relative; z-index: 2; }
  .ember-field { position: absolute; inset: 0; overflow: hidden; z-index: 0; pointer-events: none; }
  .ember-dot {
    position: absolute; bottom: -20px; width: 5px; height: 5px; border-radius: 50%;
    background: var(--ember); box-shadow: 0 0 12px 3px rgba(255, 90, 54, .55);
    animation: rise 9s linear infinite;
    opacity: 0;
  }
  @keyframes rise {
    0% { transform: translateY(0) translateX(0); opacity: 0; }
    10% { opacity: .8; }
    90% { opacity: .3; }
    100% { transform: translateY(-620px) translateX(30px); opacity: 0; }
  }
  header.hero {
    position: relative; padding: 120px 24px 90px; text-align: center;
    border-bottom: 1px solid var(--border);
  }
  .badge {
    display: inline-flex; align-items: center; gap: 8px; font-family: 'JetBrains Mono', monospace;
    font-size: 12px; letter-spacing: .06em; color: var(--gold); background: rgba(232,182,19,.1);
    border: 1px solid rgba(232,182,19,.3); padding: 6px 14px; border-radius: 100px; margin-bottom: 28px;
  }
  .badge::before { content: '●'; color: var(--gold); font-size: 8px; }
  h1.wordmark {
    font-family: 'Anton', sans-serif; font-weight: 400; letter-spacing: .02em;
    font-size: clamp(64px, 14vw, 128px); line-height: .95;
    background: linear-gradient(180deg, #fff 0%, #ffd9c9 45%, var(--ember) 100%);
    -webkit-background-clip: text; background-clip: text; color: transparent;
    text-shadow: 0 0 80px rgba(255,90,54,.25);
  }
  .tagline { font-size: clamp(16px, 2.4vw, 20px); color: var(--text-dim); max-width: 560px; margin: 22px auto 0; }
  .tagline strong { color: var(--text); font-weight: 600; }
  section { padding: 84px 24px; position: relative; }
  section.alt { background: linear-gradient(180deg, transparent, rgba(255,255,255,.015) 15%, rgba(255,255,255,.015) 85%, transparent); }
  .eyebrow {
    font-family: 'JetBrains Mono', monospace; font-size: 12px; letter-spacing: .12em; text-transform: uppercase;
    color: var(--ember); margin-bottom: 10px;
  }
  h2 { font-family: 'Anton', sans-serif; font-weight: 400; font-size: clamp(30px, 5vw, 44px); letter-spacing: .01em; margin-bottom: 14px; }
  .lede { color: var(--text-dim); max-width: 620px; font-size: 16px; margin-bottom: 48px; }
  .steps { display: grid; grid-template-columns: repeat(4, 1fr); gap: 20px; counter-reset: step; }
  .step {
    background: var(--panel); border: 1px solid var(--border); border-radius: 14px; padding: 26px 22px;
    position: relative;
  }
  .step-num {
    font-family: 'Anton', sans-serif; font-size: 34px; color: transparent; -webkit-text-stroke: 1.5px var(--ember);
    display: block; margin-bottom: 14px;
  }
  .step h3 { font-size: 16px; margin-bottom: 8px; font-weight: 600; }
  .step p { font-size: 14px; color: var(--text-dim); }
  .rewards-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; }
  .reward-card {
    background: linear-gradient(160deg, color-mix(in srgb, var(--accent) 16%, var(--panel)), var(--panel));
    border: 1px solid color-mix(in srgb, var(--accent) 35%, var(--border));
    border-radius: 14px; padding: 22px 14px; text-align: center; display: flex; flex-direction: column; gap: 6px;
  }
  .reward-emoji { font-size: 30px; }
  .reward-name { font-weight: 700; font-size: 13px; letter-spacing: .02em; text-transform: uppercase; color: var(--text); }
  .reward-pct { font-family: 'JetBrains Mono', monospace; font-weight: 700; font-size: 19px; color: var(--accent); }
  .reward-sub { font-size: 11.5px; color: var(--text-dim); }
  .odds-note { margin-top: 22px; font-size: 13px; color: var(--text-dim); font-family: 'JetBrains Mono', monospace; }
  .cmd-table { width: 100%; border-collapse: collapse; background: var(--panel); border: 1px solid var(--border); border-radius: 14px; overflow: hidden; }
  .cmd-table th { text-align: left; font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: var(--text-dim); padding: 14px 18px; border-bottom: 1px solid var(--border); }
  .cmd-table td { padding: 14px 18px; border-bottom: 1px solid var(--border); font-size: 14px; }
  .cmd-table tr:last-child td { border-bottom: none; }
  .cmd-table code { font-family: 'JetBrains Mono', monospace; color: var(--gold); background: rgba(232,182,19,.08); padding: 3px 8px; border-radius: 6px; font-size: 13px; }
  footer { padding: 56px 24px 70px; text-align: center; border-top: 1px solid var(--border); }
  .tech { display: flex; justify-content: center; gap: 10px; flex-wrap: wrap; margin: 18px 0 26px; }
  .tech span {
    font-family: 'JetBrains Mono', monospace; font-size: 11.5px; color: var(--text-dim);
    border: 1px solid var(--border); padding: 5px 12px; border-radius: 100px;
  }
  footer .fine { font-size: 12.5px; color: var(--text-dim); max-width: 480px; margin: 0 auto; }
  footer .ver { font-family: 'JetBrains Mono', monospace; color: var(--ash); font-size: 12px; margin-top: 18px; }
  @media (max-width: 760px) {
    .steps { grid-template-columns: repeat(2, 1fr); }
    .rewards-grid { grid-template-columns: 1fr; }
    header.hero { padding: 90px 20px 64px; }
    section { padding: 60px 20px; }
  }
</style>
</head>
<body>
  <div class="noise"></div>

  <header class="hero">
    <div class="ember-field">
      ${Array.from({ length: 14 })
        .map(
          (_, i) =>
            `<div class="ember-dot" style="left:${(i * 137) % 100}%; animation-delay:${(i * 0.7).toFixed(1)}s; animation-duration:${7 + (i % 5)}s;"></div>`,
        )
        .join('')}
    </div>
    <div class="wrap">
      <div class="badge">v${CONFIG.VERSION} · live on Discord</div>
      <h1 class="wordmark">XERION</h1>
      <p class="tagline">A chest can appear <strong>at any moment</strong>. Everyone who enters thinks it's a giveaway. It isn't.</p>
    </div>
  </header>

  <section>
    <div class="wrap">
      <div class="eyebrow">How it works</div>
      <h2>Four steps. One survivor.</h2>
      <p class="lede">Xerion drops a chest into the server at random — and the longer it's been quiet, the more likely the next one shows up. What looks like a simple giveaway is actually the opposite — only the last person standing gets a shot at what's inside.</p>
      <div class="steps">
        <div class="step"><span class="step-num">01</span><h3>A chest appears</h3><p>One of 3 tiers, unannounced — it can show up after any message in the designated channel.</p></div>
        <div class="step"><span class="step-num">02</span><h3>Everyone enters</h3><p>Press Participate before the 5-minute timer runs out. Looks harmless enough.</p></div>
        <div class="step"><span class="step-num">03</span><h3>Only one remains</h3><p>The moment the timer hits zero, the group is eliminated one by one until a single survivor is left.</p></div>
        <div class="step"><span class="step-num">04</span><h3>Open it — if you dare</h3><p>The survivor pulls the lever. Legendary role, a handful of Feathers, or absolutely nothing.</p></div>
      </div>
    </div>
  </section>

  <section class="alt">
    <div class="wrap">
      <div class="eyebrow">The odds</div>
      <h2>It's called Xerion for a reason.</h2>
      <p class="lede">This isn't a generous loot table. Most chests give nothing at all, even at the rarest tier — but the rare ones are worth the risk.</p>
      <div class="rewards-grid">
        ${TIER_CARDS_HTML}
      </div>
      <p class="odds-note">Spawn chance starts at ${(CONFIG.BASE_SPAWN_CHANCE * 100).toFixed(0)}% and climbs +${(CONFIG.PROBABILITY_STEP_INCREASE * 100).toFixed(0)}% every ${CONFIG.PROBABILITY_STEP_MESSAGES} messages without a chest, up to ${(CONFIG.MAX_SPAWN_CHANCE * 100).toFixed(0)}% · 5 minute join window</p>
    </div>
  </section>

  <section>
    <div class="wrap">
      <div class="eyebrow">Commands</div>
      <h2>Slash &amp; prefix, your call.</h2>
      <p class="lede">Prefix commands use <code style="font-family:'JetBrains Mono',monospace;color:var(--gold)">${CONFIG.PREFIX}</code>. Every command works both ways.</p>
      <table class="cmd-table">
        <tr><th>Command</th><th>Description</th></tr>
        <tr><td><code>/profile</code></td><td>View your Feathers, roles won, rank and win rate</td></tr>
        <tr><td><code>/inventory</code></td><td>Quick balance and item check</td></tr>
        <tr><td><code>/cooldowns</code></td><td>See when your /daily and each role's passive income are ready</td></tr>
        <tr><td><code>/leaderboard</code></td><td>Top Feather holders on the server</td></tr>
        <tr><td><code>/rates</code></td><td>Full odds for all 3 chest tiers</td></tr>
        <tr><td><code>/portals</code></td><td>Odds and payout split for all 3 portal ranks</td></tr>
        <tr><td><code>/event</code></td><td>See the active global event, if any</td></tr>
        <tr><td><code>/shop</code></td><td>Spend Feathers on Shields, Luck Charms and Phoenix Feathers (max 5 items)</td></tr>
        <tr><td><code>/notification</code></td><td>Toggle a DM alert for when a chest appears</td></tr>
        <tr><td><code>/stats</code></td><td>Server-wide Xerion stats</td></tr>
        <tr><td><code>/help</code></td><td>List every command</td></tr>
        <tr><td><code>/chest</code></td><td>Live status, channel counters and current chance</td></tr>
        <tr><td><code>/daily</code></td><td>Claim 25 Feathers every 24 hours and build your streak</td></tr>
        <tr><td><code>/claim</code></td><td>Collect passive Feathers earned by the roles you own</td></tr>
        <tr><td><code>/history</code></td><td>Review your latest rewards</td></tr>
        <tr><td><code>/achievements</code></td><td>Track permanent Xerion milestones</td></tr>
        <tr><td><code>/streak</code></td><td>Your daily streak, and whether it shows on your nickname</td></tr>
        <tr><td><code>/ping</code> · <code>/about</code> · <code>/rules</code></td><td>Diagnostics, version and game rules</td></tr>
        <tr><td><code>@Xerion</code></td><td>Mention the bot (or reply to one of its AI messages) to chat — powered by Groq, never pings anyone</td></tr>
        <tr><td><code>/panel-owner</code></td><td>Owner-only — full control panel: force chests, force portals, activate/cancel a global event</td></tr>
      </table>
    </div>
  </section>

  <footer>
    <div class="tech">
      <span>discord.js v14</span>
       <span>Components V2 everywhere</span>
      <span>PostgreSQL / Neon</span>
      <span>Express</span>
    </div>
    <p class="fine">This page is informational only — there's no dashboard or login here, just what Xerion is and how it plays.</p>
    <p class="ver">Xerion v${CONFIG.VERSION}</p>
  </footer>
</body>
</html>`;

function createWebServer() {
  const app = express();

  app.get('/', (_req, res) => {
    res.type('html').send(WEBSITE_HTML);
  });

  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      bot: CONFIG.BOT_NAME,
      version: CONFIG.VERSION,
      discordReady: client.isReady(),
      uptimeSeconds: Math.floor(process.uptime()),
    });
  });

  return app;
}

// ============================================================================
// CLIENTE DE DISCORD
// ============================================================================

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.Message, Partials.Channel],
});

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`[Xerion] Conectado como ${readyClient.user.tag}.`);

  readyClient.user.setPresence({
    status: 'dnd',
    activities: [{ name: `${CONFIG.PREFIX} help · v${CONFIG.VERSION}`, type: ActivityType.Watching }],
  });

  // Limpia cualquier slash command clonado de un proyecto/versión anterior
  // y registra únicamente el set actual de comandos.
  await game.clearAndRegisterSlashCommands(readyClient);
  await game.restoreActiveChest(readyClient);
  await game.restorePortals(readyClient);
  await game.restoreEvent(readyClient);

  // Chequeo de portales: se revisa cada pocos minutos si ya pasó 1h desde
  // el último chequeo (el reloj real vive en la base de datos, así que un
  // reinicio del bot no lo reinicia — ver checkPortalSpawn/getLastPortalCheckAt).
  const portalChannel = await readyClient.channels.fetch(CONFIG.PORTAL_CHANNEL_ID).catch((err) => {
    console.error('[Xerion] No se pudo obtener el canal de portales:', err.message);
    return null;
  });
  if (portalChannel) {
    setInterval(() => {
      game.checkPortalSpawn(portalChannel).catch((err) => console.error('[Xerion] Error en el chequeo periódico de portal:', err));
    }, 5 * 60 * 1000);
  }
});

client.on(Events.MessageCreate, (message) => {
  game.handleMessage(message).catch((err) => console.error('[Xerion] Error no capturado en handleMessage:', err));
});

client.on(Events.InteractionCreate, (interaction) => {
  game.handleInteraction(interaction).catch((err) => console.error('[Xerion] Error no capturado en handleInteraction:', err));
});

client.on(Events.Error, (err) => console.error('[Xerion] Error del cliente de Discord:', err));

// El bot nunca se reinicia solo por un error de ejecución — todo lo que toca
// Discord o la base de datos ya va envuelto en try/catch en game.js /
// database.js, y estos dos manejadores son la última red de seguridad: solo
// registran el error en el log, jamás llaman a process.exit().
process.on('unhandledRejection', (err) => console.error('[Xerion] Unhandled rejection:', err));
process.on('uncaughtException', (err) => console.error('[Xerion] Uncaught exception:', err));

// ============================================================================
// ARRANQUE
// ============================================================================

/**
 * client.login() puede quedarse colgado para siempre sin resolver NI
 * rechazar si hay un problema de red saliente hacia Discord (o un token con
 * espacios/saltos de línea de más) — y sin eso, el proceso nunca loguea
 * nada ni se reinicia solo. Este límite de tiempo convierte ese silencio en
 * un error visible en los logs, y hace que Render reinicie el servicio
 * automáticamente en vez de quedar trabado indefinidamente.
 */
async function loginWithTimeout(discordClient, token, timeoutMs = 30000) {
  let timeoutHandle;
  const timeout = new Promise((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(
        new Error(
          `client.login() no respondió en ${timeoutMs / 1000}s. Casi siempre es DISCORD_TOKEN mal copiado ` +
            `(espacios o saltos de línea de sobra) o una falla de red saliente hacia Discord — no es un bug de código.`,
        ),
      );
    }, timeoutMs);
  });
  try {
    return await Promise.race([discordClient.login(token), timeout]);
  } finally {
    clearTimeout(timeoutHandle);
  }
}

async function main() {
  await db.initDatabase();

  const app = createWebServer();
  const server = app.listen(CONFIG.PORT, () => {
    console.log(`[Xerion] Servidor web escuchando en el puerto ${CONFIG.PORT}.`);
  });

  console.log('[Xerion] Conectando con Discord...');
  await loginWithTimeout(client, CONFIG.TOKEN, 30000);

  const shutdown = async (signal) => {
    console.log(`[Xerion] ${signal} recibido — cerrando de forma ordenada...`);
    server.close();
    client.destroy();
    await db.pool.end().catch(() => {});
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('[Xerion] Error fatal durante el arranque:', err);
  process.exit(1);
});
