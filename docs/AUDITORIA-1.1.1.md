# Revisión de Xerion 1.1.1

**Base revisada:** `main` en `8687aa42f47ffcee32d07adbad0d231a231f55ef` (Xerion 1.1.0).

## Cambio

El leaderboard imprimía `@nombre` como texto literal. Ahora convierte únicamente IDs con formato de snowflake de Discord
(17–20 dígitos) a `<@ID>`. Los registros históricos sin un ID válido siguen mostrándose como texto normal y escapado.

El payload conserva `allowedMentions: { parse: [] }` y `MessageFlags.SuppressNotifications`. Discord documenta que
Components V2 Text Display admite menciones y que `allowed_mentions` controla si una mención genera notificaciones.

## Verificación

- Regresión añadida para `<@ID>` en usuarios válidos, fallback de IDs inválidos, `allowedMentions` vacío y notificaciones suprimidas.
- `npm test`, comprobación sintáctica de JavaScript y paquete final revisados antes de entregar.
- No se modificaron base de datos, configuración de Render ni plan de facturación.
- No se probó el mensaje en un servidor de Discord real; el renderizado visual final depende del cliente de Discord.
