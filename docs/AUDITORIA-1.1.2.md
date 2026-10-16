# Revisión de Xerion 1.1.2

**Base:** Xerion 1.1.1, commit `eb337947b7418b26cb7f2c623b9586fcef6e4ea2`.

## Cambio limitado al texto del leaderboard

- Se conservan las menciones silenciosas para miembros que el servidor puede resolver.
- Para IDs sin miembro o nombre en caché/almacenamiento, se solicita el perfil de usuario de Discord para los 10
  resultados visibles como máximo. El nombre se muestra como texto para evitar la etiqueta `Unknown User` y no hacer ping.
- Si Discord no encuentra la cuenta, el fallback muestra `Usuario` y los últimos cuatro dígitos de la ID.
- No se cambia el orden, la paginación, la economía, los datos persistidos ni el esquema de la base de datos.

## Verificación

La suite de pruebas incluye nombres provenientes de caché, almacenamiento y API, errores al resolver una cuenta,
el límite de página y la política anti-ping. No se comprobó el bot contra un servidor de Discord real.
