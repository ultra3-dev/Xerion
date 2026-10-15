'use strict';

// ============================================================
//  KEEPALIVE — Opción de ahorro (APAGADA por defecto).
//
//  Un servicio web GRATUITO de Render se suspende tras 15 minutos sin tráfico HTTP entrante, y un bot de
//  Discord casi no recibe HTTP. Con KEEP_ALIVE=on el bot se hace una petición a su propia URL pública
//  (/health) cada 10 minutos para que Render no lo suspenda. Úsalo SOLO junto con el plan Free
//  (ver render.free.yaml y docs/COSTOS.md). En el plan Starter no hace falta y no debe activarse.
//
//  Variables:
//    KEEP_ALIVE=on            activa los pings
//    KEEP_ALIVE_URL=https://…  URL pública (por defecto RENDER_EXTERNAL_URL, que Render define solo)
//    KEEP_ALIVE_MINUTES=10    intervalo (1–14 minutos)
// ============================================================

const https = require('node:https');

const DEFAULT_MINUTES = 10;

function resolveKeepAlive(env = process.env) {
  if (String(env.KEEP_ALIVE || '').trim().toLowerCase() !== 'on') return null;
  const base = String(env.KEEP_ALIVE_URL || env.RENDER_EXTERNAL_URL || '').trim();
  if (!base) return null;
  let url;
  try { url = new URL('/health', base); } catch (err) { return null; }
  if (url.protocol !== 'https:') return null; // solo HTTPS: nada de pings en claro
  const requested = Number(env.KEEP_ALIVE_MINUTES);
  const minutes = Number.isFinite(requested) && requested >= 1 && requested <= 14 ? Math.floor(requested) : DEFAULT_MINUTES;
  return { url: url.toString(), intervalMs: minutes * 60 * 1000 };
}

// request: función compatible con https.get (inyectable en pruebas). Devuelve { stop, ping } o null.
function startKeepAlive({ url, intervalMs }, { request = https.get, log = console } = {}) {
  if (!url || !(intervalMs > 0)) return null;
  const ping = () => {
    try {
      const req = request(url, { timeout: 10_000 }, (res) => { res.resume(); });
      req.on('error', () => {});
      req.on('timeout', () => req.destroy());
    } catch (err) { /* un ping fallido nunca debe tumbar el bot */ }
  };
  const timer = setInterval(ping, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  log.log(`[KeepAlive] Activo: ping a ${new URL(url).origin} cada ${Math.round(intervalMs / 60000)} min (solo para el plan Free).`);
  return { ping, stop: () => clearInterval(timer) };
}

module.exports = { resolveKeepAlive, startKeepAlive, DEFAULT_MINUTES };
