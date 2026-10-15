# 🤝 Comercio entre jugadores — `xn give`

Vende o intercambia pociones, materiales y armas con otra persona. Quien recibe la oferta la **acepta o rechaza con botones**
(Components V2). Nada se mueve hasta que acepta, y todo se revalida en ese instante.

## Sintaxis

```
xn give @usuario <artículo> [cantidad|all] <precio total>
```

| Parte | Qué es |
|---|---|
| `@usuario` | Destinatario (mención). Debe ser una persona (no un bot) y distinta de ti. |
| `<artículo>` | ID o nombre del artículo, sin distinguir mayúsculas, acentos, espacios ni guiones bajos (`amber_dust`, `Amber Dust` y `amberdust` son lo mismo). Admite nombres de varias palabras. |
| `[cantidad\|all]` | Entero entre 1 y 1,000. Si lo omites es 1. `all` vende todo lo que tienes de ese artículo. Las armas siempre son 1. |
| `<precio total>` | Precio **total** de la oferta (no por unidad) en Candys. Acepta `5000`, `5k`, `1.5m`, `1,200`. Debe ser **al menos el 50% del valor base total** y como máximo 1,000,000,000,000. |

Alias: `xn sell`, `xn trade`.

### Ejemplos

```
xn give @Ana amber_dust 5 5000      → 5 Amber Dust por 5,000 en total (mínimo 4,000)
xn give @Ana Amber Dust all 9k      → todo tu Amber Dust por 9,000 (si el mínimo lo permite)
xn give @Ana luck 30000             → 1 Poción de Suerte por 30,000 (mínimo 22,500)
xn give @Ana rama 5000              → el arma Rama Afilada por 5,000 (mínimo 4,000)
```

## Reglas

- **Transferibles:** pociones guardadas, materiales y armas. **No transferibles:** efectos activos y los roles/beneficios de la
  Tienda del Evento (están ligados a la cuenta y al rol de Discord).
- **Precio mínimo:** `⌈valor base total × 0.5⌉`. Valor base: pociones y armas = su precio de tienda; materiales = tabla de abajo.
- **Una oferta pendiente por vendedor** y como máximo **3 ofertas recibidas** a la vez por persona.
- **Expira a los 2 minutos.** Solo el destinatario puede aceptar o rechazar; solo el vendedor puede cancelar.
- Se rechazan autoofertas, bots, cantidades o precios inválidos, artículos que no tienes, destinatarios sin Cash suficiente,
  armas que el destinatario ya tiene y números fuera del rango seguro.
- Solo se avisa (ping) al destinatario de la oferta; nadie más recibe notificaciones.
- Las armas vendidas se desequipan al vendedor; el comprador no recibe XP ni logros por comerciar.

## Seguridad del intercambio

Cada oferta es una máquina de estados: `pending → accepted | declined | cancelled | expired | failed`. Un estado final **nunca cambia**.

- **Sin escrow:** al crear la oferta no se mueve nada. Al aceptar se revalida *todo* (artículos del vendedor, Cash del comprador,
  límites numéricos) y recién entonces se mueven artículos y Candys en **un solo paso síncrono**, sin `await` intermedios.
- **Doble clic, clics simultáneos y eventos repetidos** no repiten el efecto: el segundo clic solo vuelve a dibujar el estado final.
- **Expiración:** el temporizador y cualquier clic tardío llegan al mismo resultado; una oferta vencida jamás se puede aceptar.
- Si el comprador no tiene Cash al aceptar, la oferta sigue abierta (puede retirar del Bank y reintentar). Si el vendedor ya no
  tiene los artículos, la oferta falla y no se mueve nada.
- Las ofertas viven en memoria: si el bot se reinicia no se pierde ni se duplica nada y los botones viejos responden "oferta no disponible".

## Valores base

Los materiales caen con la **misma probabilidad** entre sí (no cambié los drops), así que el valor base se fija por la
**rareza de uso**: `400 × 2^nivel`, donde el nivel sale de la receta de la Tienda del Evento más cara que usa ese material.
El precio mínimo de venta es la mitad.

| Nivel | Roles cuya receta lo usa | Valor base por unidad | Mínimo por unidad |
|---:|---|---:|---:|
| 0 | ninguna (sin receta) | 400 | 200 |
| 1 | STAR X | 800 | 400 |
| 2 | GOAT, AURA INFINITE | 1,600 | 800 |
| 3 | ARISE, KING | 3,200 | 1,600 |
| 4 | 3K, 9K | 6,400 | 3,200 |
| 5 | Spooky Season, OG | 12,800 | 6,400 |

### Materiales

| Material | ID | Nivel | Valor base | Mínimo |
|---|---|---:|---:|---:|
| 🦇 Bat Wing | `bat_wing` | 5 | 12,800 | 6,400 |
| 🥀 Black Rose | `black_rose` | 5 | 12,800 | 6,400 |
| 🔮 Cursed Rune | `cursed_rune` | 5 | 12,800 | 6,400 |
| 🌑 Dark Essence | `dark_essence` | 5 | 12,800 | 6,400 |
| 🪶 Phantom Feather | `phantom_feather` | 5 | 12,800 | 6,400 |
| 🪙 Silver Coin | `silver_coin` | 5 | 12,800 | 6,400 |
| 💎 Soul Crystal | `soul_crystal` | 5 | 12,800 | 6,400 |
| 🫧 Void Tear | `void_tear` | 5 | 12,800 | 6,400 |
| 🌫️ Cursed Ash | `cursed_ash` | 4 | 6,400 | 3,200 |
| 👹 Demon Horn | `demon_horn` | 4 | 6,400 | 3,200 |
| 🏮 Ghost Lantern | `ghost_lantern` | 4 | 6,400 | 3,200 |
| 🌙 Moon Shard | `moon_shard` | 4 | 6,400 | 3,200 |
| ⬛ Obsidian | `obsidian` | 4 | 6,400 | 3,200 |
| 🖋️ Spectral Ink | `spectral_ink` | 4 | 6,400 | 3,200 |
| 🐉 Wyvern Scale | `wyvern_scale` | 4 | 6,400 | 3,200 |
| 🦴 Bone Fragment | `bone_fragment` | 3 | 3,200 | 1,600 |
| 👻 Ectoplasm | `ectoplasm` | 3 | 3,200 | 1,600 |
| 🍃 Enchanted Leaf | `enchanted_leaf` | 3 | 3,200 | 1,600 |
| 🌿 Nightshade | `nightshade` | 3 | 3,200 | 1,600 |
| 🐦‍⬛ Raven Feather | `raven_feather` | 3 | 3,200 | 1,600 |
| 🪦 Tombstone Chip | `tombstone_chip` | 3 | 3,200 | 1,600 |
| 🎟️ Trick Token | `trick_token` | 3 | 3,200 | 1,600 |
| 🧛 Vampire Fang | `fang` | 3 | 3,200 | 1,600 |
| 🟠 Amber Dust | `amber_dust` | 2 | 1,600 | 800 |
| 🕯️ Candle Wax | `candle_wax` | 2 | 1,600 | 800 |
| 🪵 Charred Wood | `charred_wood` | 2 | 1,600 | 800 |
| 🧵 Haunted Thread | `haunted_thread` | 2 | 1,600 | 800 |
| 🥧 Pumpkin Spice | `pumpkin_spice` | 2 | 1,600 | 800 |
| 🕷️ Spider Silk | `spider_silk` | 2 | 1,600 | 800 |
| 🌱 Twilight Moss | `twilight_moss` | 2 | 1,600 | 800 |
| 🐺 Wolf Claw | `wolf_claw` | 2 | 1,600 | 800 |
| 🍬 Candy Corn | `candy_corn` | 1 | 800 | 400 |
| ⚰️ Grave Dirt | `grave_dirt` | 1 | 800 | 400 |
| 🎃 Pumpkin Seed | `pumpkin_seed` | 1 | 800 | 400 |
| 💀 Sugar Skull | `sugar_skull` | 1 | 800 | 400 |
| 🕸️ Cobweb Silk | `cobweb_silk` | 0 | 400 | 200 |
| 🧟 Rotten Flesh | `rotten_flesh` | 0 | 400 | 200 |
| ⭐ Star Fragment | `star_fragment` | 0 | 400 | 200 |
| 🧙 Witch Herb | `witch_herb` | 0 | 400 | 200 |

### Pociones (precio de tienda)

| Poción | ID | Valor base | Mínimo |
|---|---|---:|---:|
| 🍀 Poción de la Suerte Maldita | `luck` | 45,000 | 22,500 |
| 🕵️ Poción de las Sombras | `shadow` | 70,000 | 35,000 |
| 🧛 Elixir del Vampiro | `vampire` | 60,000 | 30,000 |
| 🕷️ Poción de la Codicia | `greed` | 100,000 | 50,000 |
| 👻 Susurro Fantasmal | `ghost` | 50,000 | 25,000 |
| 🎃 Calabaza Dorada | `pumpkin` | 90,000 | 45,000 |
| 💀 Huesos de la Suerte | `bones` | 55,000 | 27,500 |
| 🕸️ Poción de la Telaraña | `web` | 65,000 | 32,500 |
| ⚰️ Elixir de Resurrección | `revive` | 130,000 | 65,000 |

### Armas (precio de tienda)

| Arma | ID | Valor base | Mínimo |
|---|---|---:|---:|
| 🪵 Rama Afilada | `rama` | 8,000 | 4,000 |
| 🗡️ Daga de Plata | `daga` | 25,000 | 12,500 |
| ⚔️ Guadaña Maldita | `guadana` | 70,000 | 35,000 |
| 🪄 Vara de la Bruja | `vara` | 140,000 | 70,000 |
| 🏮 Farol del Sepulturero | `farol` | 220,000 | 110,000 |
| 🏹 Arco de Hueso | `arco` | 360,000 | 180,000 |
| 📕 Grimorio Carmesí | `grimorio` | 520,000 | 260,000 |
| 🛡️ Escudo de la Cripta | `escudo` | 780,000 | 390,000 |
| ⌛ Reloj de Medianoche | `reloj` | 1,150,000 | 575,000 |
| 🌙 Reliquia de la Luna | `reliquia` | 1,750,000 | 875,000 |

> Para cambiar un valor edita `MATERIAL_BASE_VALUES` (o `MATERIAL_BASE_UNIT`) en `config.js`; una prueba comprueba que la tabla siga la regla.
