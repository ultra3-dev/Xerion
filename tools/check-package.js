#!/usr/bin/env node
'use strict';

// Comprueba que una carpeta de proyecto (p. ej. el ZIP extraído) es apta para entregar:
// sin .env, secretos, base de datos privada, node_modules, .git ni cachés, y con los archivos esenciales.
// Uso: node tools/check-package.js <carpeta>

const fs = require('node:fs');
const path = require('node:path');

const dir = path.resolve(process.argv[2] || '.');
const problems = [];
const forbiddenNames = new Set(['.env', 'node_modules', '.git', 'data', '.cache', '.npm', '.DS_Store', 'economy.json']);
const required = [
  'package.json', 'package-lock.json', 'config.js', 'index.js', 'economy.js', 'database.js', 'ui.js', 'trade.js', 'casino-view.js',
  'keepalive.js', 'render.yaml', 'render.free.yaml', '.env.example', '.gitignore', 'README.md', 'CHANGELOG.md',
  'docs/TRADING.md', 'docs/CANVAS.md', 'docs/COSTOS.md', 'render/raster.js', 'render/blackjack-scene.js',
  'assets/fonts/display.json', 'assets/fonts/condensed.json', 'assets/fonts/LICENSES/EricaOne-OFL.txt',
];
const tokenPattern = /[MNO][A-Za-z\d_-]{23,28}\.[\w-]{6}\.[\w-]{27,}/;
const dbUrlWithPassword = /postgres(?:ql)?:\/\/[^\s:@/]+:[^\s@/]+@/i;
let fileCount = 0;

(function walk(current) {
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const full = path.join(current, entry.name);
    const relative = path.relative(dir, full);
    if (forbiddenNames.has(entry.name) || entry.name.endsWith('.log') || entry.name.endsWith('.tmp')) { problems.push(`no debe incluirse: ${relative}`); continue; }
    if (entry.isDirectory()) { walk(full); continue; }
    fileCount += 1;
    if (/\.(png|jpg|zip|gz)$/i.test(entry.name) || entry.name === 'png-fixtures.json') continue;
    const text = fs.readFileSync(full, 'utf8');
    if (tokenPattern.test(text)) problems.push(`posible token de Discord en ${relative}`);
    if (dbUrlWithPassword.test(text)) problems.push(`URL de base de datos con contraseña en ${relative}`);
  }
}(dir));

for (const file of required) if (!fs.existsSync(path.join(dir, file))) problems.push(`falta: ${file}`);

if (problems.length) {
  console.error(`❌ ${problems.length} problema(s):\n - ${problems.join('\n - ')}`);
  process.exit(1);
}
console.log(`✅ Paquete correcto: ${fileCount} archivos, sin secretos ni datos privados.`);
