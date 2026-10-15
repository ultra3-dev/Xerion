'use strict';

// ============================================================
//  PNG — codificador y decodificador mínimos (sin dependencias; usa zlib de Node).
//  · encodePNG: RGB/RGBA de 8 bits con filtrado adaptativo; deflate ASÍNCRONO (no bloquea el event loop).
//  · decodePNG: gris, RGB, paleta, gris+alfa y RGBA (8 bits, y 16 bits tomando el byte alto), sin entrelazado.
//    Solo se usa para los PNG de emojis y para pruebas; rechaza imágenes enormes o malformadas.
// ============================================================

const zlib = require('node:zlib');
const { promisify } = require('node:util');

const deflate = promisify(zlib.deflate);

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([length, typeAndData, crc]);
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

// Filtrado adaptativo por fila (heurística de la suma de valores absolutos).
function filterRows(data, width, height, bytesPerPixel, mode) {
  const stride = width * bytesPerPixel;
  const out = Buffer.alloc((stride + 1) * height);
  const candidates = [0, 1, 2, 3, 4].map(() => new Uint8Array(stride));
  const tries = mode === 'fast' ? [1, 2, 4] : [0, 1, 2, 3, 4];
  for (let y = 0; y < height; y += 1) {
    const row = y * stride;
    const prev = row - stride;
    let best = 0;
    let bestScore = Infinity;
    for (const f of tries) {
      const dst = candidates[f];
      let score = 0;
      for (let i = 0; i < stride; i += 1) {
        const x = data[row + i];
        const a = i >= bytesPerPixel ? data[row + i - bytesPerPixel] : 0;
        const b = y > 0 ? data[prev + i] : 0;
        const c = (i >= bytesPerPixel && y > 0) ? data[prev + i - bytesPerPixel] : 0;
        let v;
        if (f === 0) v = x;
        else if (f === 1) v = x - a;
        else if (f === 2) v = x - b;
        else if (f === 3) v = x - ((a + b) >> 1);
        else v = x - paeth(a, b, c);
        v &= 255;
        dst[i] = v;
        score += v < 128 ? v : 256 - v;
      }
      if (score < bestScore) { bestScore = score; best = f; }
    }
    out[y * (stride + 1)] = best;
    out.set(candidates[best], y * (stride + 1) + 1);
  }
  return out;
}

// rgba: Uint8Array/Uint8ClampedArray con alfa NO premultiplicado. Si todo es opaco se guarda como RGB (más liviano).
async function encodePNG(width, height, rgba, { level = 6, filter = 'fast' } = {}) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw new RangeError('Dimensiones PNG inválidas');
  if (rgba.length !== width * height * 4) throw new RangeError('El buffer RGBA no coincide con las dimensiones');
  let opaque = true;
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] !== 255) { opaque = false; break; }
  let pixels = rgba;
  let bytesPerPixel = 4;
  if (opaque) {
    pixels = new Uint8Array(width * height * 3);
    for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
      pixels[j] = rgba[i]; pixels[j + 1] = rgba[i + 1]; pixels[j + 2] = rgba[i + 2];
    }
    bytesPerPixel = 3;
  }
  const filtered = filterRows(pixels, width, height, bytesPerPixel, filter);
  const compressed = await deflate(filtered, { level });
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // profundidad de bits
  header[9] = opaque ? 2 : 6; // tipo de color: RGB / RGBA
  header[10] = 0; header[11] = 0; header[12] = 0;
  return Buffer.concat([SIGNATURE, chunk('IHDR', header), chunk('IDAT', compressed), chunk('IEND', Buffer.alloc(0))]);
}

// Devuelve { width, height, data: Uint8Array RGBA no premultiplicado } o lanza Error si no es compatible.
function decodePNG(buffer, { maxPixels = 4_000_000, maxBytes = 5_000_000 } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 33 || buffer.length > maxBytes) throw new Error('PNG: tamaño inválido');
  if (!buffer.subarray(0, 8).equals(SIGNATURE)) throw new Error('PNG: firma inválida');
  let offset = 8;
  let header = null;
  let palette = null;
  let transparency = null;
  const idat = [];
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const start = offset + 8;
    const end = start + length;
    if (end + 4 > buffer.length) throw new Error('PNG: chunk truncado');
    const data = buffer.subarray(start, end);
    if (type === 'IHDR') {
      if (length !== 13) throw new Error('PNG: IHDR inválido');
      header = {
        width: data.readUInt32BE(0), height: data.readUInt32BE(4), bitDepth: data[8], colorType: data[9], interlace: data[12],
      };
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') transparency = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    offset = end + 4;
  }
  if (!header || !idat.length) throw new Error('PNG: faltan chunks');
  const {
    width, height, bitDepth, colorType, interlace,
  } = header;
  if (interlace !== 0) throw new Error('PNG: entrelazado no soportado');
  if (!width || !height || width * height > maxPixels) throw new Error('PNG: dimensiones fuera de límite');
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error('PNG: tipo de color no soportado');
  const validDepths = { 0: [8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] }[colorType];
  if (!validDepths.includes(bitDepth)) throw new Error('PNG: profundidad no soportada');
  const bitsPerPixel = channels * bitDepth;
  const bytesPerPixel = Math.max(1, bitsPerPixel >> 3);
  const stride = Math.ceil((width * bitsPerPixel) / 8);
  const raw = zlib.inflateSync(Buffer.concat(idat), { maxOutputLength: (stride + 1) * height + 16 });
  if (raw.length < (stride + 1) * height) throw new Error('PNG: datos incompletos');

  const image = new Uint8Array(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filterType = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let i = 0; i < stride; i += 1) {
      const x = raw[src + i];
      const a = i >= bytesPerPixel ? image[dst + i - bytesPerPixel] : 0;
      const b = y > 0 ? image[dst - stride + i] : 0;
      const c = (i >= bytesPerPixel && y > 0) ? image[dst - stride + i - bytesPerPixel] : 0;
      let value;
      if (filterType === 0) value = x;
      else if (filterType === 1) value = x + a;
      else if (filterType === 2) value = x + b;
      else if (filterType === 3) value = x + ((a + b) >> 1);
      else if (filterType === 4) value = x + paeth(a, b, c);
      else throw new Error('PNG: filtro inválido');
      image[dst + i] = value & 255;
    }
  }

  const out = new Uint8Array(width * height * 4);
  const sample = (row, index) => { // valor de un canal (8 bits) en la fila `row`
    if (bitDepth === 8) return image[row + index];
    if (bitDepth === 16) return image[row + index * 2];
    return 0;
  };
  for (let y = 0; y < height; y += 1) {
    const row = y * stride;
    for (let x = 0; x < width; x += 1) {
      const o = (y * width + x) * 4;
      if (colorType === 6) {
        out[o] = sample(row, x * 4); out[o + 1] = sample(row, x * 4 + 1); out[o + 2] = sample(row, x * 4 + 2); out[o + 3] = sample(row, x * 4 + 3);
      } else if (colorType === 2) {
        out[o] = sample(row, x * 3); out[o + 1] = sample(row, x * 3 + 1); out[o + 2] = sample(row, x * 3 + 2); out[o + 3] = 255;
      } else if (colorType === 0) {
        const g = sample(row, x); out[o] = g; out[o + 1] = g; out[o + 2] = g; out[o + 3] = 255;
      } else if (colorType === 4) {
        const g = sample(row, x * 2); out[o] = g; out[o + 1] = g; out[o + 2] = g; out[o + 3] = sample(row, x * 2 + 1);
      } else { // paleta
        if (!palette) throw new Error('PNG: falta la paleta');
        let index;
        if (bitDepth === 8) index = image[row + x];
        else {
          const perByte = 8 / bitDepth;
          const byte = image[row + Math.floor(x / perByte)];
          const shift = 8 - bitDepth * ((x % perByte) + 1);
          index = (byte >> shift) & ((1 << bitDepth) - 1);
        }
        if (index * 3 + 2 >= palette.length) throw new Error('PNG: índice de paleta inválido');
        out[o] = palette[index * 3]; out[o + 1] = palette[index * 3 + 1]; out[o + 2] = palette[index * 3 + 2];
        out[o + 3] = transparency && index < transparency.length ? transparency[index] : 255;
      }
    }
  }
  return { width, height, data: out };
}

module.exports = { encodePNG, decodePNG, crc32 };
