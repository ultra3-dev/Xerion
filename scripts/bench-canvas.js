'use strict';

// Medición local del canvas del blackjack: tiempo por imagen y peso del PNG en TU máquina/servidor.
// Uso: npm run bench:canvas      (no usa red: XERION_EMOJI_SOURCE=off salvo que lo definas)
// Sirve para comprobar el ancho de banda real: peso medio × imágenes por partida × partidas al mes.

process.env.XERION_EMOJI_SOURCE = process.env.XERION_EMOJI_SOURCE || 'off';
const scene = require('../render/blackjack-scene');

const STATES = [
  { player: ['K♥', '7♠'], dealer: ['9♦', 'Q♣'], hideDealer: true, bet: 1000, maxCards: 15 },
  { player: ['A♠', 'K♥'], dealer: ['9♦', '7♣'], bet: 2500, maxCards: 15, result: 'blackjack', net: 3750 },
  { player: ['10♥', '6♠', '9♦'], dealer: ['9♦', '7♣'], bet: 125000, maxCards: 15, result: 'lose', playerBust: true, net: -125000 },
  { player: ['2♠', '3♥', '4♦', '5♣', '7♠'], dealer: ['10♦', '8♣', '10♠'], bet: 1000000, maxCards: 15, result: 'win', dealerBust: true, net: 1000000 },
  { player: ['2♠', '2♥', 'A♠', 'A♥', 'A♦', 'A♣', '3♠', '3♥', '3♦', '4♣', '4♠'], dealer: ['2♦', '2♣', '5♥', '6♥'], bet: 1000, maxCards: 15, result: 'push', dealerBlocked: true, net: 0 },
];

(async () => {
  const warmStart = Date.now();
  await scene.warmUp();
  console.log(`Calentamiento (fondo, sprites y paleta): ${Date.now() - warmStart} ms (una sola vez al arrancar)`);
  const sizes = [];
  const times = [];
  for (let round = 0; round < 3; round += 1) {
    for (const state of STATES) {
      scene.clearCaches(); // medir siempre un render real, no la caché
      await scene.warmUp();
      const started = process.hrtime.bigint();
      const out = await scene.renderBlackjack({ ...state, bet: state.bet + round });
      times.push(Number(process.hrtime.bigint() - started) / 1e6);
      sizes.push(out.buffer.length);
    }
  }
  const avg = (list) => list.reduce((a, b) => a + b, 0) / list.length;
  console.log(`Render sin caché de imagen (con fondo, sprites y paleta ya calientes): ${avg(times).toFixed(0)} ms de media (mín ${Math.min(...times).toFixed(0)}, máx ${Math.max(...times).toFixed(0)}).`);
  console.log(`Peso del PNG: ${(avg(sizes) / 1024).toFixed(1)} KB de media (mín ${(Math.min(...sizes) / 1024).toFixed(1)}, máx ${(Math.max(...sizes) / 1024).toFixed(1)}).`);
  const perGame = 3;
  console.log(`Ejemplo: 1.000 partidas/mes × ${perGame} imágenes × ${(avg(sizes) / 1024).toFixed(0)} KB ≈ ${((1000 * perGame * avg(sizes)) / 1024 / 1024).toFixed(0)} MB de salida.`);
})();
