'use strict';

// ============================================================
//  EMOJI-ART — Iconos vectoriales de respaldo con acabado "glossy" estilo iOS.
//  Se usan cuando no hay un PNG de emoji Apple disponible (sin red / CDN caído), de modo que
//  JAMÁS aparece un cuadro vacío ni un emoji roto. Cada función dibuja centrada en (cx, cy) con
//  ancho aproximado `s` píxeles.
// ============================================================

const {
  Path, Mat, solid, linearGradient, radialGradient,
} = require('./raster');

function ellipsePath(cx, cy, rx, ry) { return new Path().ellipse(cx, cy, rx, ry); }

function gloss(surface, cx, cy, rx, ry, alpha = 0.45) {
  surface.fillPath(ellipsePath(cx, cy, rx, ry), linearGradient(cx, cy - ry, cx, cy + ry, [[0, `#ffffff${Math.round(alpha * 255).toString(16).padStart(2, '0')}`], [1, '#ffffff00']]));
}

function pumpkin(surface, cx, cy, s) {
  // sombra de contacto
  surface.fillPath(ellipsePath(cx, cy + s * 0.43, s * 0.34, s * 0.06), solid('#000000', 0.28));
  const lobes = [[-0.2, 0.25, 0.33], [0.2, 0.25, 0.33], [0, 0.29, 0.37]];
  lobes.forEach(([ox, rx, ry], index) => {
    const lx = cx + ox * s;
    const ly = cy + 0.06 * s;
    const body = ellipsePath(lx, ly, rx * s, ry * s);
    surface.fillPath(body, radialGradient(lx - rx * s * 0.35, ly - ry * s * 0.45, ry * s * 1.35, [[0, '#ffc15e'], [0.45, '#ff8a1f'], [1, '#c2410c']]));
    if (index < 2) { // costura entre gajos
      surface.fillPath(new Path().ellipse(lx, ly, rx * s, ry * s).ellipse(lx, ly, rx * s * 0.9, ry * s * 0.97, true), solid('#a3330a', 0.45));
    }
  });
  // tallo
  const stem = new Path()
    .moveTo(cx - 0.05 * s, cy - 0.27 * s)
    .cubicTo(cx - 0.06 * s, cy - 0.40 * s, cx - 0.02 * s, cy - 0.45 * s, cx + 0.07 * s, cy - 0.47 * s)
    .lineTo(cx + 0.12 * s, cy - 0.41 * s)
    .cubicTo(cx + 0.06 * s, cy - 0.38 * s, cx + 0.07 * s, cy - 0.33 * s, cx + 0.08 * s, cy - 0.26 * s)
    .close();
  surface.fillPath(stem, linearGradient(cx - 0.05 * s, cy - 0.47 * s, cx + 0.12 * s, cy - 0.26 * s, [[0, '#8ee05e'], [1, '#2f7d32']]));
  // cara con resplandor interior
  const face = new Path()
    .polygon([[cx - 0.21 * s, cy - 0.04 * s], [cx - 0.07 * s, cy - 0.04 * s], [cx - 0.14 * s, cy - 0.16 * s]])
    .polygon([[cx + 0.07 * s, cy - 0.04 * s], [cx + 0.21 * s, cy - 0.04 * s], [cx + 0.14 * s, cy - 0.16 * s]])
    .polygon([[cx, cy + 0.03 * s], [cx - 0.04 * s, cy + 0.10 * s], [cx + 0.04 * s, cy + 0.10 * s]])
    .polygon([
      [cx - 0.26 * s, cy + 0.14 * s], [cx - 0.15 * s, cy + 0.22 * s], [cx - 0.09 * s, cy + 0.15 * s], [cx - 0.03 * s, cy + 0.23 * s],
      [cx + 0.03 * s, cy + 0.15 * s], [cx + 0.09 * s, cy + 0.23 * s], [cx + 0.15 * s, cy + 0.15 * s], [cx + 0.26 * s, cy + 0.14 * s],
      [cx + 0.17 * s, cy + 0.32 * s], [cx, cy + 0.36 * s], [cx - 0.17 * s, cy + 0.32 * s],
    ]);
  surface.shadowPath(face, { blur: s * 0.05, color: '#ffe14a', opacity: 0.85, spread: s * 0.015 });
  surface.fillPath(face, linearGradient(cx, cy - 0.16 * s, cx, cy + 0.36 * s, [[0, '#5a1d02'], [1, '#2b0d00']]));
  gloss(surface, cx - 0.17 * s, cy - 0.18 * s, 0.14 * s, 0.1 * s, 0.5);
}

function ghost(surface, cx, cy, s) {
  surface.fillPath(ellipsePath(cx, cy + s * 0.44, s * 0.28, s * 0.05), solid('#000000', 0.25));
  const w = s * 0.34;
  const top = cy - s * 0.42;
  const bottom = cy + s * 0.40;
  const body = new Path()
    .moveTo(cx - w, bottom)
    .lineTo(cx - w, cy - s * 0.08)
    .cubicTo(cx - w, top - s * 0.02, cx - w * 0.5, top, cx, top)
    .cubicTo(cx + w * 0.5, top, cx + w, top - s * 0.02, cx + w, cy - s * 0.08)
    .lineTo(cx + w, bottom)
    .quadTo(cx + w * 0.78, bottom - s * 0.14, cx + w * 0.5, bottom)
    .quadTo(cx + w * 0.25, bottom - s * 0.14, cx, bottom)
    .quadTo(cx - w * 0.25, bottom - s * 0.14, cx - w * 0.5, bottom)
    .quadTo(cx - w * 0.78, bottom - s * 0.14, cx - w, bottom)
    .close();
  surface.shadowPath(body, { blur: 0.6, spread: s * 0.02, color: '#7f88c9', opacity: 0.95 });
  surface.fillPath(body, linearGradient(cx - w, top, cx + w, bottom, [[0, '#ffffff'], [0.6, '#eef0ff'], [1, '#c3c9f5']]));
  const eyes = new Path().ellipse(cx - s * 0.12, cy - s * 0.1, s * 0.055, s * 0.085).ellipse(cx + s * 0.12, cy - s * 0.1, s * 0.055, s * 0.085);
  surface.fillPath(eyes, solid('#1b1530'));
  surface.fillPath(new Path().ellipse(cx - s * 0.1, cy - s * 0.125, s * 0.016, s * 0.026).ellipse(cx + s * 0.14, cy - s * 0.125, s * 0.016, s * 0.026), solid('#ffffff', 0.9));
  surface.fillPath(ellipsePath(cx, cy + s * 0.08, s * 0.06, s * 0.08), solid('#1b1530'));
  surface.fillPath(new Path().ellipse(cx - s * 0.22, cy + s * 0.04, s * 0.05, s * 0.03).ellipse(cx + s * 0.22, cy + s * 0.04, s * 0.05, s * 0.03), solid('#ff8fb1', 0.55));
  gloss(surface, cx - s * 0.1, cy - s * 0.3, s * 0.15, s * 0.08, 0.7);
}

function bat(surface, cx, cy, s) {
  surface.fillPath(ellipsePath(cx, cy + s * 0.3, s * 0.3, s * 0.04), solid('#000000', 0.2));
  const wing = (dir) => new Path()
    .moveTo(cx + dir * s * 0.07, cy - s * 0.06)
    .cubicTo(cx + dir * s * 0.2, cy - s * 0.3, cx + dir * s * 0.38, cy - s * 0.3, cx + dir * s * 0.5, cy - s * 0.18)
    .quadTo(cx + dir * s * 0.44, cy - s * 0.04, cx + dir * s * 0.47, cy + s * 0.08)
    .quadTo(cx + dir * s * 0.38, cy + s * 0.02, cx + dir * s * 0.33, cy + s * 0.14)
    .quadTo(cx + dir * s * 0.26, cy + s * 0.04, cx + dir * s * 0.18, cy + s * 0.16)
    .quadTo(cx + dir * s * 0.12, cy + s * 0.08, cx + dir * s * 0.07, cy + s * 0.18)
    .close();
  for (const dir of [-1, 1]) surface.fillPath(wing(dir), linearGradient(cx, cy - s * 0.3, cx + dir * s * 0.5, cy + s * 0.18, [[0, '#6a3fb0'], [1, '#2a1650']]));
  const body = ellipsePath(cx, cy + s * 0.04, s * 0.11, s * 0.2);
  surface.fillPath(body, linearGradient(cx - s * 0.11, cy - s * 0.15, cx + s * 0.11, cy + s * 0.25, [[0, '#7c4dcc'], [1, '#2a1650']]));
  const head = ellipsePath(cx, cy - s * 0.15, s * 0.1, s * 0.09);
  surface.fillPath(head, linearGradient(cx - s * 0.1, cy - s * 0.24, cx + s * 0.1, cy - s * 0.06, [[0, '#8a5ad8'], [1, '#341b66']]));
  surface.fillPath(new Path()
    .polygon([[cx - s * 0.1, cy - s * 0.2], [cx - s * 0.13, cy - s * 0.34], [cx - s * 0.03, cy - s * 0.23]])
    .polygon([[cx + s * 0.1, cy - s * 0.2], [cx + s * 0.13, cy - s * 0.34], [cx + s * 0.03, cy - s * 0.23]]), solid('#4b2a8a'));
  surface.fillPath(new Path().ellipse(cx - s * 0.04, cy - s * 0.16, s * 0.022, s * 0.03).ellipse(cx + s * 0.04, cy - s * 0.16, s * 0.022, s * 0.03), solid('#ffdf4a'));
  surface.fillPath(new Path().polygon([[cx - s * 0.035, cy - s * 0.1], [cx - s * 0.015, cy - s * 0.1], [cx - s * 0.025, cy - s * 0.06]])
    .polygon([[cx + s * 0.035, cy - s * 0.1], [cx + s * 0.015, cy - s * 0.1], [cx + s * 0.025, cy - s * 0.06]]), solid('#ffffff'));
  gloss(surface, cx - s * 0.03, cy - s * 0.02, s * 0.04, s * 0.08, 0.35);
}

function candy(surface, cx, cy, s) {
  surface.fillPath(ellipsePath(cx, cy + s * 0.3, s * 0.3, s * 0.05), solid('#000000', 0.22));
  const wrapper = (dir) => new Path()
    .moveTo(cx + dir * s * 0.2, cy)
    .lineTo(cx + dir * s * 0.46, cy - s * 0.22)
    .quadTo(cx + dir * s * 0.4, cy, cx + dir * s * 0.46, cy + s * 0.22)
    .close();
  for (const dir of [-1, 1]) {
    surface.fillPath(wrapper(dir), linearGradient(cx + dir * s * 0.2, cy - s * 0.2, cx + dir * s * 0.46, cy + s * 0.2, [[0, '#ffd1e3'], [1, '#ff6fa8']]));
  }
  const body = ellipsePath(cx, cy, s * 0.25, s * 0.25);
  surface.fillPath(body, radialGradient(cx - s * 0.08, cy - s * 0.1, s * 0.34, [[0, '#ff93bf'], [0.55, '#f0407c'], [1, '#b81455']]));
  // espiral blanca
  surface.fillPath(new Path()
    .moveTo(cx - s * 0.22, cy - s * 0.02).quadTo(cx - s * 0.08, cy - s * 0.2, cx + s * 0.22, cy - s * 0.04)
    .lineTo(cx + s * 0.2, cy + s * 0.02).quadTo(cx - s * 0.05, cy - s * 0.12, cx - s * 0.2, cy + s * 0.04).close(), solid('#ffffff', 0.85));
  surface.fillPath(new Path()
    .moveTo(cx - s * 0.18, cy + s * 0.12).quadTo(cx, cy - s * 0.02, cx + s * 0.2, cy + s * 0.12)
    .lineTo(cx + s * 0.17, cy + s * 0.18).quadTo(cx, cy + s * 0.04, cx - s * 0.15, cy + s * 0.18).close(), solid('#ffffff', 0.7));
  gloss(surface, cx - s * 0.1, cy - s * 0.14, s * 0.1, s * 0.06, 0.8);
}

function crown(surface, cx, cy, s) {
  surface.fillPath(ellipsePath(cx, cy + s * 0.34, s * 0.34, s * 0.05), solid('#000000', 0.25));
  const body = new Path()
    .moveTo(cx - s * 0.36, cy + s * 0.28)
    .lineTo(cx - s * 0.4, cy - s * 0.22)
    .lineTo(cx - s * 0.18, cy - s * 0.02)
    .lineTo(cx, cy - s * 0.3)
    .lineTo(cx + s * 0.18, cy - s * 0.02)
    .lineTo(cx + s * 0.4, cy - s * 0.22)
    .lineTo(cx + s * 0.36, cy + s * 0.28)
    .close();
  surface.shadowPath(body, { blur: 0.6, spread: s * 0.02, color: '#8a5200', opacity: 1 });
  surface.fillPath(body, linearGradient(cx - s * 0.4, cy - s * 0.3, cx + s * 0.4, cy + s * 0.28, [[0, '#fff2a6'], [0.45, '#ffc520'], [1, '#d98a00']]));
  surface.fillPath(new Path().roundRect(cx - s * 0.36, cy + s * 0.14, s * 0.72, s * 0.14, s * 0.04), linearGradient(cx, cy + s * 0.14, cx, cy + s * 0.28, [[0, '#ffe36a'], [1, '#c77a00']]));
  const gems = [[-0.4, -0.22, '#ff4d6d'], [0, -0.3, '#4dc3ff'], [0.4, -0.22, '#6bff9a']];
  for (const [gx, gy, gc] of gems) {
    surface.fillPath(new Path().circle(cx + gx * s, cy + gy * s, s * 0.055), radialGradient(cx + gx * s - s * 0.02, cy + gy * s - s * 0.02, s * 0.08, [[0, '#ffffff'], [0.4, gc], [1, '#222244']]));
  }
  for (const gx of [-0.2, 0, 0.2]) {
    surface.fillPath(new Path().polygon([[cx + gx * s, cy + s * 0.1], [cx + (gx + 0.05) * s, cy + s * 0.2], [cx + gx * s, cy + s * 0.26], [cx + (gx - 0.05) * s, cy + s * 0.2]]), solid('#ffffff', 0.55));
  }
  gloss(surface, cx - s * 0.2, cy - s * 0.05, s * 0.1, s * 0.05, 0.6);
}

function skull(surface, cx, cy, s) {
  surface.fillPath(ellipsePath(cx, cy + s * 0.4, s * 0.28, s * 0.05), solid('#000000', 0.25));
  const cranium = ellipsePath(cx, cy - s * 0.06, s * 0.34, s * 0.32);
  const jaw = new Path().roundRect(cx - s * 0.19, cy + s * 0.14, s * 0.38, s * 0.24, s * 0.06);
  for (const shape of [cranium, jaw]) {
    surface.shadowPath(shape, { blur: 0.6, spread: s * 0.015, color: '#7a735a', opacity: 0.9 });
    surface.fillPath(shape, radialGradient(cx - s * 0.1, cy - s * 0.2, s * 0.55, [[0, '#ffffff'], [0.6, '#f4efd9'], [1, '#c9c2a2']]));
  }
  surface.fillPath(new Path().ellipse(cx - s * 0.14, cy - s * 0.04, s * 0.095, s * 0.11).ellipse(cx + s * 0.14, cy - s * 0.04, s * 0.095, s * 0.11), solid('#1f1a2e'));
  surface.fillPath(new Path().polygon([[cx, cy + s * 0.06], [cx - s * 0.04, cy + s * 0.15], [cx + s * 0.04, cy + s * 0.15]]), solid('#1f1a2e'));
  for (const gx of [-0.12, -0.04, 0.04, 0.12]) {
    surface.fillPath(new Path().rect(cx + gx * s - s * 0.006, cy + s * 0.2, s * 0.012, s * 0.16), solid('#8c8466', 0.8));
  }
  gloss(surface, cx - s * 0.14, cy - s * 0.25, s * 0.13, s * 0.07, 0.8);
}

function boom(surface, cx, cy, s) {
  const star = (rOuter, rInner, rotation = 0) => {
    const points = [];
    for (let i = 0; i < 20; i += 1) {
      const angle = rotation + (i / 20) * Math.PI * 2;
      const r = i % 2 === 0 ? rOuter : rInner;
      points.push([cx + Math.cos(angle) * r, cy + Math.sin(angle) * r]);
    }
    return new Path().polygon(points);
  };
  surface.shadowPath(star(s * 0.46, s * 0.27), { blur: s * 0.05, color: '#ff3b00', opacity: 0.8 });
  surface.fillPath(star(s * 0.46, s * 0.27), radialGradient(cx, cy, s * 0.46, [[0, '#ffe46b'], [0.6, '#ff8a1f'], [1, '#e11d0e']]));
  surface.fillPath(star(s * 0.3, s * 0.17, 0.15), radialGradient(cx, cy, s * 0.3, [[0, '#ffffff'], [0.5, '#fff08a'], [1, '#ffb52e']]));
}

function sparkle(surface, cx, cy, s) {
  const star = (px, py, r, color) => {
    const inner = r * 0.28;
    const path = new Path().polygon([
      [px, py - r], [px + inner, py - inner], [px + r, py], [px + inner, py + inner],
      [px, py + r], [px - inner, py + inner], [px - r, py], [px - inner, py - inner],
    ]);
    surface.shadowPath(path, { blur: r * 0.3, color, opacity: 0.8 });
    surface.fillPath(path, linearGradient(px - r, py - r, px + r, py + r, [[0, '#ffffff'], [0.5, color], [1, '#ffb000']]));
  };
  star(cx - s * 0.08, cy + s * 0.05, s * 0.34, '#ffe14a');
  star(cx + s * 0.28, cy - s * 0.26, s * 0.17, '#fff3a0');
  star(cx + s * 0.26, cy + s * 0.3, s * 0.13, '#ffd23a');
}

const ART = {
  pumpkin, ghost, bat, candy, crown, skull, boom, sparkle,
};

module.exports = {
  ART, pumpkin, ghost, bat, candy, crown, skull, boom, sparkle, Mat,
};
