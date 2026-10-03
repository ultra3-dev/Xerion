'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const { createDashboardHandler } = require('../dashboard');

const originalPassword = process.env.DASHBOARD_PASSWORD;
const originalSessionSecret = process.env.SESSION_SECRET;
process.env.DASHBOARD_PASSWORD = 'test-dashboard-password';
process.env.SESSION_SECRET = 'test-session-secret-with-sufficient-length';

function makeTestServer() {
  const state = { codes: [], resets: 0, resetFlags: [], dm: null };
  const db = {
    async listRedeemCodes() { return state.codes; },
    async createRedeemCode(code, reward, expiresAt, createdBy) {
      if (!/^[A-Z0-9_-]{3,32}$/.test(String(code || '').toUpperCase()) || !Number.isSafeInteger(reward) || reward < 1) {
        return { error: 'invalid' };
      }
      if (state.codes.some((entry) => entry.code === String(code).toUpperCase())) return { error: 'exists' };
      const created = { code: String(code).toUpperCase(), reward, expiresAt, createdBy };
      state.codes.push(created);
      return { code: created };
    },
    async deleteRedeemCode(code) {
      const index = state.codes.findIndex((entry) => entry.code === String(code).toUpperCase());
      if (index < 0) return false;
      state.codes.splice(index, 1);
      return true;
    },
    async resetAllProgress() {
      assert.equal(state.resetFlags.at(-1), true);
      state.resets += 1;
      return { usersReset: 7 };
    },
  };
  const economy = { resetTransientState() {} };
  const client = {
    users: {
      async fetch() {
        return {
          async send(content) { state.dm = content; },
        };
      },
    },
  };
  const handle = createDashboardHandler({
    db,
    economy,
    client,
    cfg: { OWNER_ID: 'owner-id' },
    onResetProgress: (active) => state.resetFlags.push(active),
  });
  const server = http.createServer(async (request, response) => {
    try {
      if (!await handle(request, response)) {
        response.writeHead(404);
        response.end();
      }
    } catch (err) {
      response.writeHead(500, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: err.message }));
    }
  });
  return { server, state };
}

async function request(baseUrl, route, options = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
  return { response, data: await response.json().catch(() => null) };
}

test('dashboard serves the login page, protects APIs, and manages codes in an authenticated session', async (t) => {
  const { server } = makeTestServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const page = await fetch(`${baseUrl}/dashboard`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Iniciar sesión/);

  const unauthorized = await request(baseUrl, '/api/dashboard/codes');
  assert.equal(unauthorized.response.status, 401);

  const failedLogin = await request(baseUrl, '/api/dashboard/login', {
    method: 'POST',
    body: JSON.stringify({ password: 'incorrect' }),
  });
  assert.equal(failedLogin.response.status, 401);

  const login = await request(baseUrl, '/api/dashboard/login', {
    method: 'POST',
    body: JSON.stringify({ password: process.env.DASHBOARD_PASSWORD }),
  });
  assert.equal(login.response.status, 200);
  const cookie = login.response.headers.get('set-cookie').split(';')[0];

  const created = await request(baseUrl, '/api/dashboard/codes', {
    method: 'POST',
    headers: { Cookie: cookie },
    body: JSON.stringify({
      code: 'halloween_2026',
      reward: 5000,
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    }),
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.data.code.code, 'HALLOWEEN_2026');

  const listed = await request(baseUrl, '/api/dashboard/codes', {
    headers: { Cookie: cookie },
  });
  assert.equal(listed.data.codes.length, 1);

  const removed = await request(baseUrl, '/api/dashboard/codes/HALLOWEEN_2026', {
    method: 'DELETE',
    headers: { Cookie: cookie },
  });
  assert.equal(removed.response.status, 200);
});

test('global reset requires the owner DM token and consumes it after one use', async (t) => {
  const { server, state } = makeTestServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const login = await request(baseUrl, '/api/dashboard/login', {
    method: 'POST',
    body: JSON.stringify({ password: process.env.DASHBOARD_PASSWORD }),
  });
  const cookie = login.response.headers.get('set-cookie').split(';')[0];

  const challenge = await request(baseUrl, '/api/dashboard/reset/request', {
    method: 'POST',
    headers: { Cookie: cookie },
    body: '{}',
  });
  assert.equal(challenge.response.status, 200);
  const token = state.dm.match(/\b\d{8}\b/)[0];
  const confirmed = await request(baseUrl, '/api/dashboard/reset/confirm', {
    method: 'POST',
    headers: { Cookie: cookie },
    body: JSON.stringify({ token }),
  });
  assert.equal(confirmed.response.status, 200);
  assert.equal(confirmed.data.usersReset, 7);
  assert.equal(state.resets, 1);
  assert.deepEqual(state.resetFlags, [true, false]);

  const replay = await request(baseUrl, '/api/dashboard/reset/confirm', {
    method: 'POST',
    headers: { Cookie: cookie },
    body: JSON.stringify({ token }),
  });
  assert.equal(replay.response.status, 403);
  assert.equal(state.resets, 1);
});

test.after(() => {
  if (originalPassword === undefined) delete process.env.DASHBOARD_PASSWORD;
  else process.env.DASHBOARD_PASSWORD = originalPassword;
  if (originalSessionSecret === undefined) delete process.env.SESSION_SECRET;
  else process.env.SESSION_SECRET = originalSessionSecret;
});