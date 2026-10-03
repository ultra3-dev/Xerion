'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SESSION_COOKIE = 'xerion_dashboard';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const RESET_TOKEN_TTL_MS = 10 * 60 * 1000;
const MAX_BODY_BYTES = 8192;

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function sendJson(response, status, value, extraHeaders = {}) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    ...extraHeaders,
  });
  response.end(JSON.stringify(value));
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Request body too large'), { statusCode: 413 }));
        request.destroy();
      }
    });
    request.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (_) {
        reject(Object.assign(new Error('Invalid JSON'), { statusCode: 400 }));
      }
    });
    request.on('error', reject);
  });
}

function requestIp(request) {
  return String(request.headers['x-forwarded-for'] || request.socket.remoteAddress || 'unknown')
    .split(',')[0]
    .trim()
    .slice(0, 100);
}

function createDashboardHandler({ db, economy, client, cfg, onResetProgress = () => {} }) {
  const sessions = new Map();
  const loginFailures = new Map();
  let resetChallenge = null;
  let resetLastRequestedAt = 0;

  function sessionSignature(id) {
    return crypto.createHmac('sha256', process.env.SESSION_SECRET || '').update(id).digest('hex');
  }

  function readSession(request) {
    const cookies = String(request.headers.cookie || '').split(';');
    const entry = cookies.map((cookie) => cookie.trim()).find((cookie) => cookie.startsWith(`${SESSION_COOKIE}=`));
    if (!entry) return null;
    const token = decodeURIComponent(entry.slice(SESSION_COOKIE.length + 1));
    const separator = token.lastIndexOf('.');
    if (separator < 1) return null;
    const id = token.slice(0, separator);
    const signature = token.slice(separator + 1);
    if (!safeEqual(signature, sessionSignature(id))) return null;
    const session = sessions.get(id);
    if (!session || session.expiresAt <= Date.now()) {
      sessions.delete(id);
      return null;
    }
    return { id, session };
  }

  function cookieOptions(maxAgeSeconds) {
    const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
    return `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}${secure}`;
  }

  function sessionCookie(id) {
    const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
    return `${SESSION_COOKIE}=${encodeURIComponent(`${id}.${sessionSignature(id)}`)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secure}`;
  }

  function requireSession(request, response) {
    const current = readSession(request);
    if (!current) {
      sendJson(response, 401, { error: 'unauthorized' });
      return null;
    }
    current.session.expiresAt = Date.now() + SESSION_TTL_MS;
    return current;
  }

  async function handle(request, response) {
    const url = new URL(request.url, 'http://localhost');
    const pathname = url.pathname;

    if (request.method === 'GET' && (pathname === '/dashboard' || pathname === '/dashboard/')) {
      const page = fs.readFileSync(path.join(__dirname, 'public', 'dashboard.html'));
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'X-Frame-Options': 'DENY',
        'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      });
      response.end(page);
      return true;
    }

    if (!pathname.startsWith('/api/dashboard/')) return false;

    if (request.method === 'POST' && pathname === '/api/dashboard/login') {
      if (!process.env.DASHBOARD_PASSWORD || !process.env.SESSION_SECRET) {
        sendJson(response, 503, { error: 'dashboard_not_configured' });
        return true;
      }
      const ip = requestIp(request);
      const failures = loginFailures.get(ip) || { count: 0, blockedUntil: 0 };
      if (failures.blockedUntil > Date.now()) {
        sendJson(response, 429, { error: 'try_later' });
        return true;
      }
      const body = await readJson(request);
      if (!safeEqual(body.password || '', process.env.DASHBOARD_PASSWORD)) {
        failures.count += 1;
        if (failures.count >= 8) {
          failures.count = 0;
          failures.blockedUntil = Date.now() + 15 * 60 * 1000;
        }
        loginFailures.set(ip, failures);
        sendJson(response, 401, { error: 'invalid_login' });
        return true;
      }
      loginFailures.delete(ip);
      for (const [sessionId, session] of sessions) {
        if (session.expiresAt <= Date.now()) sessions.delete(sessionId);
      }
      const id = crypto.randomBytes(32).toString('hex');
      sessions.set(id, { expiresAt: Date.now() + SESSION_TTL_MS });
      sendJson(response, 200, { ok: true }, { 'Set-Cookie': sessionCookie(id) });
      return true;
    }

    if (request.method === 'POST' && pathname === '/api/dashboard/logout') {
      const current = readSession(request);
      if (current) sessions.delete(current.id);
      sendJson(response, 200, { ok: true }, { 'Set-Cookie': cookieOptions(0) });
      return true;
    }

    if (pathname === '/api/dashboard/me' && request.method === 'GET') {
      const current = requireSession(request, response);
      if (!current) return true;
      sendJson(response, 200, { ok: true, expiresAt: current.session.expiresAt });
      return true;
    }

    if (pathname === '/api/dashboard/codes' && request.method === 'GET') {
      if (!requireSession(request, response)) return true;
      sendJson(response, 200, { codes: await db.listRedeemCodes() });
      return true;
    }

    if (pathname === '/api/dashboard/codes' && request.method === 'POST') {
      if (!requireSession(request, response)) return true;
      const body = await readJson(request);
      const reward = Number(body.reward);
      const result = await db.createRedeemCode(body.code, reward, body.expiresAt, cfg.OWNER_ID);
      if (result.error === 'invalid') {
        sendJson(response, 400, { error: 'invalid_code' });
        return true;
      }
      if (result.error === 'exists') {
        sendJson(response, 409, { error: 'code_exists' });
        return true;
      }
      sendJson(response, 201, { code: result.code });
      return true;
    }

    if (request.method === 'DELETE' && pathname.startsWith('/api/dashboard/codes/')) {
      if (!requireSession(request, response)) return true;
      const code = decodeURIComponent(pathname.slice('/api/dashboard/codes/'.length));
      const deleted = await db.deleteRedeemCode(code);
      sendJson(response, deleted ? 200 : 404, deleted ? { ok: true } : { error: 'not_found' });
      return true;
    }

    if (request.method === 'POST' && pathname === '/api/dashboard/reset/request') {
      if (!requireSession(request, response)) return true;
      if (Date.now() - resetLastRequestedAt < 60 * 1000) {
        sendJson(response, 429, { error: 'reset_rate_limited' });
        return true;
      }
      resetLastRequestedAt = Date.now();
      const token = String(crypto.randomBytes(4).readUInt32BE(0) % 100000000).padStart(8, '0');
      resetChallenge = {
        tokenHash: crypto.createHash('sha256').update(token).digest('hex'),
        expiresAt: Date.now() + RESET_TOKEN_TTL_MS,
      };
      try {
        const owner = await client.users.fetch(cfg.OWNER_ID);
        await owner.send(
          `Xerion: código de confirmación para reiniciar el progreso global: ${token}. `
          + `Vence en 10 minutos. Si no solicitaste esto, ignora el mensaje.`,
        );
      } catch (err) {
        resetChallenge = null;
        console.error('[Dashboard] No se pudo enviar el código de reinicio por DM:', err.message);
        sendJson(response, 502, { error: 'dm_failed' });
        return true;
      }
      sendJson(response, 200, { ok: true, expiresInSeconds: RESET_TOKEN_TTL_MS / 1000 });
      return true;
    }

    if (request.method === 'POST' && pathname === '/api/dashboard/reset/confirm') {
      if (!requireSession(request, response)) return true;
      const body = await readJson(request);
      const token = String(body.token || '').trim();
      const submittedHash = crypto.createHash('sha256').update(token).digest('hex');
      if (!resetChallenge || resetChallenge.expiresAt <= Date.now()
        || !safeEqual(submittedHash, resetChallenge.tokenHash)) {
        resetChallenge = null;
        sendJson(response, 403, { error: 'invalid_reset_token' });
        return true;
      }
      resetChallenge = null;
      onResetProgress(true);
      try {
        const result = await db.resetAllProgress();
        economy.resetTransientState();
        sendJson(response, 200, { ok: true, usersReset: result.usersReset });
      } finally {
        onResetProgress(false);
      }
      return true;
    }

    sendJson(response, 404, { error: 'not_found' });
    return true;
  }

  return handle;
}

module.exports = { createDashboardHandler };