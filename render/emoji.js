'use strict';

// ============================================================
//  EMOJI — Emojis Apple (iOS) para el canvas, con respaldo vectorial.
//
//  Orden de búsqueda de cada emoji:
//    1. memoria (ya decodificado)
//    2. assets/emoji/<codepoint>.png      ← PNG propios que quieras incluir en el repo
//    3. caché en disco (XERION_EMOJI_CACHE_DIR, por defecto el directorio temporal del sistema)
//    4. descarga HTTPS del conjunto Apple de `emoji-datasource-apple` (jsDelivr, ver XERION_EMOJI_BASE_URL)
//    5. iconos vectoriales de respaldo (emoji-art.js): nunca hay cuadros vacíos ni emojis rotos
//
//  Dibujar NUNCA espera a la red: si el PNG aún no está en memoria se usa el icono vectorial y la
//  descarga continúa en segundo plano (preload() al arrancar el bot los deja listos).
//  XERION_EMOJI_SOURCE=off desactiva por completo las descargas (solo iconos vectoriales).
// ============================================================

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const { decodePNG } = require('./png');
const { ART } = require('./emoji-art');

const EMOJI = {
  pumpkin: { char: '🎃', code: '1f383' },
  ghost: { char: '👻', code: '1f47b' },
  bat: { char: '🦇', code: '1f987' },
  candy: { char: '🍬', code: '1f36c' },
  crown: { char: '👑', code: '1f451' },
  skull: { char: '💀', code: '1f480' },
  boom: { char: '💥', code: '1f4a5' },
  sparkle: { char: '✨', code: '2728' },
};

const DEFAULT_BASE_URL = 'https://cdn.jsdelivr.net/npm/emoji-datasource-apple/img/apple/64';
const MAX_PNG_BYTES = 200 * 1024;
const RETRY_AFTER_MS = 5 * 60 * 1000;

const config = {
  source: (process.env.XERION_EMOJI_SOURCE || 'apple').toLowerCase(),
  baseUrl: (process.env.XERION_EMOJI_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, ''),
  cacheDir: process.env.XERION_EMOJI_CACHE_DIR || path.join(os.tmpdir(), 'xerion-emoji-cache'),
  localDir: path.join(__dirname, '..', 'assets', 'emoji'),
  timeoutMs: 4000,
  fetchBuffer: null, // inyectable en pruebas: async (url) => Buffer
};

const images = new Map(); // nombre -> imagen decodificada {width,height,data}
const pending = new Map(); // nombre -> Promise
const failedAt = new Map(); // nombre -> timestamp del último fallo
let version = 0; // sube cada vez que entra un PNG Apple nuevo (invalida fondos/paletas cacheados)

function configure(patch = {}) {
  Object.assign(config, patch);
}

function reset() {
  version += 1;
  images.clear();
  pending.clear();
  failedAt.clear();
}

function fetchHttps(url, redirects = 3) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); } catch (err) { reject(err); return; }
    if (parsed.protocol !== 'https:') { reject(new Error('Solo se permiten descargas HTTPS')); return; }
    const request = https.get(parsed, { timeout: config.timeoutMs, headers: { 'User-Agent': 'xerion-bot-emoji-loader' } }, (response) => {
      if ([301, 302, 307, 308].includes(response.statusCode) && response.headers.location && redirects > 0) {
        response.resume();
        resolve(fetchHttps(new URL(response.headers.location, parsed).toString(), redirects - 1));
        return;
      }
      if (response.statusCode !== 200) { response.resume(); reject(new Error(`HTTP ${response.statusCode}`)); return; }
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_PNG_BYTES) { request.destroy(new Error('Emoji demasiado grande')); return; }
        chunks.push(chunk);
      });
      response.on('end', () => resolve(Buffer.concat(chunks)));
      response.on('error', reject);
    });
    request.on('timeout', () => request.destroy(new Error('Tiempo de espera agotado')));
    request.on('error', reject);
  });
}

function validate(buffer) {
  const image = decodePNG(buffer, { maxPixels: 256 * 256, maxBytes: MAX_PNG_BYTES });
  if (image.width < 16 || image.height < 16 || image.width > 256 || image.height > 256) throw new Error('Tamaño de emoji inesperado');
  return image;
}

async function readIfExists(file) {
  try { return await fs.promises.readFile(file); } catch (err) { return null; }
}

async function loadOne(name) {
  const entry = EMOJI[name];
  if (!entry) return null;
  const fileName = `${entry.code}.png`;
  for (const dir of [config.localDir, config.cacheDir]) {
    const buffer = await readIfExists(path.join(dir, fileName));
    if (buffer) {
      try { return validate(buffer); } catch (err) { /* archivo dañado: se ignora y se sigue */ }
    }
  }
  if (config.source === 'off') return null;
  const getBuffer = config.fetchBuffer || fetchHttps;
  const buffer = await getBuffer(`${config.baseUrl}/${fileName}`);
  const image = validate(buffer);
  try {
    await fs.promises.mkdir(config.cacheDir, { recursive: true });
    await fs.promises.writeFile(path.join(config.cacheDir, fileName), buffer);
  } catch (err) { /* la caché en disco es opcional */ }
  return image;
}

function load(name) {
  if (images.has(name)) return Promise.resolve(images.get(name));
  if (pending.has(name)) return pending.get(name);
  if (failedAt.has(name) && Date.now() - failedAt.get(name) < RETRY_AFTER_MS) return Promise.resolve(null);
  const promise = loadOne(name)
    .then((image) => {
      if (image) { images.set(name, image); version += 1; } else failedAt.set(name, Date.now());
      return image;
    })
    .catch(() => { failedAt.set(name, Date.now()); return null; })
    .finally(() => { pending.delete(name); });
  pending.set(name, promise);
  return promise;
}

// Descarga/lee en segundo plano. No lanza nunca.
function preload(names = Object.keys(EMOJI)) {
  return Promise.allSettled(names.map((name) => load(name)));
}

function hasImage(name) {
  return images.has(name);
}

function getVersion() {
  return version;
}

// Dibuja el emoji centrado en (cx, cy) con lado `size`: PNG Apple si está en memoria, si no el vector de respaldo.
function drawEmoji(surface, name, cx, cy, size, { opacity = 1 } = {}) {
  const image = images.get(name);
  if (image) {
    surface.drawImage(image, cx - size / 2, cy - size / 2, size, size, { opacity });
    return 'apple';
  }
  if (!EMOJI[name]) throw new Error(`Emoji desconocido: ${name}`);
  if (!images.has(name) && !pending.has(name)) void load(name);
  if (opacity < 1) {
    const layer = new (require('./raster').Surface)(surface.w, surface.h);
    ART[name](layer, cx, cy, size);
    surface.blit(layer, 0, 0, opacity);
  } else {
    ART[name](surface, cx, cy, size);
  }
  return 'vector';
}

module.exports = {
  EMOJI, DEFAULT_BASE_URL, configure, reset, load, preload, hasImage, getVersion, drawEmoji, config,
};
