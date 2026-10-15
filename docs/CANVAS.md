# 🎨 Canvas del blackjack

La mesa del blackjack se dibuja como una **imagen PNG** y se muestra dentro de un contenedor Components V2 (con el color de acento del
estado de la mano, título, galería de medios, resumen y botones). Todo el motor gráfico está en `render/` y **no usa dependencias nuevas**:
ni `canvas`, ni `@napi-rs/canvas`, ni fuentes del sistema. Por eso `package.json` y `package-lock.json` solo cambian de versión.

## Qué se ve

Mesa de fieltro con aro dorado y telarañas, título «BLACKJACK» con contorno y sombra, calabaza y fantasma, cartas dibujadas a mano (índices,
pips clásicos, J/Q/K con marco, ases grandes, reverso de Halloween), insignias de puntos que cambian de color (dorado normal, verde 21, rojo
al pasarse, naranja blackjack, violeta con carta oculta), pila de fichas según la apuesta, contador de mesa `n/15` con 15 puntos, y un banner
inclinado con el resultado (**¡BLACKJACK!**, **¡GANASTE!**, **¡LA BANCA SE PASÓ!**, **EMPATE**, **MESA LLENA · EMPATE**, **¡TE PASASTE!**,
**PERDISTE**) con el neto ganado o perdido. Con 6 o más cartas la mano se solapa para caber siempre.

La imagen **solo dibuja el estado que recibe** (el resultado ya lo decidió `economy.js`): no sortea ni calcula pagos.

## Emojis Apple (iPhone)

`render/emoji.js` busca cada emoji en este orden: memoria → `assets/emoji/<codepoint>.png` (tus propios PNG de 64×64) → caché en disco →
descarga HTTPS del paquete `emoji-datasource-apple` (jsDelivr) → **iconos vectoriales de respaldo** con acabado glossy estilo iOS. Así nunca
aparecen cuadros vacíos ni emojis rotos, haya o no red. Dibujar nunca espera a la red; al arrancar (`ready`) se precargan en segundo plano.

| Emoji | Archivo |
|---|---|
| 🎃 | `1f383.png` |
| 👻 | `1f47b.png` |
| 🍬 | `1f36c.png` |
| 👑 | `1f451.png` |
| 💀 | `1f480.png` |
| 💥 | `1f4a5.png` |
| ✨ | `2728.png` |
| 🦇 | `1f987.png` |

Los PNG de Apple **no se incluyen en el ZIP**: son material con derechos de Apple y no pude descargarlos desde donde preparé esta versión.
Se descargan al arrancar (≈100 KB en total, una sola vez) y se cachean. Si prefieres no depender de ningún CDN, copia tus PNG a `assets/emoji/`
o usa `XERION_EMOJI_SOURCE=off` (iconos vectoriales). Revisa la licencia de ese conjunto de imágenes antes de usarlo en un servicio público.

## Variables (todas opcionales)

| Variable | Valor por defecto | Efecto |
|---|---|---|
| `BLACKJACK_CANVAS` | `on` | `off` usa el tablero de texto (sin imagen) |
| `XERION_EMOJI_SOURCE` | `apple` | `off` no descarga nada (iconos vectoriales) |
| `XERION_EMOJI_BASE_URL` | jsDelivr `emoji-datasource-apple` (64 px) | otra fuente HTTPS de PNG con el mismo nombre de archivo |
| `XERION_EMOJI_CACHE_DIR` | directorio temporal del sistema | dónde se guardan los PNG descargados |

## Rendimiento y ancho de banda

Medido en el entorno donde preparé la versión (`npm run bench:canvas`; **no son mediciones de producción**):

| Métrica | Valor |
|---|---|
| Peso de cada imagen (PNG indexado de 256 colores) | ≈ 74 KB (69–81 KB); en color verdadero serían ≈ 250–270 KB |
| Tiempo por imagen con fondo, sprites y paleta ya calientes | ≈ 100 ms de media (55–170 ms) |
| Calentamiento único al arrancar | ≈ 1.2 s (en segundo plano) |
| Memoria extra | ≈ 40 MB (sprites de cartas y fondo) |

El dibujo y la paleta se cachean; los renders repetidos salen de una caché LRU de 24 imágenes; la compresión (`deflate`) corre en el pool de
hilos de libuv y no bloquea el event loop. Como las imágenes salen del servicio hacia Discord, cuentan como **ancho de banda de salida**:
`partidas al mes × imágenes por partida × 74 KB` (ejemplo: 1,000 partidas × 3 imágenes ≈ 217 MB).

## Fallos y robustez

- Si el render lanza un error o el estado es inválido, la mano **sigue con el tablero de texto** y se registra el error.
- Un render lento nunca pisa a uno más nuevo: cada jugada lleva un número de secuencia y las imágenes viejas se descartan.
- Los nombres de archivo de cada imagen son únicos (sin caché obsoleta del CDN de Discord) y al editar se reemplaza el adjunto anterior.
- Los PNG descargados se validan (firma, tamaño ≤ 200 KB, ≤ 256×256 px) y cualquier archivo dañado se descarta sin lanzar errores.

## Licencias

Las fuentes se incluyen como contornos extraídos (`assets/fonts/*.json`, generados con `tools/extract-glyphs.py`) de **Erica One** y
**Big Shoulders Display**, ambas bajo SIL Open Font License 1.1; los textos de licencia están en `assets/fonts/LICENSES/`.
