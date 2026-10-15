#!/usr/bin/env python3
"""Extrae contornos de glifos de fuentes OFL a JSON compacto (assets/fonts/*.json).

Uso (solo cuando quieras regenerar los assets; el bot NO necesita Python ni las fuentes en ejecución):
    pip install fonttools
    python3 tools/extract-glyphs.py <ruta/Fuente.ttf> <salida.json> "<Nombre de la fuente>" <ruta/OFL.txt>

El JSON resultante es un subconjunto de glifos de una fuente con licencia SIL OFL 1.1 (texto en assets/fonts/LICENSES).
"""
import json
import sys

from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.ttLib import TTFont

CHARS = (
    " !\"#%&'()*+,-./0123456789:;<=>?"
    "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    "abcdefghijklmnopqrstuvwxyz"
    "¡¿ÁÉÍÓÚÑÜáéíóúñü·×−♠♥♦♣"
)


def main(path, out, name, license_path):
    font = TTFont(path)
    cmap = font.getBestCmap()
    glyph_set = font.getGlyphSet()
    upem = font["head"].unitsPerEm
    hhea = font["hhea"]
    os2 = font["OS/2"]
    glyphs = {}
    for ch in CHARS:
        glyph_name = cmap.get(ord(ch))
        if glyph_name is None:
            continue
        pen = SVGPathPen(glyph_set, ntos=lambda v: str(int(round(v))) if abs(v - round(v)) < 1e-6 else f"{v:.1f}")
        glyph_set[glyph_name].draw(pen)
        glyphs[ch] = {"w": int(round(font["hmtx"][glyph_name][0])), "d": pen.getCommands()}
    data = {
        "name": name,
        "license": "SIL Open Font License 1.1 (assets/fonts/LICENSES)",
        "unitsPerEm": upem,
        "ascender": hhea.ascent,
        "descender": hhea.descent,
        "capHeight": getattr(os2, "sCapHeight", int(upem * 0.7)) or int(upem * 0.7),
        "glyphs": glyphs,
    }
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, separators=(",", ":"))
    print(f"{name}: {len(glyphs)} glifos, upem={upem}, {len(json.dumps(data))} bytes")


if __name__ == "__main__":
    main(*sys.argv[1:5])
