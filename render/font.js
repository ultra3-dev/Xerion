'use strict';

// ============================================================
//  FONT — Texto vectorial a partir de contornos (assets/fonts/*.json, subconjuntos de fuentes OFL).
//  No usa fuentes del sistema ni librerías nativas: el texto se ve igual en cualquier servidor.
//  Caracteres no incluidos en la fuente se sustituyen por "?" (nunca aparecen cuadros vacíos).
// ============================================================

const fs = require('node:fs');
const path = require('node:path');
const {
  Path, pathFromSVG, rasterize, outlineMask, blurMask, solid,
} = require('./raster');

const FONT_DIR = path.join(__dirname, '..', 'assets', 'fonts');
const cache = new Map();

function loadFont(name = 'display') {
  if (cache.has(name)) return cache.get(name);
  const raw = JSON.parse(fs.readFileSync(path.join(FONT_DIR, `${name}.json`), 'utf8'));
  const glyphs = new Map();
  for (const [ch, glyph] of Object.entries(raw.glyphs)) {
    glyphs.set(ch, { advance: glyph.w, path: glyph.d ? pathFromSVG(glyph.d) : new Path() });
  }
  const font = {
    name: raw.name, upem: raw.unitsPerEm, capHeight: raw.capHeight, glyphs,
  };
  cache.set(name, font);
  return font;
}

function glyphFor(font, ch) {
  return font.glyphs.get(ch) || font.glyphs.get('?') || font.glyphs.get(' ');
}

function measureText(font, text, size, spacing = 0) {
  const scale = size / font.upem;
  let width = 0;
  const chars = [...String(text)];
  chars.forEach((ch, i) => {
    width += glyphFor(font, ch).advance * scale + (i < chars.length - 1 ? spacing : 0);
  });
  return width;
}

// Ruta del texto en coordenadas de pantalla; `y` es la línea base. Devuelve { path, width, capHeight }.
function layoutText(font, text, {
  size, x = 0, y = 0, align = 'left', spacing = 0,
}) {
  const scale = size / font.upem;
  const width = measureText(font, text, size, spacing);
  let pen = x;
  if (align === 'center') pen = x - width / 2;
  else if (align === 'right') pen = x - width;
  const out = new Path();
  for (const ch of [...String(text)]) {
    const glyph = glyphFor(font, ch);
    if (glyph) out.append(glyph.path, [scale, 0, 0, -scale, pen, y]);
    pen += (glyph ? glyph.advance : 0) * scale + spacing;
  }
  return { path: out, width, capHeight: font.capHeight * scale };
}

function asPaint(fill) {
  if (!fill) return solid('#ffffff');
  return typeof fill === 'string' || Array.isArray(fill) ? solid(fill) : fill;
}

// Dibuja texto con relleno (color o degradado), contorno grueso y sombra opcionales.
//   outline: { color, width }      shadow: { dx, dy, blur, color, opacity }      matrix: transformación afín del texto
function drawText(surface, text, options) {
  const font = loadFont(options.font || 'display');
  const laid = layoutText(font, text, options);
  const finalPath = options.matrix ? laid.path.transform(options.matrix) : laid.path;
  const contours = finalPath.flatten();
  const wide = {
    x0: surface.bounds.x0 - 40, y0: surface.bounds.y0 - 40, x1: surface.bounds.x1 + 40, y1: surface.bounds.y1 + 40,
  };
  const outlineWidth = options.outline ? options.outline.width : 0;

  if (options.shadow) {
    const sh = options.shadow;
    let mask = outlineMask(contours, outlineWidth, wide, outlineWidth > 3 ? 12 : 8);
    if (sh.blur > 0.5) mask = blurMask(mask, sh.blur);
    if (mask) {
      mask = { ...mask, x: mask.x + Math.round(sh.dx || 0), y: mask.y + Math.round(sh.dy || 0) };
      surface.fillMask(mask, solid(sh.color || '#000000'), { opacity: sh.opacity === undefined ? 0.6 : sh.opacity });
    }
  }
  if (options.outline) {
    surface.fillMask(outlineMask(contours, outlineWidth, wide, outlineWidth > 3 ? 12 : 8), solid(options.outline.color));
  }
  surface.fillMask(rasterize(contours, wide), asPaint(options.fill));
  return { width: laid.width, capHeight: laid.capHeight };
}

module.exports = {
  loadFont, measureText, layoutText, drawText,
};
