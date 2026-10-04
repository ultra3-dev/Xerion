'use strict';

const crypto = require('crypto');
const { URLSearchParams } = require('url');

const sessions = new Map();
const loginAttempts = new Map();
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const RESET_TOKEN_TTL_MS = 10 * 60 * 1000;
const MAX_BODY_BYTES = 16 * 1024;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}

function constantTimeEqual(actual, expected) {
  const a = Buffer.from(String(actual || ''), 'utf8');
  const b = Buffer.from(String(expected || ''), 'utf8');
  if (a.length !== b.length) {
    const padded = Buffer.alloc(b.length);
    a.copy(padded, 0, 0, Math.min(a.length, padded.length));
    crypto.timingSafeEqual(padded, b);
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

function securityHeaders(response) {
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  );
}

function sendHtml(response, status, html) {
  securityHeaders(response);
  response.writeHead(status);
  response.end(html);
}

function redirect(response, location) {
  response.writeHead(303, { Location: location, 'Cache-Control': 'no-store' });
  response.end();
}

function page(title, content) {
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} · Xerion Admin</title>
<style>
:root{color-scheme:dark;--bg:#111318;--panel:#1b1e26;--line:#343946;--text:#f4f5f7;--muted:#aab0bd;--accent:#ff8a32;--danger:#ff646e;--ok:#77d69a}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.55 system-ui,sans-serif}
main{max-width:940px;margin:40px auto;padding:0 20px 48px}h1{font-size:2rem;margin:0 0 4px}h2{font-size:1.2rem;margin:0 0 12px}
p{color:var(--muted);margin:.35rem 0 1rem}.panel{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:20px;margin:18px 0}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}.stat{border:1px solid var(--line);border-radius:10px;padding:14px}.stat b{display:block;font-size:1.4rem}
label{display:block;font-weight:650;margin:12px 0 5px}input{width:100%;border:1px solid var(--line);background:#101218;color:var(--text);border-radius:8px;padding:11px;font:inherit}
button{border:0;border-radius:8px;padding:10px 14px;background:var(--accent);color:#17120d;font:inherit;font-weight:750;cursor:pointer;margin-top:12px}
button.danger{background:var(--danger)}.notice{border-left:4px solid var(--accent);padding:10px 14px;background:#282119;border-radius:5px;margin:16px 0}.ok{border-color:var(--ok)}.error{border-color:var(--danger)}
.table-wrap{overflow-x:auto}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:10px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-size:.9rem}
.inline{display:flex;align-items:center;gap:10px}.inline button{margin:0}.muted{color:var(--muted);font-size:.9rem}.danger-text{color:var(--danger)}
@media(max-width:600px){main{margin:24px auto;padding:0 12px 32px}.panel{padding:15px}.inline{align-items:flex-start;flex-direction:column}}
</style></head><body><main>${content}</main></body></html>`;
}

function loginPage(message = '') {
  const notice = message ? `<div class="notice error">${escapeHtml(message)}</div>` : '';
  return page('Acceso', `<h1>🎃 Xerion Admin</h1><p>Panel privado de administración.</p>${notice}
<section class="panel"><form method="post" action="/admin/login">
<label for="secret">Secreto del dashboard</label><input id="secret" name="secret" type="password" autocomplete="current-password" required>
<button type="submit">Iniciar sesión</button></form></section>`);
}

function cookieValue(request, key) {
  const header = request.headers.cookie || '';
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === key) return decodeURIComponent(rest.join('='));
  }
  return '';
}

function getSession(request) {
  const id = cookieValue(request, 'xerion_admin');
  const session = sessions.get(id);
  if (!session || session.expiresAt <= Date.now()) {
    if (id) sessions.delete(id);
    return null;
  }
  return { id, ...session };
}

function setSessionCookie(response, id, production) {
  const secure = production ? '; Secure' : '';
  response.setHeader('Set-Cookie', `xerion_admin=${encodeURIComponent(id)}; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secure}`);
}

function clearSessionCookie(response, production) {
  const secure = production ? '; Secure' : '';
  response.setHeader('Set-Cookie', `xerion_admin=; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=0${secure}`);
}

function readForm(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    let tooLarge = false;
    request.on('data', (chunk) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        reject(Object.assign(new Error('Body too large'), { statusCode: 413 }));
        return;
      }
      body += chunk.toString('utf8');
    });
    request.on('end', () => {
      if (!tooLarge) resolve(Object.fromEntries(new URLSearchParams(body)));
    });
    request.on('error', reject);
  });
}

function csrfField(session) {
  return `<input type="hidden" name="csrf" value="${escapeHtml(session.csrf)}">`;
}

function noticeFor(value) {
  const notices = {
    code_created: ['Código creado y guardado.', 'ok'],
    code_deleted: ['Código eliminado.', 'ok'],
    reset_sent: ['Envié un token de confirmación por DM al dueño del bot. Vence en 10 minutos.', 'ok'],
    reset_done: ['Reinicio global completado. Se reiniciaron los perfiles indicados.', 'ok'],
    world_event_started: ['Evento mundial iniciado en el canal configurado.', 'ok'],
    world_event_active: ['Ya hay un evento mundial activo o iniciándose.', 'error'],
    world_event_channel: ['No pude encontrar el canal configurado para el evento.', 'error'],
    world_event_failed: ['No pude iniciar el evento. No se anunció.', 'error'],
    invalid: ['No se pudo completar la operación. Revisa los datos y vuelve a intentarlo.', 'error'],
    storage: ['No pude guardar el cambio. No se confirmó la operación.', 'error'],
    dm_failed: ['No pude enviar el DM de confirmación; no se creó un token utilizable.', 'error'],
    bad_csrf: ['La sesión venció o la solicitud no es válida. Recarga el panel.', 'error'],
  };
  return notices[value] || null;
}

function dashboardPage(session, records, userCount, worldEventActive, queryNotice = '') {
  const noticeInfo = noticeFor(queryNotice);
  const notice = noticeInfo
    ? `<div class="notice ${noticeInfo[1]}">${escapeHtml(noticeInfo[0])}</div>`
    : '';
  const codeRows = records.length
    ? records.map((record) => `<tr><td><code>${escapeHtml(record.displayCode)}</code></td>
<td>${Number(record.reward).toLocaleString('en-US')}</td>
<td>${escapeHtml(new Date(record.expiresAt).toLocaleString('es-CO', { timeZone: 'America/Bogota' }))}</td>
<td><form method="post" action="/admin/codes/delete" onsubmit="return confirm('¿Eliminar este código? Los canjes futuros dejarán de funcionar.')">
${csrfField(session)}<input type="hidden" name="code" value="${escapeHtml(record.normalizedCode)}"><button class="danger" type="submit">Eliminar</button></form></td></tr>`).join('')
    : '<tr><td colspan="4">No hay códigos creados.</td></tr>';
  const worldEventStatus = worldEventActive
    ? '<strong>Hay un evento activo o iniciándose.</strong> Espera a que termine antes de lanzar otro.'
    : 'No hay ningún evento en curso.';
  const content = `<div class="inline"><div><h1>🎃 Xerion Admin</h1><p>Sesión privada · solo el propietario del bot debe usar este panel.</p></div>
<form method="post" action="/admin/logout">${csrfField(session)}<button type="submit">Cerrar sesión</button></form></div>
${notice}
<section class="panel"><h2>Resumen</h2><div class="stats"><div class="stat"><span class="muted">Perfiles económicos</span><b>${userCount.toLocaleString('en-US')}</b></div>
<div class="stat"><span class="muted">Códigos activos o históricos</span><b>${records.length.toLocaleString('en-US')}</b></div></div></section>
<section class="panel"><h2>Crear código de canje</h2><p>Un canje por cuenta, disponible desde nivel 10. La fecha se interpreta en la zona local del navegador y se guarda como instante UTC.</p>
<form id="create-code" method="post" action="/admin/codes/create">${csrfField(session)}
<label for="code">Código (3–32 letras, números, guion o guion bajo)</label><input id="code" name="code" maxlength="32" pattern="[A-Za-z0-9_-]{3,32}" required>
<label for="reward">Recompensa en Candys</label><input id="reward" name="reward" type="number" min="1" step="1" required>
<label for="expiry-local">Vence el</label><input id="expiry-local" name="expiresLocal" type="datetime-local" required>
<input id="expires-at" name="expiresAt" type="hidden"><button type="submit">Crear código</button></form></section>
<section class="panel"><h2>Evento mundial</h2><p>${worldEventStatus}</p>
<p>Al iniciarlo, Xerion anunciará el evento en el canal configurado y comenzará la ventana de participación de 60 segundos.</p>
<form method="post" action="/admin/world-event/spawn" onsubmit="return confirm('¿Iniciar ahora un evento mundial en el canal configurado?')">
${csrfField(session)}<button type="submit"${worldEventActive ? ' disabled' : ''}>Iniciar evento ahora</button></form></section>
<section class="panel"><h2>Códigos de canje</h2><div class="table-wrap"><table><thead><tr><th>Código</th><th>Premio</th><th>Vencimiento · hora de Bogotá</th><th></th></tr></thead><tbody>${codeRows}</tbody></table></div></section>
<section class="panel"><h2>Reinicio global</h2><p class="danger-text"><strong>Acción irreversible:</strong> restablece los perfiles económicos de todos los usuarios. No elimina los códigos del dashboard.</p>
<form method="post" action="/admin/reset/start" onsubmit="return confirm('Se enviará por DM al dueño un token de un solo uso para confirmar el reinicio. ¿Continuar?')">
${csrfField(session)}<button class="danger" type="submit">Solicitar token de confirmación</button></form>
<form method="post" action="/admin/reset/confirm">${csrfField(session)}
<label for="reset-token">Token recibido por DM del bot</label><input id="reset-token" name="token" type="password" autocomplete="one-time-code" required>
<button class="danger" type="submit" onclick="return confirm('Esto reiniciará todos los perfiles económicos y no se puede deshacer. ¿Confirmas?')">Confirmar reinicio total</button></form></section>
<script>
document.getElementById('create-code').addEventListener('submit',function(event){
  const local=document.getElementById('expiry-local');
  const instant=new Date(local.value);
  if(!local.value||Number.isNaN(instant.getTime())){event.preventDefault();return;}
  document.getElementById('expires-at').value=instant.toISOString();
});
</script>`;
  return page('Panel', content);
}

function recordLoginFailure(request) {
  const key = request.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const current = loginAttempts.get(key);
  const state = !current || current.resetAt <= now ? { count: 0, resetAt: now + 15 * 60 * 1000 } : current;
  state.count += 1;
  loginAttempts.set(key, state);
}

function isLoginLimited(request) {
  const state = loginAttempts.get(request.socket.remoteAddress || 'unknown');
  if (!state || state.resetAt <= Date.now()) return false;
  return state.count >= 10;
}

async function handleAdminRequest(request, response, { cfg, db, client, ui, spawnWorldEvent, getWorldEventStatus }) {
  const url = new URL(request.url, 'http://localhost');
  if (url.pathname !== '/admin' && !url.pathname.startsWith('/admin/')) return false;

  const production = process.env.NODE_ENV === 'production';
  const dashboardSecret = process.env.DASHBOARD_SECRET || '';
  if (request.method === 'GET' && url.pathname === '/admin') {
    const session = getSession(request);
    if (!session) return sendHtml(response, 200, loginPage());
    try {
      const records = await db.listRedeemCodes();
      const userCount = Object.keys(db.getAllUsers()).length;
      const worldEventActive = typeof getWorldEventStatus === 'function' && getWorldEventStatus();
      return sendHtml(response, 200, dashboardPage(
        session, records, userCount, Boolean(worldEventActive), url.searchParams.get('notice') || '',
      ));
    } catch (err) {
      console.error('[Dashboard] No se pudo cargar el panel:', err.message);
      return sendHtml(response, 503, page('Error', '<h1>Panel temporalmente no disponible</h1><p>La base de datos no respondió. Inténtalo de nuevo más tarde.</p>'));
    }
  }

  if (request.method === 'POST' && url.pathname === '/admin/login') {
    let form;
    try { form = await readForm(request); } catch (_) { return sendHtml(response, 413, loginPage('La solicitud supera el tamaño permitido.')); }
    if (isLoginLimited(request)) return sendHtml(response, 429, loginPage('Demasiados intentos. Espera 15 minutos.'));
    if (Buffer.byteLength(dashboardSecret) < 32 || !constantTimeEqual(form.secret, dashboardSecret)) {
      recordLoginFailure(request);
      return sendHtml(response, 401, loginPage('Acceso no disponible. Revisa la configuración e inténtalo de nuevo.'));
    }
    loginAttempts.delete(request.socket.remoteAddress || 'unknown');
    const id = crypto.randomBytes(32).toString('hex');
    const csrf = crypto.randomBytes(24).toString('hex');
    sessions.set(id, { csrf, expiresAt: Date.now() + SESSION_TTL_MS });
    setSessionCookie(response, id, production);
    return redirect(response, '/admin');
  }

  const session = getSession(request);
  if (!session) return redirect(response, '/admin');
  if (request.method === 'POST') {
    let form;
    try { form = await readForm(request); } catch (_) {
      return redirect(response, '/admin?notice=invalid');
    }
    if (!constantTimeEqual(form.csrf, session.csrf)) return redirect(response, '/admin?notice=bad_csrf');

    if (url.pathname === '/admin/logout') {
      sessions.delete(session.id);
      clearSessionCookie(response, production);
      return redirect(response, '/admin');
    }

    if (url.pathname === '/admin/codes/create') {
      const reward = Number(form.reward);
      const result = await db.createRedeemCode(form.code, reward, form.expiresAt);
      if (result.error === 'storage') return redirect(response, '/admin?notice=storage');
      return redirect(response, `/admin?notice=${result.ok ? 'code_created' : 'invalid'}`);
    }

    if (url.pathname === '/admin/codes/delete') {
      const result = await db.deleteRedeemCode(form.code);
      if (result.error === 'storage') return redirect(response, '/admin?notice=storage');
      return redirect(response, `/admin?notice=${result.deleted ? 'code_deleted' : 'invalid'}`);
    }

    if (url.pathname === '/admin/world-event/spawn') {
      if (typeof spawnWorldEvent !== 'function') return redirect(response, '/admin?notice=world_event_failed');
      try {
        const result = await spawnWorldEvent();
        if (result?.ok) return redirect(response, '/admin?notice=world_event_started');
        if (result?.error === 'already_active') return redirect(response, '/admin?notice=world_event_active');
        if (result?.error === 'channel_unavailable') return redirect(response, '/admin?notice=world_event_channel');
        return redirect(response, '/admin?notice=world_event_failed');
      } catch (err) {
        console.error('[Dashboard] No se pudo iniciar el evento mundial:', err.message);
        return redirect(response, '/admin?notice=world_event_failed');
      }
    }

    if (url.pathname === '/admin/reset/start') {
      if (Buffer.byteLength(dashboardSecret) < 32) return redirect(response, '/admin?notice=invalid');
      const token = crypto.randomBytes(32).toString('hex');
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
      const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);
      const stored = await db.createResetToken(tokenHash, expiresAt);
      if (!stored) return redirect(response, '/admin?notice=storage');
      try {
        const owner = await client.users.fetch(cfg.OWNER_ID);
        await owner.send(ui.infoCard(
          cfg,
          'Token de confirmación · reinicio global',
          `Este token vence en **10 minutos** y solo se puede usar una vez:\n\n\`${token}\`\n\nIntrodúcelo en el dashboard para confirmar. Si no lo solicitaste, ignora este mensaje.`,
        ));
      } catch (err) {
        console.error('[Dashboard] No se pudo enviar el DM de confirmación:', err.message);
        await db.deleteResetToken(tokenHash);
        return redirect(response, '/admin?notice=dm_failed');
      }
      return redirect(response, '/admin?notice=reset_sent');
    }

    if (url.pathname === '/admin/reset/confirm') {
      const token = String(form.token || '').trim();
      if (!/^[a-f0-9]{64}$/i.test(token)) return redirect(response, '/admin?notice=invalid');
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
      const result = await db.consumeResetTokenAndResetAll(tokenHash);
      if (result.error === 'storage') return redirect(response, '/admin?notice=storage');
      if (result.error) return redirect(response, '/admin?notice=invalid');
      return redirect(response, '/admin?notice=reset_done');
    }
  }

  securityHeaders(response);
  response.writeHead(404);
  response.end('<!doctype html><title>Not found</title><p>Not found</p>');
  return true;
}

module.exports = { handleAdminRequest };