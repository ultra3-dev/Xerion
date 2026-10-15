'use strict';

// ============================================================
//  QUANTIZE — Paleta de 256 colores (median cut ponderado por área) + PNG indexado.
//
//  Por qué: un PNG de 900×560 con degradados pesa ~250 KB en color verdadero; indexado a 256 colores baja a
//  ~60-90 KB sin diferencias apreciables. Cada partida de blackjack sube varias imágenes, y el ancho de banda
//  de salida del hosting se factura: menos bytes = menos riesgo de pasar del tope incluido.
//
//  La paleta se calcula UNA vez a partir de varias escenas de entrenamiento (histograma acumulado) y se reutiliza;
//  cada render solo hace una búsqueda en una tabla (LUT) de 6 bits por canal, rellenada de forma perezosa.
// ============================================================

const zlib = require('node:zlib');
const { promisify } = require('node:util');
const { crc32 } = require('./png');

const deflate = promisify(zlib.deflate);

const BITS = 6;
const SHIFT = 8 - BITS;
const SIZE = 1 << (BITS * 3);

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

class Histogram {
  constructor() {
    this.count = new Uint32Array(SIZE);
    this.sums = new Float64Array(SIZE * 3);
  }

  // rgb: Uint8Array con 3 bytes por píxel
  addRGB(rgb, stride = 1) {
    for (let i = 0; i < rgb.length; i += 3 * stride) {
      const r = rgb[i];
      const g = rgb[i + 1];
      const b = rgb[i + 2];
      const key = ((r >> SHIFT) << (BITS * 2)) | ((g >> SHIFT) << BITS) | (b >> SHIFT);
      this.count[key] += 1;
      const o = key * 3;
      this.sums[o] += r; this.sums[o + 1] += g; this.sums[o + 2] += b;
    }
  }
}

function keyOf(r, g, b) {
  return ((r >> SHIFT) << (BITS * 2)) | ((g >> SHIFT) << BITS) | (b >> SHIFT);
}

// Median cut: devuelve Uint8Array(n*3) con la paleta.
function buildPalette(histogram, maxColors = 256) {
  const keys = [];
  for (let k = 0; k < SIZE; k += 1) if (histogram.count[k] > 0) keys.push(k);
  const n = keys.length;
  const count = new Float64Array(n);
  const rgb = new Float64Array(n * 3);
  for (let i = 0; i < n; i += 1) {
    const c = histogram.count[keys[i]];
    count[i] = c;
    rgb[i * 3] = histogram.sums[keys[i] * 3] / c;
    rgb[i * 3 + 1] = histogram.sums[keys[i] * 3 + 1] / c;
    rgb[i * 3 + 2] = histogram.sums[keys[i] * 3 + 2] / c;
  }
  const order = Int32Array.from({ length: n }, (_, i) => i);
  const WEIGHT = [0.9, 1.35, 0.75]; // el ojo distingue más el verde

  const analyse = (start, end) => {
    const min = [255, 255, 255];
    const max = [0, 0, 0];
    let total = 0;
    for (let i = start; i < end; i += 1) {
      const idx = order[i];
      total += count[idx];
      for (let c = 0; c < 3; c += 1) {
        const v = rgb[idx * 3 + c];
        if (v < min[c]) min[c] = v;
        if (v > max[c]) max[c] = v;
      }
    }
    let axis = 0;
    let range = -1;
    for (let c = 0; c < 3; c += 1) {
      const r = (max[c] - min[c]) * WEIGHT[c];
      if (r > range) { range = r; axis = c; }
    }
    return {
      start, end, total, axis, range, score: Math.sqrt(total) * range,
    };
  };

  const boxes = [analyse(0, n)];
  while (boxes.length < maxColors) {
    let bestIndex = -1;
    let bestScore = 0;
    for (let b = 0; b < boxes.length; b += 1) {
      if (boxes[b].end - boxes[b].start > 1 && boxes[b].score > bestScore) { bestScore = boxes[b].score; bestIndex = b; }
    }
    if (bestIndex < 0) break;
    const box = boxes[bestIndex];
    const slice = Array.from(order.subarray(box.start, box.end));
    slice.sort((a, b) => rgb[a * 3 + box.axis] - rgb[b * 3 + box.axis]);
    order.set(slice, box.start);
    let acc = 0;
    let split = box.start + 1;
    for (let i = box.start; i < box.end - 1; i += 1) {
      acc += count[order[i]];
      split = i + 1;
      if (acc >= box.total / 2) break;
    }
    boxes.splice(bestIndex, 1, analyse(box.start, split), analyse(split, box.end));
  }

  const palette = new Uint8Array(boxes.length * 3);
  boxes.forEach((box, bi) => {
    let r = 0; let g = 0; let b = 0; let total = 0;
    for (let i = box.start; i < box.end; i += 1) {
      const idx = order[i];
      r += rgb[idx * 3] * count[idx]; g += rgb[idx * 3 + 1] * count[idx]; b += rgb[idx * 3 + 2] * count[idx]; total += count[idx];
    }
    palette[bi * 3] = Math.round(r / total); palette[bi * 3 + 1] = Math.round(g / total); palette[bi * 3 + 2] = Math.round(b / total);
  });
  return palette;
}

// Tabla color→índice (6 bits por canal) rellenada bajo demanda con el color más cercano de la paleta.
function makeLookup(palette) {
  const lut = new Int16Array(SIZE).fill(-1);
  const n = palette.length / 3;
  const nearest = (r, g, b) => {
    let best = 0;
    let bestDistance = Infinity;
    for (let i = 0; i < n; i += 1) {
      const dr = r - palette[i * 3];
      const dg = g - palette[i * 3 + 1];
      const db = b - palette[i * 3 + 2];
      const distance = dr * dr * 0.9 + dg * dg * 1.35 + db * db * 0.75;
      if (distance < bestDistance) { bestDistance = distance; best = i; }
    }
    return best;
  };
  return { palette, lut, nearest };
}

function indexImage(rgb, width, height, lookup) {
  const { lut, nearest } = lookup;
  const indices = new Uint8Array(width * height);
  const mask = (1 << BITS) - 1;
  for (let i = 0, p = 0; p < indices.length; i += 3, p += 1) {
    const r = rgb[i];
    const g = rgb[i + 1];
    const b = rgb[i + 2];
    const key = ((r >> SHIFT) << (BITS * 2)) | ((g >> SHIFT) << BITS) | (b >> SHIFT);
    let index = lut[key];
    if (index < 0) {
      // centro del cubo de 6 bits: evita el sesgo de usar siempre la esquina inferior
      const rr = (((key >> (BITS * 2)) & mask) << SHIFT) + (1 << (SHIFT - 1));
      const gg = (((key >> BITS) & mask) << SHIFT) + (1 << (SHIFT - 1));
      const bb = ((key & mask) << SHIFT) + (1 << (SHIFT - 1));
      index = nearest(Math.min(255, rr), Math.min(255, gg), Math.min(255, bb));
      lut[key] = index;
    }
    indices[p] = index;
  }
  return indices;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([length, typeAndData, crc]);
}

function filterIndexed(indices, width, height) {
  const out = Buffer.alloc((width + 1) * height);
  const candidates = [0, 1, 2].map(() => new Uint8Array(width));
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    let best = 0;
    let bestScore = Infinity;
    for (let f = 0; f < 3; f += 1) {
      const dst = candidates[f];
      let score = 0;
      for (let i = 0; i < width; i += 1) {
        const x = indices[row + i];
        let v;
        if (f === 0) v = x;
        else if (f === 1) v = x - (i > 0 ? indices[row + i - 1] : 0);
        else v = x - (y > 0 ? indices[row - width + i] : 0);
        v &= 255;
        dst[i] = v;
        score += v === 0 ? 0 : 1; // para índices, cuantos más ceros mejor
      }
      if (score < bestScore) { bestScore = score; best = f; }
    }
    out[y * (width + 1)] = best;
    out.set(candidates[best], y * (width + 1) + 1);
  }
  return out;
}

// rgb: Uint8Array RGB (3 bytes/píxel) totalmente opaco.
async function encodeIndexedPNG(width, height, rgb, lookup, { level = 9 } = {}) {
  const indices = indexImage(rgb, width, height, lookup);
  const filtered = filterIndexed(indices, width, height);
  const compressed = await deflate(filtered, { level, strategy: zlib.constants.Z_FILTERED });
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 3; header[10] = 0; header[11] = 0; header[12] = 0;
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', header),
    chunk('PLTE', Buffer.from(lookup.palette)),
    chunk('IDAT', compressed),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

module.exports = {
  Histogram, buildPalette, makeLookup, indexImage, encodeIndexedPNG, keyOf,
};
