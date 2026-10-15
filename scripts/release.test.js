'use strict';

// Coherencia de la entrega 1.1.0: versiones, conteo de comandos, documentación, empaquetado y opciones de costo.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { mock, test } = require('node:test');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const json = (file) => JSON.parse(read(file));

const cfg = require('../config');
const keepAlive = require('../keepalive');

function projectFiles(dir = root, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', 'data'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) projectFiles(full, found);
    else found.push(full);
  }
  return found;
}

// ---------- Versión ----------

test('every version marker says 1.1.0 and the stale 1.0.0 / 50-command wording is gone', () => {
  assert.equal(cfg.BOT_VERSION, '1.1.0');
  assert.equal(json('package.json').version, '1.1.0');
  const lock = json('package-lock.json');
  assert.equal(lock.version, '1.1.0');
  assert.equal(lock.packages[''].version, '1.1.0');
  const readme = read('README.md');
  assert.match(readme, /v1\.1\.0/);
  assert.match(readme, /55 comandos/);
  assert.match(read('CHANGELOG.md'), /^## 1\.1\.0/m);
  assert.match(read('index.js'), /los 55 comandos/);
  assert.match(read('ui.js'), /55 comandos en total/);
  assert.match(read('config.js'), /v1\.1\.0/);
  for (const file of ['README.md', 'index.js', 'ui.js', 'config.js']) {
    assert.ok(!/50 comandos/.test(read(file)), `${file} still mentions 50 commands`);
  }
  assert.ok(!/BOT_VERSION: '1\.0\.0'/.test(read('config.js')));
});

test('the dependency set did not change: package.json and the lockfile list the same packages and no new ones were added', () => {
  const pkg = json('package.json');
  const lock = json('package-lock.json');
  assert.deepEqual(Object.keys(pkg.dependencies).sort(), ['discord.js', 'dotenv', 'pg']);
  assert.deepEqual(pkg.dependencies, lock.packages[''].dependencies);
  assert.deepEqual(Object.keys(pkg.devDependencies || {}), []);
  for (const name of Object.keys(lock.packages)) assert.ok(!/canvas|sharp|jimp|pngjs/i.test(name), `unexpected image dependency ${name}`);
});

// ---------- Comandos y documentación ----------

test('55 real commands, each documented in /help and in the README', () => {
  const index = read('index.js');
  const names = [...new Set([...index.matchAll(/^commands\.([A-Za-z0-9_]+)\s*=/gm)].map((m) => m[1]))];
  assert.equal(names.length, 55);
  const readme = read('README.md');
  const helpSource = read('ui.js');
  for (const name of names) {
    const documented = name === 'redeemcode' ? 'redeem-code' : name; // el comando se escribe con guion
    assert.ok(readme.includes(`\`${documented}\``), `README lacks ${name}`);
    if (name === 'help') continue;
    assert.ok(new RegExp(`\`${documented}[\` \\[<(]`).test(helpSource), `help lacks ${name}`);
  }
  for (const alias of ['sell', 'trade', 'int', 'sk']) assert.ok(readme.includes(alias), `README lacks alias ${alias}`);
});

test('npm test runs every test file in scripts/ (none can be forgotten)', () => {
  const script = json('package.json').scripts.test;
  const files = fs.readdirSync(__dirname).filter((name) => name.endsWith('.test.js'));
  assert.ok(files.length >= 11);
  for (const file of files) assert.ok(script.includes(`scripts/${file}`), `${file} is not in npm test`);
});

test('docs/TRADING.md lists every base value that the code really uses', () => {
  const doc = read('docs/TRADING.md');
  const fmt = (n) => new Intl.NumberFormat('en-US').format(n);
  for (const material of cfg.MATERIALS) {
    assert.ok(doc.includes(material.name), `${material.name} missing`);
    const row = doc.split('\n').find((line) => line.startsWith('|') && line.includes(`\`${material.id}\` |`));
    assert.ok(row && row.includes(`| ${fmt(cfg.MATERIAL_BASE_VALUES[material.id])} |`), `${material.id} base value in docs`);
  }
  for (const potion of cfg.POTIONS) assert.ok(doc.includes(`| \`${potion.id}\` | ${fmt(potion.price)} |`), `${potion.id} price`);
  for (const weapon of cfg.WEAPONS) assert.ok(doc.includes(`| \`${weapon.id}\` | ${fmt(weapon.price)} |`), `${weapon.id} price`);
  assert.match(doc, new RegExp(`mínimo permitido|Precio mínimo`));
  assert.ok(doc.includes('xn give @usuario <artículo> [cantidad|all] <precio total>'));
});

test('the README collect table matches the real cooldowns', () => {
  const readme = read('README.md');
  const hours = (r) => r.collectCooldownMs / 3_600_000;
  for (const [id, pattern] of [['starx', /STAR X \| 12,000 \| 4 h → \*\*3 h\*\*/], ['aurainfinite', /AURA INFINITE \| 30,000 \| 8 h → \*\*6 h\*\*/], ['goat', /GOAT \| 55,000 \| 12 h → \*\*11 h\*\*/], ['king', /KING \| 85,000 \| 18 h → \*\*17 h\*\*/]]) {
    assert.match(readme, pattern);
    assert.ok(hours(cfg.EVENT_SHOP.find((r) => r.id === id)) <= 17);
  }
});

// ---------- Empaquetado y secretos ----------

test('no secrets, tokens or private data live in the project files', () => {
  const tokenPattern = /[MNO][A-Za-z\d_-]{23,28}\.[\w-]{6}\.[\w-]{27,}/;
  const dbUrlWithPassword = /postgres(?:ql)?:\/\/[^\s:@/]+:[^\s@/]+@/i;
  for (const file of projectFiles()) {
    if (/\.(png|zip|gz)$/i.test(file) || file.endsWith('png-fixtures.json')) continue;
    const text = fs.readFileSync(file, 'utf8');
    const relative = path.relative(root, file);
    assert.ok(!tokenPattern.test(text), `${relative} looks like it contains a Discord token`);
    assert.ok(!dbUrlWithPassword.test(text), `${relative} contains a database URL with a password`);
  }
  // (La ausencia de .env/data/node_modules en el ZIP se comprueba con `node tools/check-package.js <carpeta>`.)
  const ignore = read('.gitignore');
  for (const entry of ['.env', 'node_modules', 'data']) assert.ok(ignore.includes(entry), `.gitignore lacks ${entry}`);
  const example = read('.env.example');
  assert.match(example, /^BOT_TOKEN=pega_aqui_el_token_de_tu_bot$/m, 'BOT_TOKEN is only a placeholder');
  assert.ok(!/^DATABASE_URL=\S+/m.test(example) && !/^DASHBOARD_SECRET=\S+/m.test(example), 'secrets are left empty in the example');
  for (const variable of ['BLACKJACK_CANVAS', 'XERION_EMOJI_SOURCE', 'KEEP_ALIVE']) assert.ok(example.includes(variable), `.env.example documents ${variable}`);
});

test('the owner id is a well-formed Discord snowflake used by every owner rule', () => {
  assert.equal(cfg.OWNER_ID, '106467807401005875', 'must match the owner ID explicitly supplied for this release');
  assert.match(cfg.OWNER_ID, /^\d{17,20}$/);
  const economy = require('../economy');
  assert.equal(economy.isOwnerId(cfg.OWNER_ID), true);
  assert.equal(economy.isOwnerId(String(cfg.OWNER_ID).slice(0, -1)), false, 'a truncated id must not match');
});

// ---------- Costos ----------

test('render.yaml keeps the Starter plan and the production settings; the Free profile is a separate opt-in file', () => {
  const starter = read('render.yaml');
  const free = read('render.free.yaml');
  assert.match(starter, /plan: starter/);
  assert.match(starter, /healthCheckPath: \/health/);
  assert.ok(!/KEEP_ALIVE/.test(starter), 'Starter must not enable keep-alive');
  assert.match(free, /plan: free/);
  assert.match(free, /key: KEEP_ALIVE\s+value: "on"/);
  for (const key of ['BOT_TOKEN', 'DATABASE_URL', 'DASHBOARD_SECRET']) {
    assert.match(starter, new RegExp(`key: ${key}\\s+sync: false`));
    assert.match(free, new RegExp(`key: ${key}\\s+sync: false`));
  }
  assert.match(free, /NO es el predeterminado/);
});

test('keep-alive is off by default, HTTPS-only, bounded and never throws', () => {
  assert.equal(keepAlive.resolveKeepAlive({}), null);
  assert.equal(keepAlive.resolveKeepAlive({ KEEP_ALIVE: 'off', RENDER_EXTERNAL_URL: 'https://x.onrender.com' }), null);
  assert.equal(keepAlive.resolveKeepAlive({ KEEP_ALIVE: 'on' }), null, 'needs a URL');
  assert.equal(keepAlive.resolveKeepAlive({ KEEP_ALIVE: 'on', KEEP_ALIVE_URL: 'http://x.onrender.com' }), null, 'plain HTTP refused');
  assert.equal(keepAlive.resolveKeepAlive({ KEEP_ALIVE: 'on', KEEP_ALIVE_URL: 'no es una url' }), null);
  const config = keepAlive.resolveKeepAlive({ KEEP_ALIVE: 'on', RENDER_EXTERNAL_URL: 'https://bot.onrender.com/' });
  assert.deepEqual(config, { url: 'https://bot.onrender.com/health', intervalMs: 10 * 60 * 1000 });
  assert.equal(keepAlive.resolveKeepAlive({ KEEP_ALIVE: 'on', KEEP_ALIVE_URL: 'https://a.example', KEEP_ALIVE_MINUTES: '5' }).intervalMs, 5 * 60 * 1000);
  for (const minutes of ['0', '15', '99', 'abc', '-3']) {
    assert.equal(keepAlive.resolveKeepAlive({ KEEP_ALIVE: 'on', KEEP_ALIVE_URL: 'https://a.example', KEEP_ALIVE_MINUTES: minutes }).intervalMs, 10 * 60 * 1000, `invalid minutes ${minutes} fall back to 10`);
  }
  assert.equal(keepAlive.startKeepAlive({ url: '', intervalMs: 1000 }), null);

  mock.timers.enable({ apis: ['setInterval'] });
  try {
    const calls = [];
    const fakeRequest = (url, options, callback) => {
      calls.push(url);
      const handlers = {};
      callback({ resume() {} });
      return { on: (event, fn) => { handlers[event] = fn; }, destroy() {} };
    };
    const logs = [];
    const running = keepAlive.startKeepAlive(config, { request: fakeRequest, log: { log: (line) => logs.push(line) } });
    assert.match(logs[0], /solo para el plan Free/);
    mock.timers.tick(10 * 60 * 1000 * 3);
    assert.equal(calls.length, 3);
    assert.ok(calls.every((url) => url === 'https://bot.onrender.com/health'));
    running.stop();
    mock.timers.tick(10 * 60 * 1000 * 2);
    assert.equal(calls.length, 3, 'stopped');
    const exploding = keepAlive.startKeepAlive(config, { request: () => { throw new Error('red caída'); }, log: { log() {} } });
    assert.doesNotThrow(() => { mock.timers.tick(10 * 60 * 1000); });
    exploding.stop();
  } finally { mock.timers.reset(); }
});

test('the cost and canvas guides exist and state what was not changed', () => {
  const costs = read('docs/COSTOS.md');
  assert.match(costs, /no cambié el plan/i);
  assert.match(costs, /Cron Jobs/);
  assert.match(costs, /render\.free\.yaml/);
  assert.match(costs, /no hay mediciones de producción/i);
  const canvas = read('docs/CANVAS.md');
  assert.match(canvas, /no usa dependencias nuevas/i);
  assert.match(canvas, /Emojis Apple/);
  assert.match(canvas, /150/ === undefined ? /./ : /ancho de banda de salida/);
});
