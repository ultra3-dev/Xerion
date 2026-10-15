'use strict';

// ============================================================
//  CASINO-VIEW — Planes de animación de los juegos del casino.
//
//  Regla de oro: la animación NO sortea nada. Cada plan se construye a partir del objeto
//  `result` que ya devolvió economy.js (el mismo que decidió el pago), y su ÚLTIMO fotograma
//  es exactamente ese resultado. Así la posición final, el multiplicador mostrado, el premio
//  y el mensaje siempre representan la misma jugada. Sin discord.js: son datos puros.
// ============================================================

const cfg = require('./config');

// Posiciones del puntero en una rueda de `length` segmentos: avanza de 1 en 1 y termina
// EXACTAMENTE en `target` (el segmento sorteado).
function spinPositions(length, target, steps = 4) {
  if (!Number.isInteger(length) || length < 1) throw new RangeError('La rueda necesita al menos un segmento.');
  if (!Number.isInteger(target) || target < 0 || target >= length) throw new RangeError('El segmento final está fuera de la rueda.');
  if (!Number.isInteger(steps) || steps < 1) throw new RangeError('La animación necesita al menos un fotograma.');
  const positions = [];
  for (let k = 0; k < steps; k += 1) positions.push((((target - (steps - 1 - k)) % length) + length) % length);
  return positions;
}

function wheelPlan(result) {
  const segments = cfg.WHEEL_SEGMENTS;
  const segment = segments[result.segmentIndex];
  if (!segment || segment.mult !== result.multiplier) throw new Error('El resultado de la rueda no coincide con su segmento.');
  return {
    strip: segments.map((s) => `x${s.mult}`),
    positions: spinPositions(segments.length, result.segmentIndex),
    finalPosition: result.segmentIndex,
    finalLabel: `x${segment.mult}`,
  };
}

function roulettePlan(result) {
  const colors = cfg.ROULETTE_COLORS;
  const landed = colors[result.landedIndex];
  if (!landed || landed.id !== result.landed || landed.mult !== result.landedMult) {
    throw new Error('El resultado de la ruleta no coincide con su color.');
  }
  return {
    strip: colors.map((c) => c.label),
    positions: spinPositions(colors.length, result.landedIndex),
    finalPosition: result.landedIndex,
    finalLabel: landed.label,
  };
}

// Los rodillos se detienen de izquierda a derecha y se revelan tal como los sorteó economy.slots.
function slotsPlan(result, spinning = '🌀') {
  const [a, b, c] = result.reels;
  return {
    frames: [[spinning, spinning, spinning], [a, spinning, spinning], [a, b, spinning]],
    final: [a, b, c],
  };
}

// La escoba sube por valores crecientes (siempre <= al punto de choque) y se estrella en el sorteado.
function crashPlan(result, steps = 4) {
  const crash = result.crashCents / 100;
  const values = [];
  for (let k = 1; k <= steps; k += 1) {
    const fraction = (k / (steps + 1)) ** 2;
    values.push(Math.min(crash, Math.round((1 + (crash - 1) * fraction) * 100) / 100));
  }
  return { frames: values, finalValue: crash };
}

module.exports = {
  spinPositions, wheelPlan, roulettePlan, slotsPlan, crashPlan,
};
