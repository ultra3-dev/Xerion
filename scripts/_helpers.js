'use strict';

// Utilidades compartidas por las pruebas de v1.1.0 (este archivo no contiene pruebas).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Aísla cada archivo de pruebas en su propia base local temporal (nunca toca datos reales).
function setupEnv(prefix) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `xerion-${prefix}-`));
  process.env.NODE_ENV = 'test';
  process.env.ECONOMY_DATA_FILE = path.join(tempDir, 'economy.json');
  delete process.env.DATABASE_URL;
  return tempDir;
}

function cleanupEnv(tempDir) {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

// Cuenta todos los objetos con `type` numérico dentro de un mensaje (límite de Discord: 40 componentes).
function countComponents(value) {
  if (Array.isArray(value)) return value.reduce((total, item) => total + countComponents(item), 0);
  if (!value || typeof value !== 'object') return 0;
  let total = typeof value.type === 'number' ? 1 : 0;
  for (const child of Object.values(value)) total += countComponents(child);
  return total;
}

// Convierte un mensaje (con builders) a JSON plano; así también se validan los builders (toJSON).
function toPlain(view) {
  return JSON.parse(JSON.stringify(view));
}

// Todo el texto visible de un mensaje: contenidos de TextDisplay y etiquetas de botones.
function collectText(view) {
  const parts = [];
  (function walk(node) {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (!node || typeof node !== 'object') return;
    if (typeof node.content === 'string') parts.push(node.content);
    if (typeof node.label === 'string') parts.push(node.label);
    Object.values(node).forEach(walk);
  }(toPlain(view)));
  return parts.join('\n');
}

function buttonsOf(view) {
  const buttons = [];
  (function walk(node) {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (!node || typeof node !== 'object') return;
    if (node.type === 2) buttons.push(node);
    Object.values(node).forEach(walk);
  }(toPlain(view)));
  return buttons;
}

// PRNG determinista (mulberry32) para pruebas estadísticas y de fuzz reproducibles.
function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Valor de rng() que hace que un sorteo ponderado caiga EXACTAMENTE en el elemento `index`.
function rngForIndex(weights, index) {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const before = weights.slice(0, index).reduce((sum, weight) => sum + weight, 0);
  const value = (before + weights[index] / 2) / total;
  return () => value;
}

// rng() que va devolviendo, en orden, los valores indicados (y repite el último).
function rngSequence(values) {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)];
}

module.exports = {
  setupEnv, cleanupEnv, countComponents, toPlain, collectText, buttonsOf, seeded, rngForIndex, rngSequence,
};
