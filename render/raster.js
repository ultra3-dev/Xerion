'use strict';

// ============================================================
//  RASTER — Mini motor 2D en JavaScript puro (sin dependencias nativas).
//  · Rutas (líneas, cuadráticas, cúbicas, rectángulos redondeados, elipses) con antialiasing por
//    cobertura de área exacta (acumulación firmada por filas).
//  · Pinturas: color sólido, degradado lineal y degradado radial.
//  · Máscaras: desenfoque (sombras/brillos), unión (contornos gruesos) y recorte.
//  · Superficie RGBA premultiplicada en coma flotante; composición "source-over".
//  Todo es determinista: la misma entrada produce los mismos píxeles.
// ============================================================

// ---------- Colores ----------

function parseColor(input, alphaMul = 1) {
  if (Array.isArray(input)) {
    return [input[0] / 255, input[1] / 255, input[2] / 255, (input[3] === undefined ? 1 : input[3]) * alphaMul];
  }
  let hex = String(input).trim();
  if (hex[0] !== '#') throw new Error(`Color inválido: ${hex}`);
  hex = hex.slice(1);
  if (hex.length === 3 || hex.length === 4) hex = hex.split('').map((ch) => ch + ch).join('');
  if (hex.length !== 6 && hex.length !== 8) throw new Error(`Color inválido: #${hex}`);
  const channel = (i) => parseInt(hex.slice(i, i + 2), 16) / 255;
  return [channel(0), channel(2), channel(4), (hex.length === 8 ? channel(6) : 1) * alphaMul];
}

// ---------- Pinturas ----------

function solid(color, alphaMul = 1) {
  const c = parseColor(color, alphaMul);
  return {
    solid: c,
    at(x, y, out) { out[0] = c[0]; out[1] = c[1]; out[2] = c[2]; out[3] = c[3]; },
  };
}

function prepareStops(stops) {
  return stops.map(([t, color]) => ({ t, c: parseColor(color) })).sort((a, b) => a.t - b.t);
}

function sampleStops(stops, t, out) {
  if (t <= stops[0].t) { const c = stops[0].c; out[0] = c[0]; out[1] = c[1]; out[2] = c[2]; out[3] = c[3]; return; }
  const last = stops[stops.length - 1];
  if (t >= last.t) { const c = last.c; out[0] = c[0]; out[1] = c[1]; out[2] = c[2]; out[3] = c[3]; return; }
  let i = 1;
  while (i < stops.length - 1 && t > stops[i].t) i += 1;
  const a = stops[i - 1];
  const b = stops[i];
  const k = (t - a.t) / (b.t - a.t || 1);
  // Interpolación premultiplicada: evita bordes oscuros al degradar hacia transparente.
  const aa = a.c[3];
  const ba = b.c[3];
  const alpha = aa + (ba - aa) * k;
  if (alpha <= 1e-6) { out[0] = a.c[0]; out[1] = a.c[1]; out[2] = a.c[2]; out[3] = 0; return; }
  for (let ch = 0; ch < 3; ch += 1) {
    out[ch] = (a.c[ch] * aa * (1 - k) + b.c[ch] * ba * k) / alpha;
  }
  out[3] = alpha;
}

function linearGradient(x0, y0, x1, y1, stops) {
  const prepared = prepareStops(stops);
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len2 = dx * dx + dy * dy || 1;
  return { at(x, y, out) { sampleStops(prepared, ((x - x0) * dx + (y - y0) * dy) / len2, out); } };
}

function radialGradient(cx, cy, radius, stops, { sx = 1, sy = 1 } = {}) {
  const prepared = prepareStops(stops);
  return {
    at(x, y, out) {
      const ux = (x - cx) / sx;
      const uy = (y - cy) / sy;
      sampleStops(prepared, Math.sqrt(ux * ux + uy * uy) / radius, out);
    },
  };
}

// ---------- Matrices afines [a, b, c, d, e, f]: x' = a·x + c·y + e ; y' = b·x + d·y + f ----------

const Mat = {
  identity: () => [1, 0, 0, 1, 0, 0],
  translate: (tx, ty) => [1, 0, 0, 1, tx, ty],
  scale: (sx, sy = sx) => [sx, 0, 0, sy, 0, 0],
  rotate: (angle) => { const c = Math.cos(angle); const s = Math.sin(angle); return [c, s, -s, c, 0, 0]; },
  // multiply(a, b) = primero b y después a
  multiply: (a, b) => [
    a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5],
  ],
  // Gira `angle` radianes alrededor de (cx, cy)
  rotateAround: (angle, cx, cy) => Mat.multiply(Mat.translate(cx, cy), Mat.multiply(Mat.rotate(angle), Mat.translate(-cx, -cy))),
};

// ---------- Rutas ----------

const CMD_MOVE = 0;
const CMD_LINE = 1;
const CMD_QUAD = 2;
const CMD_CUBIC = 3;
const CMD_CLOSE = 4;
const KAPPA = 0.5522847498307936;

class Path {
  constructor() { this.cmds = []; }

  moveTo(x, y) { this.cmds.push([CMD_MOVE, x, y]); return this; }

  lineTo(x, y) { this.cmds.push([CMD_LINE, x, y]); return this; }

  quadTo(cx, cy, x, y) { this.cmds.push([CMD_QUAD, cx, cy, x, y]); return this; }

  cubicTo(c1x, c1y, c2x, c2y, x, y) { this.cmds.push([CMD_CUBIC, c1x, c1y, c2x, c2y, x, y]); return this; }

  close() { this.cmds.push([CMD_CLOSE]); return this; }

  rect(x, y, w, h, ccw = false) {
    if (!ccw) return this.moveTo(x, y).lineTo(x + w, y).lineTo(x + w, y + h).lineTo(x, y + h).close();
    return this.moveTo(x, y).lineTo(x, y + h).lineTo(x + w, y + h).lineTo(x + w, y).close();
  }

  // r: número o [tl, tr, br, bl]. ccw=true dibuja en sentido contrario (para agujeros / anillos).
  roundRect(x, y, w, h, r = 0, ccw = false) {
    const radii = Array.isArray(r) ? r : [r, r, r, r];
    const limit = Math.min(w, h) / 2;
    const [tl, tr, br, bl] = radii.map((v) => Math.max(0, Math.min(v, limit)));
    const k = 1 - KAPPA;
    if (!ccw) {
      this.moveTo(x + tl, y).lineTo(x + w - tr, y);
      this.cubicTo(x + w - tr * k, y, x + w, y + tr * k, x + w, y + tr).lineTo(x + w, y + h - br);
      this.cubicTo(x + w, y + h - br * k, x + w - br * k, y + h, x + w - br, y + h).lineTo(x + bl, y + h);
      this.cubicTo(x + bl * k, y + h, x, y + h - bl * k, x, y + h - bl).lineTo(x, y + tl);
      this.cubicTo(x, y + tl * k, x + tl * k, y, x + tl, y);
    } else {
      this.moveTo(x + tl, y);
      this.cubicTo(x + tl * k, y, x, y + tl * k, x, y + tl).lineTo(x, y + h - bl);
      this.cubicTo(x, y + h - bl * k, x + bl * k, y + h, x + bl, y + h).lineTo(x + w - br, y + h);
      this.cubicTo(x + w - br * k, y + h, x + w, y + h - br * k, x + w, y + h - br).lineTo(x + w, y + tr);
      this.cubicTo(x + w, y + tr * k, x + w - tr * k, y, x + w - tr, y).lineTo(x + tl, y);
    }
    return this.close();
  }

  ellipse(cx, cy, rx, ry, ccw = false) {
    const ox = rx * KAPPA;
    const oy = ry * KAPPA;
    if (!ccw) {
      this.moveTo(cx + rx, cy);
      this.cubicTo(cx + rx, cy + oy, cx + ox, cy + ry, cx, cy + ry);
      this.cubicTo(cx - ox, cy + ry, cx - rx, cy + oy, cx - rx, cy);
      this.cubicTo(cx - rx, cy - oy, cx - ox, cy - ry, cx, cy - ry);
      this.cubicTo(cx + ox, cy - ry, cx + rx, cy - oy, cx + rx, cy);
    } else {
      this.moveTo(cx + rx, cy);
      this.cubicTo(cx + rx, cy - oy, cx + ox, cy - ry, cx, cy - ry);
      this.cubicTo(cx - ox, cy - ry, cx - rx, cy - oy, cx - rx, cy);
      this.cubicTo(cx - rx, cy + oy, cx - ox, cy + ry, cx, cy + ry);
      this.cubicTo(cx + ox, cy + ry, cx + rx, cy + oy, cx + rx, cy);
    }
    return this.close();
  }

  circle(cx, cy, r, ccw = false) { return this.ellipse(cx, cy, r, r, ccw); }

  // Polígono cerrado; se orienta automáticamente en el sentido "positivo" (relleno).
  polygon(points, { keepOrientation = false } = {}) {
    let pts = points;
    if (!keepOrientation) {
      let area = 0;
      for (let i = 0; i < pts.length; i += 1) {
        const [x0, y0] = pts[i];
        const [x1, y1] = pts[(i + 1) % pts.length];
        area += x0 * y1 - x1 * y0;
      }
      if (area < 0) pts = [...pts].reverse();
    }
    pts.forEach(([x, y], i) => (i === 0 ? this.moveTo(x, y) : this.lineTo(x, y)));
    return this.close();
  }

  append(other, matrix = null) {
    const source = matrix ? other.transform(matrix) : other;
    for (const cmd of source.cmds) this.cmds.push(cmd.slice());
    return this;
  }

  transform(m) {
    const out = new Path();
    const ptX = (x, y) => m[0] * x + m[2] * y + m[4];
    const ptY = (x, y) => m[1] * x + m[3] * y + m[5];
    for (const cmd of this.cmds) {
      const next = [cmd[0]];
      for (let i = 1; i < cmd.length; i += 2) next.push(ptX(cmd[i], cmd[i + 1]), ptY(cmd[i], cmd[i + 1]));
      out.cmds.push(next);
    }
    return out;
  }

  // Convierte curvas en segmentos. Devuelve contornos cerrados: Float64Array [x0, y0, x1, y1, ...].
  flatten() {
    const contours = [];
    let current = null;
    let cx = 0;
    let cy = 0;
    let sx = 0;
    let sy = 0;
    const flush = () => { if (current && current.length >= 6) contours.push(Float64Array.from(current)); current = null; };
    for (const cmd of this.cmds) {
      const type = cmd[0];
      if (type === CMD_MOVE) {
        flush();
        current = [cmd[1], cmd[2]];
        cx = cmd[1]; cy = cmd[2]; sx = cx; sy = cy;
      } else if (type === CMD_LINE) {
        if (!current) { current = [cx, cy]; }
        current.push(cmd[1], cmd[2]);
        cx = cmd[1]; cy = cmd[2];
      } else if (type === CMD_QUAD) {
        if (!current) { current = [cx, cy]; }
        const [, qx, qy, x, y] = cmd;
        const length = Math.hypot(qx - cx, qy - cy) + Math.hypot(x - qx, y - qy);
        const n = Math.max(4, Math.min(48, Math.ceil(length / 2.5)));
        for (let i = 1; i <= n; i += 1) {
          const t = i / n;
          const u = 1 - t;
          current.push(u * u * cx + 2 * u * t * qx + t * t * x, u * u * cy + 2 * u * t * qy + t * t * y);
        }
        cx = x; cy = y;
      } else if (type === CMD_CUBIC) {
        if (!current) { current = [cx, cy]; }
        const [, x1, y1, x2, y2, x, y] = cmd;
        const length = Math.hypot(x1 - cx, y1 - cy) + Math.hypot(x2 - x1, y2 - y1) + Math.hypot(x - x2, y - y2);
        const n = Math.max(6, Math.min(64, Math.ceil(length / 2.5)));
        for (let i = 1; i <= n; i += 1) {
          const t = i / n;
          const u = 1 - t;
          const b0 = u * u * u;
          const b1 = 3 * u * u * t;
          const b2 = 3 * u * t * t;
          const b3 = t * t * t;
          current.push(b0 * cx + b1 * x1 + b2 * x2 + b3 * x, b0 * cy + b1 * y1 + b2 * y2 + b3 * y);
        }
        cx = x; cy = y;
      } else if (type === CMD_CLOSE) {
        flush();
        cx = sx; cy = sy;
      }
    }
    flush();
    return contours;
  }
}

// Interpreta una ruta SVG con comandos absolutos M L H V Q C Z (la que generan los assets de fuentes).
// Admite pares de coordenadas repetidos tras un comando (p. ej. "M40 0 247 1600" = M + L implícito).
function pathFromSVG(d, matrix = null) {
  const path = new Path();
  const tokens = d.match(/[MLHVQCZ]|-?\d*\.?\d+(?:e-?\d+)?/g) || [];
  let i = 0;
  let cx = 0;
  let cy = 0;
  let cmd = null;
  const isCommand = (token) => /^[MLHVQCZ]$/.test(token);
  const num = () => Number(tokens[i++]);
  while (i < tokens.length) {
    if (isCommand(tokens[i])) {
      cmd = tokens[i++];
      if (cmd === 'Z') { path.close(); cmd = null; continue; }
    } else if (cmd === null) {
      i += 1; // número suelto sin comando: se ignora
      continue;
    }
    if (cmd === 'M') {
      cx = num(); cy = num(); path.moveTo(cx, cy);
      cmd = 'L'; // los pares siguientes son líneas implícitas
    } else if (cmd === 'L') {
      cx = num(); cy = num(); path.lineTo(cx, cy);
    } else if (cmd === 'H') {
      cx = num(); path.lineTo(cx, cy);
    } else if (cmd === 'V') {
      cy = num(); path.lineTo(cx, cy);
    } else if (cmd === 'Q') {
      const qx = num(); const qy = num(); cx = num(); cy = num();
      path.quadTo(qx, qy, cx, cy);
    } else if (cmd === 'C') {
      const x1 = num(); const y1 = num(); const x2 = num(); const y2 = num(); cx = num(); cy = num();
      path.cubicTo(x1, y1, x2, y2, cx, cy);
    }
  }
  return matrix ? path.transform(matrix) : path;
}

// ---------- Rasterización por cobertura de área ----------

function addEdge(acc, stride, w, h, ax, ay, bx, by) {
  if (ay === by) return;
  let dir = 1;
  let x0 = ax;
  let y0 = ay;
  let x1 = bx;
  let y1 = by;
  if (y0 > y1) {
    dir = -1; x0 = bx; y0 = by; x1 = ax; y1 = ay;
  }
  if (y1 <= 0 || y0 >= h) return;
  const dxdy = (x1 - x0) / (y1 - y0);
  let x = x0;
  if (y0 < 0) { x -= y0 * dxdy; y0 = 0; }
  const yEnd = Math.min(y1, h);
  const rowStart = Math.floor(y0);
  const rowEnd = Math.ceil(yEnd);
  for (let row = rowStart; row < rowEnd; row += 1) {
    const top = Math.max(row, y0);
    const bottom = Math.min(row + 1, yEnd);
    const dy = bottom - top;
    if (dy <= 0) continue;
    const xnext = x + dxdy * dy;
    const d = dy * dir;
    let xs = x;
    let xe = xnext;
    if (xs < 0) xs = 0; else if (xs > w) xs = w;
    if (xe < 0) xe = 0; else if (xe > w) xe = w;
    const left = xs < xe ? xs : xe;
    const right = xs < xe ? xe : xs;
    const leftFloor = Math.floor(left);
    const rightCeil = Math.ceil(right);
    const base = row * stride;
    if (rightCeil <= leftFloor + 1) {
      const xmf = 0.5 * (xs + xe) - leftFloor;
      acc[base + leftFloor] += d - d * xmf;
      acc[base + leftFloor + 1] += d * xmf;
    } else {
      const s = 1 / (right - left);
      const x0f = left - leftFloor;
      const a0 = 0.5 * s * (1 - x0f) * (1 - x0f);
      const x1f = right - rightCeil + 1;
      const am = 0.5 * s * x1f * x1f;
      acc[base + leftFloor] += d * a0;
      if (rightCeil === leftFloor + 2) {
        acc[base + leftFloor + 1] += d * (1 - a0 - am);
      } else {
        const a1 = s * (1.5 - x0f);
        acc[base + leftFloor + 1] += d * (a1 - a0);
        for (let xi = leftFloor + 2; xi < rightCeil - 1; xi += 1) acc[base + xi] += d * s;
        const a2 = a1 + (rightCeil - leftFloor - 3) * s;
        acc[base + rightCeil - 1] += d * (1 - a2 - am);
      }
      acc[base + rightCeil] += d * am;
    }
    x = xnext;
  }
}

// Devuelve { x, y, w, h, data: Float32Array(w·h) } con cobertura 0..1, o null si no toca el área.
// `bounds` = { x0, y0, x1, y1 } límites de dibujo (por defecto la superficie completa).
function rasterize(contours, bounds, dx = 0, dy = 0) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const pts of contours) {
    for (let i = 0; i < pts.length; i += 2) {
      const px = pts[i] + dx;
      const py = pts[i + 1] + dy;
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;
    }
  }
  if (!Number.isFinite(minX)) return null;
  const bx0 = Math.max(bounds.x0, Math.floor(minX));
  const by0 = Math.max(bounds.y0, Math.floor(minY));
  const bx1 = Math.min(bounds.x1, Math.ceil(maxX));
  const by1 = Math.min(bounds.y1, Math.ceil(maxY));
  const w = bx1 - bx0;
  const h = by1 - by0;
  if (w <= 0 || h <= 0) return null;
  const stride = w + 2;
  const acc = new Float32Array(stride * h + 2);
  for (const pts of contours) {
    const n = pts.length;
    for (let i = 0; i < n; i += 2) {
      const j = i + 2 < n ? i + 2 : 0;
      addEdge(acc, stride, w, h, pts[i] + dx - bx0, pts[i + 1] + dy - by0, pts[j] + dx - bx0, pts[j + 1] + dy - by0);
    }
  }
  const data = new Float32Array(w * h);
  for (let row = 0; row < h; row += 1) {
    let sum = 0;
    const base = row * stride;
    const out = row * w;
    for (let col = 0; col < w; col += 1) {
      sum += acc[base + col];
      const coverage = sum < 0 ? -sum : sum;
      data[out + col] = coverage > 1 ? 1 : coverage;
    }
  }
  return {
    x: bx0, y: by0, w, h, data,
  };
}

function maskMax(a, b) {
  if (!a) return b;
  if (!b) return a;
  const x0 = Math.min(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const x1 = Math.max(a.x + a.w, b.x + b.w);
  const y1 = Math.max(a.y + a.h, b.y + b.h);
  const w = x1 - x0;
  const h = y1 - y0;
  const data = new Float32Array(w * h);
  for (const m of [a, b]) {
    for (let j = 0; j < m.h; j += 1) {
      const dst = (m.y - y0 + j) * w + (m.x - x0);
      const src = j * m.w;
      for (let i = 0; i < m.w; i += 1) {
        const v = m.data[src + i];
        if (v > data[dst + i]) data[dst + i] = v;
      }
    }
  }
  return {
    x: x0, y: y0, w, h, data,
  };
}

function scaleMask(mask, factor) {
  if (!mask) return null;
  const data = new Float32Array(mask.data.length);
  for (let i = 0; i < data.length; i += 1) data[i] = Math.min(1, mask.data[i] * factor);
  return {
    x: mask.x, y: mask.y, w: mask.w, h: mask.h, data,
  };
}

// Silueta engrosada `radius` px (unión de la forma desplazada en un círculo): contornos gruesos de texto/iconos.
function outlineMask(contours, radius, bounds, steps = 16) {
  let mask = rasterize(contours, bounds, 0, 0);
  if (radius <= 0.01) return mask;
  const rings = radius > 3 ? [radius * 0.5, radius] : [radius];
  for (const r of rings) {
    for (let i = 0; i < steps; i += 1) {
      const angle = (i / steps) * Math.PI * 2;
      mask = maskMax(mask, rasterize(contours, bounds, Math.cos(angle) * r, Math.sin(angle) * r));
    }
  }
  return mask;
}

function blurPass(src, dst, w, h, radius, horizontal) {
  const lines = horizontal ? h : w;
  const length = horizontal ? w : h;
  const step = horizontal ? 1 : w;
  const lineStep = horizontal ? w : 1;
  const prefix = new Float64Array(length + 1);
  const scale = 1 / (2 * radius + 1);
  for (let line = 0; line < lines; line += 1) {
    const base = line * lineStep;
    prefix[0] = 0;
    for (let i = 0; i < length; i += 1) prefix[i + 1] = prefix[i] + src[base + i * step];
    for (let i = 0; i < length; i += 1) {
      const lo = i - radius < 0 ? 0 : i - radius;
      const hi = i + radius + 1 > length ? length : i + radius + 1;
      dst[base + i * step] = (prefix[hi] - prefix[lo]) * scale;
    }
  }
}

// Desenfoque ≈ gaussiano (3 cajas) con desviación `sigma` px; amplía la máscara para no recortar el halo.
function blurMask(mask, sigma) {
  if (!mask) return null;
  const radius = Math.max(1, Math.round(sigma - 0.5));
  const pad = radius * 3 + 2;
  const w = mask.w + pad * 2;
  const h = mask.h + pad * 2;
  let a = new Float32Array(w * h);
  let b = new Float32Array(w * h);
  for (let j = 0; j < mask.h; j += 1) a.set(mask.data.subarray(j * mask.w, (j + 1) * mask.w), (j + pad) * w + pad);
  for (let pass = 0; pass < 3; pass += 1) {
    blurPass(a, b, w, h, radius, true);
    blurPass(b, a, w, h, radius, false);
  }
  return {
    x: mask.x - pad, y: mask.y - pad, w, h, data: a,
  };
}

function maskSampler(mask) {
  if (!mask) return { at: () => 0 };
  return {
    at(x, y) {
      const i = x - mask.x;
      const j = y - mask.y;
      if (i < 0 || j < 0 || i >= mask.w || j >= mask.h) return 0;
      return mask.data[j * mask.w + i];
    },
  };
}

// ---------- Superficie ----------

class Surface {
  constructor(width, height) {
    this.w = width;
    this.h = height;
    this.data = new Float32Array(width * height * 4); // RGBA premultiplicado
    this.bounds = {
      x0: 0, y0: 0, x1: width, y1: height,
    };
  }

  clone() {
    const copy = new Surface(this.w, this.h);
    copy.data.set(this.data);
    return copy;
  }

  fill(paint, opacity = 1) {
    const out = [0, 0, 0, 0];
    const { data, w, h } = this;
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        paint.at(x + 0.5, y + 0.5, out);
        const a = out[3] * opacity;
        const ia = 1 - a;
        const i = (y * w + x) * 4;
        data[i] = out[0] * a + data[i] * ia;
        data[i + 1] = out[1] * a + data[i + 1] * ia;
        data[i + 2] = out[2] * a + data[i + 2] * ia;
        data[i + 3] = a + data[i + 3] * ia;
      }
    }
  }

  fillMask(mask, paint, { opacity = 1, clip = null } = {}) {
    if (!mask) return;
    const {
      data, w: W, h: H,
    } = this;
    const out = [0, 0, 0, 0];
    const solidColor = paint.solid || null;
    for (let j = 0; j < mask.h; j += 1) {
      const sy = mask.y + j;
      if (sy < 0 || sy >= H) continue;
      for (let i = 0; i < mask.w; i += 1) {
        const sx = mask.x + i;
        if (sx < 0 || sx >= W) continue;
        let coverage = mask.data[j * mask.w + i];
        if (coverage < 0.002) continue;
        if (clip) {
          coverage *= clip.at(sx, sy);
          if (coverage < 0.002) continue;
        }
        let r; let g; let b; let a;
        if (solidColor) {
          [r, g, b, a] = solidColor;
        } else {
          paint.at(sx + 0.5, sy + 0.5, out);
          [r, g, b, a] = out;
        }
        a *= coverage * opacity;
        const ia = 1 - a;
        const idx = (sy * W + sx) * 4;
        data[idx] = r * a + data[idx] * ia;
        data[idx + 1] = g * a + data[idx + 1] * ia;
        data[idx + 2] = b * a + data[idx + 2] * ia;
        data[idx + 3] = a + data[idx + 3] * ia;
      }
    }
  }

  fillPath(path, paint, options = {}) {
    this.fillMask(rasterize(path.flatten(), this.bounds), paint, options);
  }

  // Sombra difusa o brillo: silueta de la ruta desplazada, desenfocada y teñida.
  shadowPath(path, { dx = 0, dy = 0, blur = 6, color = '#000000', opacity = 1, spread = 0 } = {}) {
    const wide = {
      x0: this.bounds.x0 - 60, y0: this.bounds.y0 - 60, x1: this.bounds.x1 + 60, y1: this.bounds.y1 + 60,
    };
    let mask = spread > 0 ? outlineMask(path.flatten(), spread, wide, 12) : rasterize(path.flatten(), wide, 0, 0);
    if (!mask) return;
    if (blur > 0.5) mask = blurMask(mask, blur);
    mask = { ...mask, x: mask.x + Math.round(dx), y: mask.y + Math.round(dy) };
    this.fillMask(mask, solid(color), { opacity });
  }

  // Compone otra superficie (premultiplicada) encima: source-over.
  blit(sprite, dx, dy, opacity = 1) {
    const x0 = Math.max(0, dx);
    const y0 = Math.max(0, dy);
    const x1 = Math.min(this.w, dx + sprite.w);
    const y1 = Math.min(this.h, dy + sprite.h);
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        const s = ((y - dy) * sprite.w + (x - dx)) * 4;
        const sa = sprite.data[s + 3] * opacity;
        if (sa <= 0.0005) continue;
        const d = (y * this.w + x) * 4;
        const ia = 1 - sa;
        this.data[d] = sprite.data[s] * opacity + this.data[d] * ia;
        this.data[d + 1] = sprite.data[s + 1] * opacity + this.data[d + 1] * ia;
        this.data[d + 2] = sprite.data[s + 2] * opacity + this.data[d + 2] * ia;
        this.data[d + 3] = sa + this.data[d + 3] * ia;
      }
    }
  }

  // Dibuja una imagen RGBA8 (alfa NO premultiplicado), escalada con muestreo bilineal / promedio por bloques.
  drawImage(image, dx, dy, dw, dh, { opacity = 1 } = {}) {
    const samples = Math.max(1, Math.min(4, Math.ceil(image.width / dw)));
    const scaleX = image.width / dw;
    const scaleY = image.height / dh;
    const x0 = Math.max(0, Math.floor(dx));
    const y0 = Math.max(0, Math.floor(dy));
    const x1 = Math.min(this.w, Math.ceil(dx + dw));
    const y1 = Math.min(this.h, Math.ceil(dy + dh));
    const px = (ix, iy, out) => { // lee un píxel premultiplicado con borde sujeto
      const cx = ix < 0 ? 0 : ix >= image.width ? image.width - 1 : ix;
      const cy = iy < 0 ? 0 : iy >= image.height ? image.height - 1 : iy;
      const o = (cy * image.width + cx) * 4;
      const a = image.data[o + 3] / 255;
      out[0] += image.data[o] / 255 * a; out[1] += image.data[o + 1] / 255 * a; out[2] += image.data[o + 2] / 255 * a; out[3] += a;
    };
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        const acc = [0, 0, 0, 0];
        let count = 0;
        for (let sy = 0; sy < samples; sy += 1) {
          for (let sx = 0; sx < samples; sx += 1) {
            const u = (x + (sx + 0.5) / samples - dx) * scaleX - 0.5;
            const v = (y + (sy + 0.5) / samples - dy) * scaleY - 0.5;
            const iu = Math.floor(u);
            const iv = Math.floor(v);
            const fu = u - iu;
            const fv = v - iv;
            const tmp = [0, 0, 0, 0];
            const corner = [0, 0, 0, 0];
            for (const [ox, oy, wgt] of [[0, 0, (1 - fu) * (1 - fv)], [1, 0, fu * (1 - fv)], [0, 1, (1 - fu) * fv], [1, 1, fu * fv]]) {
              corner[0] = 0; corner[1] = 0; corner[2] = 0; corner[3] = 0;
              px(iu + ox, iv + oy, corner);
              tmp[0] += corner[0] * wgt; tmp[1] += corner[1] * wgt; tmp[2] += corner[2] * wgt; tmp[3] += corner[3] * wgt;
            }
            acc[0] += tmp[0]; acc[1] += tmp[1]; acc[2] += tmp[2]; acc[3] += tmp[3];
            count += 1;
          }
        }
        const a = (acc[3] / count) * opacity;
        if (a <= 0.0005) continue;
        const ia = 1 - a;
        const d = (y * this.w + x) * 4;
        this.data[d] = (acc[0] / count) * opacity + this.data[d] * ia;
        this.data[d + 1] = (acc[1] / count) * opacity + this.data[d + 1] * ia;
        this.data[d + 2] = (acc[2] / count) * opacity + this.data[d + 2] * ia;
        this.data[d + 3] = a + this.data[d + 3] * ia;
      }
    }
  }

  // Multiplica toda la superficie por una máscara (para recortar sprites a una forma).
  applyMask(mask) {
    const sampler = maskSampler(mask);
    for (let y = 0; y < this.h; y += 1) {
      for (let x = 0; x < this.w; x += 1) {
        const k = sampler.at(x, y);
        const i = (y * this.w + x) * 4;
        this.data[i] *= k; this.data[i + 1] *= k; this.data[i + 2] *= k; this.data[i + 3] *= k;
      }
    }
  }

  // RGB8 de una superficie totalmente opaca (el fondo de las escenas cubre todo el lienzo).
  toRGB8() {
    const out = new Uint8Array(this.w * this.h * 3);
    for (let i = 0, j = 0; i < this.data.length; i += 4, j += 3) {
      const a = this.data[i + 3];
      const k = a > 0.0001 ? 255 / a : 0;
      let v = this.data[i] * k; out[j] = v < 0 ? 0 : v > 255 ? 255 : (v + 0.5) | 0;
      v = this.data[i + 1] * k; out[j + 1] = v < 0 ? 0 : v > 255 ? 255 : (v + 0.5) | 0;
      v = this.data[i + 2] * k; out[j + 2] = v < 0 ? 0 : v > 255 ? 255 : (v + 0.5) | 0;
    }
    return out;
  }

  // RGBA8 con alfa NO premultiplicado (listo para PNG).
  toRGBA8() {
    const out = new Uint8Array(this.w * this.h * 4);
    for (let i = 0; i < this.data.length; i += 4) {
      const a = this.data[i + 3];
      if (a <= 1 / 512) { out[i] = 0; out[i + 1] = 0; out[i + 2] = 0; out[i + 3] = 0; continue; }
      const inv = 1 / a;
      const clamp = (v) => Math.max(0, Math.min(255, Math.round(v * inv * 255)));
      out[i] = clamp(this.data[i]);
      out[i + 1] = clamp(this.data[i + 1]);
      out[i + 2] = clamp(this.data[i + 2]);
      out[i + 3] = Math.max(0, Math.min(255, Math.round(a * 255)));
    }
    return out;
  }
}

module.exports = {
  Surface, Path, Mat, pathFromSVG, parseColor, solid, linearGradient, radialGradient,
  rasterize, maskMax, scaleMask, outlineMask, blurMask, maskSampler,
};
